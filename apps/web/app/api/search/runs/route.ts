import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { reconcileManualJobSearch } from "@/lib/search/manual-search-service";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const [runs, sources, preferences, controls] = await Promise.all([
      supabase.from("job_search_runs").select("*").eq("user_id", profile.user_id).order("created_at", { ascending: false }).limit(20),
      supabase.from("job_search_sources").select("*").eq("user_id", profile.user_id).order("source_key"),
      supabase.from("candidate_preferences").select("preferences").eq("profile_id", profile.id).maybeSingle(),
      supabase.from("job_search_controls").select("search_schedule_enabled,search_schedule_timezone,search_schedule_time,next_scheduled_search_at,last_scheduled_search_at,last_scheduled_search_error").eq("user_id", profile.user_id).maybeSingle(),
    ]);
    const error = [runs, sources, preferences, controls].find((result) => result.error)?.error;
    if (error) throw error;
    const storedRuns = (runs.data || []) as Array<Record<string, any>>;
    const reconciledRuns = await Promise.all(storedRuns.map(async (run) => {
      if (!["manual", "scheduled"].includes(String(run.trigger)) || typeof run.dispatch_request_id !== "string") {
        // Old pre-bridge rows have no dispatch linkage and cannot make progress.
        // Report them as retired without rewriting the user's historical data.
        const age = Date.now() - Date.parse(String(run.created_at || run.requested_at || ""));
        if (!run.dispatch_request_id && ["queued", "running", "importing"].includes(String(run.state)) && Number.isFinite(age) && age > 45 * 60 * 1000) {
          return { ...run, state: "failed", error_json: { message: "This legacy search predates Website Bridge dispatch and cannot be resumed. Its history was retained." } };
        }
        return run;
      }
      try {
        const result = await reconcileManualJobSearch(supabase, profile.user_id, String(run.id));
        return result.ok ? result.run : { ...run, state: "failed", error_json: { message: result.error } };
      } catch (cause) {
        return { ...run, state: "importing", error_json: { message: cause instanceof Error ? cause.message : "The captured search result could not be reconciled yet." } };
      }
    }));
    const control = record(controls.data);
    const pref = record(preferences.data?.preferences);
    const schedule = {
      enabled: control.search_schedule_enabled === true,
      cadence: typeof pref.search_cadence === "string" ? pref.search_cadence : "manual",
      timezone: String(control.search_schedule_timezone || pref.search_timezone || "Europe/London"),
      localTime: String(control.search_schedule_time || pref.search_time_local || "09:00:00").slice(0, 5),
      nextRunAt: typeof control.next_scheduled_search_at === "string" ? control.next_scheduled_search_at : null,
      lastRunAt: typeof control.last_scheduled_search_at === "string" ? control.last_scheduled_search_at : null,
      lastError: typeof control.last_scheduled_search_error === "string" ? control.last_scheduled_search_error : null,
    };
    return NextResponse.json({ ok: true, runs: reconciledRuns, sources: sources.data || [], preferences: pref, schedule }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to load search history." }, { status: statusCode(error) });
  }
}

export async function POST(request: Request) {
  return NextResponse.json({ ok: false, error: "Use Search jobs now for an immediate Website Bridge search. Recurring searches are queued by the saved app schedule." }, { status: 410 });
}
