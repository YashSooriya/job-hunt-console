import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const { data, error } = await supabase
      .from("application_preparation_requests")
      .select("id,state,source,application_id,job_id,analysis_id,selected_cv_family,decision_json,created_at,updated_at,job:jobs(title,companies(canonical_name))")
      .eq("user_id", profile.user_id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return NextResponse.json({ ok: true, requests: data || [] });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to load preparation automation." }, { status: statusCode(error) });
  }
}
