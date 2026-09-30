import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { isUuid, validateIdempotencyKey, validateDispatchSubjectRefs } from "@/lib/chatgpt/dispatch-registry";
import { applyChatGptTestingMode, chatGptInstructionBodyLimit, readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";

const MAX_MESSAGE_CHARS = 6000;
const BLOCKED_PROTOCOL_TERMS = /(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)/i;

export async function POST(request: Request) {
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) throw new Error("A diagnostic message is required.");
    if (message.length > MAX_MESSAGE_CHARS) throw new Error(`Diagnostic messages must be ${MAX_MESSAGE_CHARS} characters or fewer.`);
    if (BLOCKED_PROTOCOL_TERMS.test(message)) throw new Error("Internal bridge protocol terms are not allowed in a diagnostic message.");

    const subjectRefs = validateDispatchSubjectRefs("bridge.diagnostic", {});
    const idempotencyKey = validateIdempotencyKey(body?.idempotencyKey) || `bridge.diagnostic.message:${crypto.randomUUID()}`;
    const { supabase, profile } = await requireProfile();
    const testingModeEnabled = await readChatGptTestingMode(supabase, profile.user_id);
    if (message.length > chatGptInstructionBodyLimit(testingModeEnabled)) {
      throw new Error(`Diagnostic messages must be ${chatGptInstructionBodyLimit(testingModeEnabled).toLocaleString()} characters or fewer while preserving the testing-mode warning.`);
    }
    const instruction = applyChatGptTestingMode(message, testingModeEnabled);
    operationId = await beginChatGptOperation(supabase, "Bridge diagnostic message");
    const { data, error } = await supabase.rpc("create_chatgpt_dispatch_request_with_website_instruction", {
      p_action_type: "bridge.diagnostic",
      p_subject_refs: subjectRefs,
      p_origin: "user_click",
      p_display_title: "Bridge diagnostic message",
      p_idempotency_key: idempotencyKey,
      p_priority: 90,
      p_website_instruction: instruction,
    });
    if (error) throw error;

    const dispatch = data as Record<string, unknown>;
    const requestId = String(dispatch.id || "");
    if (!isUuid(requestId)) throw new Error("The diagnostic service did not return a valid request id.");
    await trackChatGptOperation(supabase, operationId, [requestId]);
    operationTracked = true;
    return NextResponse.json({
      ok: true,
      dispatch,
      website_instruction: typeof dispatch.website_instruction === "string" ? dispatch.website_instruction : instruction,
      bridge_hint: {
        version: 1,
        type: "JOBHUNT_DISPATCH_HINT",
        request_id: requestId,
        correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : requestId,
        nonce: crypto.randomUUID(),
      },
    }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to send the diagnostic message." }, { status: statusCode(error) });
  } finally {
    if (operationId && !operationTracked) {
      try { const { createClient } = await import("@/lib/supabase/server"); await releaseChatGptOperation(await createClient(), operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}
