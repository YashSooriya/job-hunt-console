import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

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
  try {
    const body = await request.json();
    const { supabase, profile } = await requireProfile();
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
    const applicationAutomationPreference = typeof body.applicationAutomationPreference === "string"
      && ["prepare_only", "prepare_and_fill_after_gate1", "manual"].includes(body.applicationAutomationPreference)
      ? body.applicationAutomationPreference
      : "prepare_and_fill_after_gate1";
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
      max_commute_minutes: numberOrNull(body.maxCommuteMinutes),
      work_modes: workModes,
      salary: { minimum: salaryMinimum, target: salaryTarget, currency: salaryCurrency },
      sponsorship_required: body.sponsorshipRequired === true,
      posting_age_policy: { max_days: postingAgeDays, strongest_days: 7, worthwhile_days: 14, selective_days: 30 },
      min_fit_threshold: minFitThreshold,
      min_fit_score_10: minFitScore10,
      auto_prepare_threshold: autoPrepareThreshold,
      search_cadence: searchCadence,
      application_automation_preference: applicationAutomationPreference,
      notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 5000) : "",
    };

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
      "auto_prepare_threshold", "search_cadence", "application_automation_preference", "notes",
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
    const { error } = await supabase.from("candidate_preferences").upsert(
      { profile_id: profile.id, preferences, updated_at: new Date().toISOString() },
      { onConflict: "profile_id" },
    );
    if (error) throw error;
    return NextResponse.json({ ok: true, preferences });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to save preferences." },
      { status: statusCode(error) },
    );
  }
}
