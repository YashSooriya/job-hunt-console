import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { isUuid } from "@/lib/chatgpt/dispatch-registry";
import { lifecyclePayload } from "@/lib/chatgpt-bridge/lifecycle";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!isUuid(body?.requestId)) throw new Error("A valid dispatch request id is required.");
    const lifecycle = lifecyclePayload(body?.lifecycle);
    if (!lifecycle) throw new Error("A bounded bridge lifecycle update is required.");
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("record_chatgpt_dispatch_lifecycle", {
      p_request_id: body.requestId,
      p_lifecycle: lifecycle,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, dispatch: data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to record bridge lifecycle." }, { status: statusCode(error) });
  }
}
