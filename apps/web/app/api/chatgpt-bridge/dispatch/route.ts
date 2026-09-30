import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import {
  getDispatchDescriptor,
  isUuid,
  validateDispatchSubjectRefs,
  validateIdempotencyKey,
  type DispatchActionType,
} from "@/lib/chatgpt/dispatch-registry";
import { prepareChatGptInstruction } from "@/lib/chatgpt/testing-mode";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";

export async function POST(request: Request) {
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = await request.json().catch(() => ({}));
    const actionType = typeof body?.actionType === "string" ? body.actionType : "";
    if (actionType === "jobs.search.manual") {
      throw new Error("Manual job searches must use the rate-limited Search jobs now action.");
    }
    const descriptor = getDispatchDescriptor(actionType);
    const subjectRefs = validateDispatchSubjectRefs(actionType as DispatchActionType, body?.subjectRefs ?? {});
    const origin = body?.origin === "explicit_automation" ? "explicit_automation" : "user_click";
    const displayTitle = typeof body?.displayTitle === "string" ? body.displayTitle.trim().slice(0, 160) : descriptor.displayTitle;
    const idempotencyKey = validateIdempotencyKey(body?.idempotencyKey);
    // The action handler owns the user-facing task wording. This route only
    // validates/routes it; it must not manufacture a second integration path.
    const websiteInstruction = typeof body?.websiteInstruction === "string" ? body.websiteInstruction.trim() : "";
    if (!websiteInstruction) throw new Error("A plain-language Website Bridge task is required.");
    const { supabase, profile } = await requireProfile();
    const prepared = await prepareChatGptInstruction(supabase, profile.user_id, websiteInstruction);
    operationId = await beginChatGptOperation(supabase, displayTitle || descriptor.displayTitle);
    const { data, error } = await supabase.rpc("create_chatgpt_dispatch_request_with_website_instruction", {
      p_action_type: actionType,
      p_subject_refs: subjectRefs,
      p_origin: origin,
      p_display_title: displayTitle || descriptor.displayTitle,
      p_idempotency_key: idempotencyKey || null,
      p_priority: typeof body?.priority === "number" ? Math.max(0, Math.min(100, Math.trunc(body.priority))) : 50,
      p_website_instruction: prepared.instruction,
    });
    if (error) throw error;
    const dispatch = data as Record<string, unknown>;
    const requestId = String(dispatch.id || "");
    if (!isUuid(requestId)) throw new Error("The dispatch service did not return a valid request id.");
    await trackChatGptOperation(supabase, operationId, [requestId]);
    operationTracked = true;
    return NextResponse.json({
      ok: true,
      dispatch,
      website_instruction: typeof dispatch.website_instruction === "string" ? dispatch.website_instruction : typeof dispatch.manual_instruction === "string" ? dispatch.manual_instruction : undefined,
      manual_instruction: typeof dispatch.manual_instruction === "string" ? dispatch.manual_instruction : undefined,
      bridge_hint: {
        version: 1,
        type: "JOBHUNT_DISPATCH_HINT",
        request_id: requestId,
        correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : requestId,
        nonce: crypto.randomUUID(),
      },
    }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to create the ChatGPT dispatch." }, { status: statusCode(error) });
  } finally {
    if (operationId && !operationTracked) {
      try { const { createClient } = await import("@/lib/supabase/server"); await releaseChatGptOperation(await createClient(), operationId); } catch { /* an untracked active dispatch is still discovered from server state */ }
    }
  }
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: "A valid dispatch request id is required." }, { status: 400 });
    const { supabase } = await requireProfile();
    const [{ data, error }, { data: lifecycleData, error: lifecycleError }] = await Promise.all([
      supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: id }),
      supabase.rpc("get_chatgpt_dispatch_lifecycle", { p_request_id: id }),
    ]);
    if (error) throw error;
    if (lifecycleError) throw lifecycleError;
    const dispatch = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const lifecycle = lifecycleData && typeof lifecycleData === "object" && !Array.isArray(lifecycleData)
      ? (lifecycleData as Record<string, unknown>).lifecycle
      : {};
    delete dispatch.mcp_fallback_instruction;
    delete dispatch.required_mcp_tools;
    return NextResponse.json({ ok: true, dispatch: { ...dispatch, lifecycle } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to read the ChatGPT dispatch." }, { status: statusCode(error) });
  }
}
