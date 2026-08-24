import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function POST() {
  try {
    const { supabase } = await requireProfile();
    const key = `diagnostic:${crypto.randomUUID()}`;
    const { data, error } = await supabase.rpc("create_chatgpt_dispatch_request", {
      p_action_type: "bridge.diagnostic",
      p_subject_refs: {},
      p_origin: "diagnostic",
      p_display_title: "Job Hunt bridge diagnostic",
      p_idempotency_key: key,
      p_priority: 90,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, dispatch: data, diagnostic: true, bridge_hint: { version: 1, type: "JOBHUNT_DISPATCH_HINT", request_id: data?.id, correlation_id: data?.correlation_id || data?.id, nonce: crypto.randomUUID() } }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to queue the bridge diagnostic." }, { status: statusCode(error) });
  }
}
