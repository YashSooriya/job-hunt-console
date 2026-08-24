import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { isUuid } from "@/lib/chatgpt/dispatch-registry";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!isUuid(body?.requestId)) return NextResponse.json({ ok: false, error: "A valid dispatch request id is required." }, { status: 400 });
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("retry_chatgpt_dispatch_request", { p_request_id: body.requestId });
    if (error) throw error;
    const dispatch = data as Record<string, unknown>;
    return NextResponse.json({ ok: true, dispatch, bridge_hint: { version: 1, type: "JOBHUNT_DISPATCH_HINT", request_id: body.requestId, correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : body.requestId, nonce: crypto.randomUUID() } }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to retry the ChatGPT dispatch." }, { status: statusCode(error) });
  }
}
