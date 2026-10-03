import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { buildJobSearchConfigurationPrompt } from "@/lib/search/job-search-prompt";
import { applyChatGptTestingMode, chatGptInstructionBodyLimit, readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";
import { currentJobPoolSheetSnapshot, syncJobPoolSheetForCurrentUser } from "@/lib/google-job-pool-sheet";

function list(value: unknown, max: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, max)
    : [];
}

function numberOrNull(value: unknown) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Numeric preferences must be zero or greater.");
  return parsed;
}

function boundedNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(0, parsed)) : fallback;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function preferenceValue(preferences: Record<string, any>, field: string) {
  if (field === "salary_minimum") return preferences.salary?.minimum ?? preferences.salary_minimum ?? null;
  if (field === "salary_target") return preferences.salary?.target ?? preferences.salary_target ?? null;
  if (field === "salary_currency") return preferences.salary?.currency ?? preferences.salary_currency ?? null;
  if (field === "posting_age_days") return preferences.posting_age_policy?.max_days ?? preferences.posting_age_days ?? null;
  return preferences[field] ?? null;
}

function valueChanged(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function hasPreferenceValue(value: unknown) {
  return value !== null && value !== undefined && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

export async function POST(request: Request) {
  let operationClient: any = null;
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = await request.json();
    const { supabase, profile } = await requireProfile();
    operationClient = supabase;
    const { data: existingRow, error: existingError } = await supabase
      .from("candidate_preferences")
      .select("preferences")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (existingError) throw existingError;
    const existingPreferences = record(existingRow?.preferences);
    const locations = list(body.locations, 20);
    const targetRoles = list(body.targetRoles, 30);
    const roleFamilies = list(body.roleFamilies, 20);
    const searchMode = typeof body.searchMode === "string" && ["keywords", "profile", "keywords_and_profile"].includes(body.searchMode)
      ? body.searchMode
      : "keywords_and_profile";
    const workModes = list(body.workModes, 3).filter((mode) => ["onsite", "hybrid", "remote"].includes(mode));
    const targetSeniority = typeof body.targetSeniority === "string" ? body.targetSeniority.trim().slice(0, 100) : "";
    const postingAgeDays = Math.min(90, Math.max(1, Number(body.postingAgeDays || 30)));
    const legacyFitThreshold = body.minFitThreshold === undefined ? null : Number(body.minFitThreshold);
    const minFitScore10 = boundedNumber(body.minFitScore10 ?? (legacyFitThreshold !== null && Number.isFinite(legacyFitThreshold) ? legacyFitThreshold / 10 : 6), 6, 10);
    const minFitThreshold = Math.round(minFitScore10 * 10);
    const autoPrepareThreshold = Math.min(100, Math.max(0, Number(body.autoPrepareThreshold ?? 80)));
    const searchCadence = typeof body.searchCadence === "string" && ["daily", "weekdays", "weekly", "manual"].includes(body.searchCadence)
      ? body.searchCadence
      : "daily";
    const searchTimezone = typeof body.searchTimezone === "string" && body.searchTimezone.trim()
      ? body.searchTimezone.trim().slice(0, 80)
      : String(existingPreferences.search_timezone || "Europe/London").slice(0, 80);
    const searchTimeLocal = typeof body.searchTimeLocal === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.searchTimeLocal)
      ? body.searchTimeLocal
      : String(existingPreferences.search_time_local || "09:00");
    if (typeof body.searchTimeLocal === "string" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.searchTimeLocal)) {
      throw new Error("Choose a valid local search time.");
    }
    const scheduleEnabled = searchCadence !== "manual" && (typeof body.scheduleEnabled === "boolean"
      ? body.scheduleEnabled
      : existingPreferences.search_schedule_enabled === true);
    if (!locations.length || !workModes.length || (searchMode !== "profile" && (!targetRoles.length || !roleFamilies.length || !targetSeniority))) {
      throw new Error(searchMode === "profile"
        ? "Add at least one location and work mode for profile-led discovery."
        : "Add at least one role, role family, location, work mode and target seniority.");
    }
    const salaryMinimum = numberOrNull(body.salaryMinimum);
    const salaryTarget = numberOrNull(body.salaryTarget);
    if (salaryMinimum !== null && salaryTarget !== null && salaryTarget < salaryMinimum) throw new Error("Target salary cannot be below the salary floor.");

    const salaryCurrency = typeof body.salaryCurrency === "string" && body.salaryCurrency.trim()
      ? body.salaryCurrency.trim().toUpperCase().slice(0, 10)
      : String(existingPreferences.salary?.currency || "GBP").trim().toUpperCase().slice(0, 10) || "GBP";

    const preferences: Record<string, any> = {
      target_roles: targetRoles,
      role_families: roleFamilies,
      target_seniority: targetSeniority,
      search_mode: searchMode,
      preferred_industries: list(body.preferredIndustries, 30),
      excluded_industries: list(body.excludedIndustries, 30),
      locations,
      max_commute_minutes: null,
      work_modes: workModes,
      salary: { minimum: salaryMinimum, target: salaryTarget, currency: salaryCurrency },
      sponsorship_required: body.sponsorshipRequired === true,
      posting_age_policy: { max_days: postingAgeDays, strongest_days: 7, worthwhile_days: 14, selective_days: 30 },
      min_fit_threshold: minFitThreshold,
      min_fit_score_10: minFitScore10,
      auto_prepare_threshold: autoPrepareThreshold,
      search_cadence: searchCadence,
      search_timezone: searchTimezone,
      search_time_local: searchTimeLocal,
      search_schedule_enabled: scheduleEnabled,
      notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 5000) : "",
    };
    // These controls are intentionally not part of the current Jobs form.
    // Keep a legacy application-automation value intact for older workflows,
    // but never recreate the removed control's default during a Jobs save.
    if (Object.prototype.hasOwnProperty.call(existingPreferences, "application_automation_preference")) {
      preferences.application_automation_preference = existingPreferences.application_automation_preference;
    }

    // Keep provenance in the JSON rather than asking the user to confirm a
    // second review list. Imported values remain marked as ChatGPT-owned when
    // the user saves them unchanged; changed values become user-confirmed and
    // are the only preference values eligible for the later Memory update.
    const importedFields = new Set(
      Array.isArray(existingPreferences._chatgpt_memory_fields)
        ? existingPreferences._chatgpt_memory_fields.filter((field: unknown): field is string => typeof field === "string")
        : [],
    );
    const userFields = new Set(
      Array.isArray(existingPreferences._user_confirmed_fields)
        ? existingPreferences._user_confirmed_fields.filter((field: unknown): field is string => typeof field === "string")
        : [],
    );
    const trackedFields = [
      "search_mode", "target_roles", "role_families", "target_seniority", "preferred_industries",
      "excluded_industries", "locations", "work_modes", "max_commute_minutes", "posting_age_days",
      "salary_minimum", "salary_target", "salary_currency", "sponsorship_required", "min_fit_score_10",
      "auto_prepare_threshold", "search_cadence", "search_timezone", "search_time_local", "search_schedule_enabled", "application_automation_preference", "notes",
    ];
    for (const field of trackedFields) {
      const oldValue = preferenceValue(existingPreferences, field);
      const newValue = preferenceValue(preferences, field);
      const changed = valueChanged(oldValue, newValue);
      if (importedFields.has(field) && !changed) continue;
      importedFields.delete(field);
      if (hasPreferenceValue(newValue) && (changed || !importedFields.has(field))) userFields.add(field);
    }
    if (importedFields.size) preferences._chatgpt_memory_fields = [...importedFields];
    else delete preferences._chatgpt_memory_fields;
    if (userFields.size) preferences._user_confirmed_fields = [...userFields];
    else delete preferences._user_confirmed_fields;
    const { data: schedule, error: saveError } = await supabase.rpc("save_job_search_preferences", {
      p_profile_id: profile.id,
      p_preferences: preferences,
      p_schedule_enabled: scheduleEnabled,
      p_timezone: searchTimezone,
      p_local_time: searchTimeLocal,
    });
    if (saveError) throw saveError;
    if (body.dispatchSetup === true) {
      const idempotencyKey = typeof body.dispatchIdempotencyKey === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(body.dispatchIdempotencyKey)
        ? body.dispatchIdempotencyKey
        : `jobs.search.configure:${crypto.randomUUID()}`;
      const testingModeEnabled = await readChatGptTestingMode(supabase, profile.user_id);
      try {
        const { data: sourceRows, error: sourcesError } = await supabase.from("job_search_sources")
          .select("label").eq("user_id", profile.user_id).eq("enabled", true).order("source_key");
        if (sourcesError) throw sourcesError;
        await syncJobPoolSheetForCurrentUser(supabase, profile.user_id);
        const pool = await currentJobPoolSheetSnapshot(supabase, profile.user_id);
        const sourceLabels = (sourceRows || []).map((source: Record<string, unknown>) => String(source.label || "")).filter(Boolean);
        const instruction = applyChatGptTestingMode(
          buildJobSearchConfigurationPrompt(preferences, chatGptInstructionBodyLimit(testingModeEnabled), sourceLabels, {
            publicationId: pool.publicationId,
            revision: pool.revision,
            rowCount: pool.rowCount,
            dataUrl: pool.dataUrl,
            dataSheetTitle: pool.dataSheetTitle,
            manifestUrl: pool.manifestUrl,
            manifestSheetTitle: pool.manifestSheetTitle,
          }),
          testingModeEnabled,
        );
        operationId = await beginChatGptOperation(supabase, "Confirm job-search setup");
        const { data: dispatch, error: dispatchError } = await supabase.rpc("create_chatgpt_dispatch_request_with_website_instruction", {
          p_action_type: "jobs.search.manual",
          p_subject_refs: {},
          p_origin: "explicit_automation",
          p_display_title: "Confirm job-search setup",
          p_idempotency_key: idempotencyKey,
          p_priority: 70,
          p_website_instruction: instruction,
        });
        if (dispatchError) throw dispatchError;
        const requestId = dispatch && typeof dispatch === "object" && !Array.isArray(dispatch) ? String((dispatch as Record<string, unknown>).id || "") : "";
        if (!requestId) throw new Error("The job-search setup did not return a dispatch request id.");
        await trackChatGptOperation(supabase, operationId, [requestId]);
        operationTracked = true;
        return NextResponse.json({
          ok: true,
          preferences,
          schedule,
          dispatch,
          bridge_hint: requestId ? {
            version: 1,
            type: "JOBHUNT_DISPATCH_HINT",
            request_id: requestId,
            correlation_id: dispatch && typeof dispatch === "object" && !Array.isArray(dispatch) && typeof (dispatch as Record<string, unknown>).correlation_id === "string" ? (dispatch as Record<string, unknown>).correlation_id : requestId,
            nonce: crypto.randomUUID(),
          } : undefined,
        });
      } catch (setupError) {
        return NextResponse.json({
          ok: true,
          preferences,
          schedule,
          setupError: setupError instanceof Error ? setupError.message : "Preferences were saved, but ChatGPT setup could not be queued. Save again to retry.",
        });
      }
    }
    return NextResponse.json({ ok: true, preferences, schedule });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to save preferences." },
      { status: statusCode(error) },
    );
  } finally {
    if (operationClient && operationId && !operationTracked) {
      try { await releaseChatGptOperation(operationClient, operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}
