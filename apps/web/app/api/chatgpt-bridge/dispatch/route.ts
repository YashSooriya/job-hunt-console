import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import {
  buildDispatchInstruction,
  getDispatchDescriptor,
  isUuid,
  validateDispatchSubjectRefs,
  validateIdempotencyKey,
  type DispatchActionType,
} from "@/lib/chatgpt/dispatch-registry";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const actionType = typeof body?.actionType === "string" ? body.actionType : "";
    const descriptor = getDispatchDescriptor(actionType);
    const subjectRefs = validateDispatchSubjectRefs(actionType as DispatchActionType, body?.subjectRefs ?? {});
    const origin = body?.origin === "explicit_automation" ? "explicit_automation" : "user_click";
    const displayTitle = typeof body?.displayTitle === "string" ? body.displayTitle.trim().slice(0, 160) : descriptor.displayTitle;
    const idempotencyKey = validateIdempotencyKey(body?.idempotencyKey);
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("create_chatgpt_dispatch_request", {
      p_action_type: actionType,
      p_subject_refs: subjectRefs,
      p_origin: origin,
      p_display_title: displayTitle || descriptor.displayTitle,
      p_idempotency_key: idempotencyKey || null,
      p_priority: typeof body?.priority === "number" ? Math.max(0, Math.min(100, Math.trunc(body.priority))) : 50,
    });
    if (error) throw error;
    const dispatch = data as Record<string, unknown>;
    const requestId = String(dispatch.id || "");
    if (!isUuid(requestId)) throw new Error("The dispatch service did not return a valid request id.");
    return NextResponse.json({
      ok: true,
      dispatch,
      manual_instruction: typeof dispatch.manual_instruction === "string" ? dispatch.manual_instruction : buildDispatchInstruction(requestId),
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
  }
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: "A valid dispatch request id is required." }, { status: 400 });
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: id });
    if (error) throw error;
    return NextResponse.json({ ok: true, dispatch: data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to read the ChatGPT dispatch." }, { status: statusCode(error) });
  }
}
