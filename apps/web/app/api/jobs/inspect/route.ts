import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { normalizeJobListingUrl } from "@/lib/job-url-inspection";

function validUuid(value: string | null) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

async function authenticatedClient() {
  if (!isSupabaseConfigured() || getDataMode() === "local") throw new Error("LIVE_INSPECTION_REQUIRES_SUPABASE");
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  return { supabase, user: data.user };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sourceUrl = normalizeJobListingUrl(body?.sourceUrl);
    const { supabase, user } = await authenticatedClient();
    const { data, error } = await supabase
      .from("job_url_inspection_requests")
      .insert({ user_id: user.id, source_url: sourceUrl })
      .select("id,source_url,status,attempt_count,created_at,updated_at")
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, requestId: data.id, inspection: data }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to queue the job listing URL.";
    if (message === "AUTH_REQUIRED") return NextResponse.json({ ok: false, error: "Sign in with an active Job Hunt Console membership before importing a live listing." }, { status: 401 });
    if (message === "LIVE_INSPECTION_REQUIRES_SUPABASE") return NextResponse.json({ ok: false, error: "Live ChatGPT URL inspection is available after the hosted Supabase connection is enabled." }, { status: 503 });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function GET(request: Request) {
  try {
    const requestId = new URL(request.url).searchParams.get("id");
    if (!validUuid(requestId)) return NextResponse.json({ ok: false, error: "A valid inspection id is required." }, { status: 400 });
    const { supabase, user } = await authenticatedClient();
    const { data, error } = await supabase
      .from("job_url_inspection_requests")
      .select("id,source_url,status,attempt_count,error_json,job_id,completed_at,created_at,updated_at")
      .eq("id", requestId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ ok: false, error: "Inspection request not found." }, { status: 404 });
    return NextResponse.json({ ok: true, inspection: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read the job listing inspection.";
    if (message === "AUTH_REQUIRED") return NextResponse.json({ ok: false, error: "Sign in with an active Job Hunt Console membership before viewing an inspection." }, { status: 401 });
    if (message === "LIVE_INSPECTION_REQUIRES_SUPABASE") return NextResponse.json({ ok: false, error: "Live ChatGPT URL inspection is available after the hosted Supabase connection is enabled." }, { status: 503 });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
