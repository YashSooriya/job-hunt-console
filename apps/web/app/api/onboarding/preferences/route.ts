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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { supabase, profile } = await requireProfile();
    const locations = list(body.locations, 20);
    const targetRoles = list(body.targetRoles, 30);
    const roleFamilies = list(body.roleFamilies, 20);
    const workModes = list(body.workModes, 3).filter((mode) => ["onsite", "hybrid", "remote"].includes(mode));
    const targetSeniority = typeof body.targetSeniority === "string" ? body.targetSeniority.trim().slice(0, 100) : "";
    const postingAgeDays = Math.min(90, Math.max(1, Number(body.postingAgeDays || 30)));
    const minFitThreshold = Math.min(100, Math.max(0, Number(body.minFitThreshold ?? 60)));
    const autoPrepareThreshold = Math.min(100, Math.max(0, Number(body.autoPrepareThreshold ?? 80)));
    const searchCadence = typeof body.searchCadence === "string" && ["daily", "weekdays", "weekly", "manual"].includes(body.searchCadence)
      ? body.searchCadence
      : "daily";
    const applicationAutomationPreference = typeof body.applicationAutomationPreference === "string"
      && ["prepare_only", "prepare_and_fill_after_gate1", "manual"].includes(body.applicationAutomationPreference)
      ? body.applicationAutomationPreference
      : "prepare_and_fill_after_gate1";
    if (!locations.length || !targetRoles.length || !roleFamilies.length || !targetSeniority || !workModes.length) {
      throw new Error("Add at least one role, role family, location, work mode and target seniority.");
    }
    const salaryMinimum = numberOrNull(body.salaryMinimum);
    const salaryTarget = numberOrNull(body.salaryTarget);
    if (salaryMinimum !== null && salaryTarget !== null && salaryTarget < salaryMinimum) throw new Error("Target salary cannot be below the salary floor.");

    const preferences = {
      target_roles: targetRoles,
      role_families: roleFamilies,
      target_seniority: targetSeniority,
      preferred_industries: list(body.preferredIndustries, 30),
      excluded_industries: list(body.excludedIndustries, 30),
      locations,
      max_commute_minutes: numberOrNull(body.maxCommuteMinutes),
      work_modes: workModes,
      salary: { minimum: salaryMinimum, target: salaryTarget, currency: "GBP" },
      sponsorship_required: body.sponsorshipRequired === true,
      posting_age_policy: { max_days: postingAgeDays, strongest_days: 7, worthwhile_days: 14, selective_days: 30 },
      min_fit_threshold: minFitThreshold,
      auto_prepare_threshold: autoPrepareThreshold,
      search_cadence: searchCadence,
      application_automation_preference: applicationAutomationPreference,
      notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 5000) : "",
    };
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
