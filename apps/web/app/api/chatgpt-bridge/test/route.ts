import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { validateIdempotencyKey } from "@/lib/chatgpt/dispatch-registry";
import { prepareChatGptInstruction, requireChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";

export async function POST(request: Request) {
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = await request.json().catch(() => ({}));
    const idempotencyKey = validateIdempotencyKey(body?.idempotencyKey);
    if (!idempotencyKey) throw new Error("A diagnostic retry key is required. Refresh Diagnostics and retry the same action.");
    const { supabase, profile } = await requireProfile();
    const prepared = await prepareChatGptInstruction(supabase, profile.user_id, "Run a harmless bridge diagnostic and reply exactly: Bridge diagnostic passed.");
    requireChatGptTestingMode(prepared.testingModeEnabled);
    operationId = await beginChatGptOperation(supabase, "Bridge diagnostic");
    const { data, error } = await supabase.rpc("create_chatgpt_dispatch_request_with_website_instruction", {
      p_action_type: "bridge.diagnostic",
      p_subject_refs: {},
      p_origin: "diagnostic",
      p_display_title: "Bridge diagnostic",
      p_idempotency_key: idempotencyKey,
      p_priority: 90,
      p_website_instruction: prepared.instruction,
    });
    if (error) throw error;
    const requestId = typeof data?.id === "string" ? data.id : "";
    if (!requestId) throw new Error("The diagnostic service did not return a dispatch request id.");
    await trackChatGptOperation(supabase, operationId, [requestId]);
    operationTracked = true;
    return NextResponse.json({ ok: true, dispatch: data, diagnostic: true, bridge_hint: { version: 1, type: "JOBHUNT_DISPATCH_HINT", request_id: data?.id, correlation_id: data?.correlation_id || data?.id, nonce: crypto.randomUUID() } }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to queue the bridge diagnostic." }, { status: statusCode(error) });
  } finally {
    if (operationId && !operationTracked) {
      try { const { createClient } = await import("@/lib/supabase/server"); await releaseChatGptOperation(await createClient(), operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}
