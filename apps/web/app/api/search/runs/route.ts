import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const [runs, sources, preferences] = await Promise.all([
      supabase.from("job_search_runs").select("*").eq("user_id", profile.user_id).order("created_at", { ascending: false }).limit(20),
      supabase.from("job_search_sources").select("*").eq("user_id", profile.user_id).order("source_key"),
      supabase.from("candidate_preferences").select("preferences").eq("profile_id", profile.id).maybeSingle(),
    ]);
    const error = [runs, sources, preferences].find((result) => result.error)?.error;
    if (error) throw error;
    return NextResponse.json({ ok: true, runs: runs.data || [], sources: sources.data || [], preferences: preferences.data?.preferences || {} });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to load search history." }, { status: statusCode(error) });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { supabase } = await requireProfile();
    const trigger = body?.trigger === "scheduled" ? "scheduled" : "manual";
    const { data, error } = await supabase.rpc("enqueue_job_search_run", { p_trigger: trigger });
    if (error) throw error;
    return NextResponse.json({ ok: true, run: data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to queue a search run." }, { status: statusCode(error) });
  }
}
