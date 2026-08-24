import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import {
  directOpenAiInspectionConfigured,
  publicInspection,
  reconcileImmediateOpenAiInspection,
  startImmediateOpenAiInspection,
  type DirectInspectionRecord,
} from "@/lib/direct-job-inspection";
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

const INSPECTION_SELECT = "id,source_url,status,attempt_count,error_json,job_id,provider,provider_response_id,completed_at,created_at,updated_at";

async function readInspection(supabase: any, requestId: string, userId: string) {
  const { data, error } = await supabase
    .from("job_url_inspection_requests")
    .select(INSPECTION_SELECT)
    .eq("id", requestId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as DirectInspectionRecord | null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sourceUrl = normalizeJobListingUrl(body?.sourceUrl);
    const { supabase, user } = await authenticatedClient();
    const { data, error } = await supabase
      .from("job_url_inspection_requests")
      .insert({ user_id: user.id, source_url: sourceUrl })
      .select(INSPECTION_SELECT)
      .single();
    if (error) throw error;
    if (directOpenAiInspectionConfigured()) {
      try {
        await startImmediateOpenAiInspection(supabase, data.id, data.source_url);
        const started = await readInspection(supabase, data.id, user.id);
        return NextResponse.json({ ok: true, requestId: data.id, execution: "openai_responses", inspection: started ? publicInspection(started) : publicInspection({ ...data, status: "processing" }) }, { status: 202 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to start the immediate OpenAI inspection.";
        return NextResponse.json({ ok: false, error: message }, { status: 502 });
      }
    }
    const { data: dispatch, error: dispatchError } = await supabase.rpc("create_chatgpt_dispatch_request", {
      p_action_type: "job.inspect_url",
      p_subject_refs: { inspection_id: data.id },
      p_origin: "user_click",
      p_display_title: "Inspect a job listing",
      p_idempotency_key: `job.inspect_url:${data.id}`,
      p_priority: 70,
    });
    if (dispatchError) throw dispatchError;
    return NextResponse.json({
      ok: true,
      requestId: data.id,
      execution: "chatgpt_browser_bridge",
      inspection: publicInspection(data),
      dispatch,
      bridge_hint: {
        version: 1,
        type: "JOBHUNT_DISPATCH_HINT",
        request_id: dispatch.id,
        correlation_id: dispatch.correlation_id || dispatch.id,
        nonce: crypto.randomUUID(),
      },
    }, { status: 202 });
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
    if (!requestId || !validUuid(requestId)) return NextResponse.json({ ok: false, error: "A valid inspection id is required." }, { status: 400 });
    const { supabase, user } = await authenticatedClient();
    let data = await readInspection(supabase, requestId, user.id);
    if (!data) return NextResponse.json({ ok: false, error: "Inspection request not found." }, { status: 404 });
    if (data.status === "processing" && data.provider === "openai_responses" && data.provider_response_id) {
      await reconcileImmediateOpenAiInspection(supabase, data);
      data = await readInspection(supabase, requestId, user.id);
      if (!data) return NextResponse.json({ ok: false, error: "Inspection request not found after processing." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, inspection: publicInspection(data) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read the job listing inspection.";
    if (message === "AUTH_REQUIRED") return NextResponse.json({ ok: false, error: "Sign in with an active Job Hunt Console membership before viewing an inspection." }, { status: 401 });
    if (message === "LIVE_INSPECTION_REQUIRES_SUPABASE") return NextResponse.json({ ok: false, error: "Live ChatGPT URL inspection is available after the hosted Supabase connection is enabled." }, { status: 503 });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
