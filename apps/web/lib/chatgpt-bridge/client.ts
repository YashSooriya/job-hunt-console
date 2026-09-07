import { notifyBridgeHint } from "./notify";
import { dispatchStateLabel as labelDispatchState } from "./dispatch-state";

export type BridgeHint = {
  version: 1;
  type: "JOBHUNT_DISPATCH_HINT";
  request_id: string;
  correlation_id: string;
  nonce: string;
  emitted_at?: string;
};

export type DispatchApiResult = {
  ok: boolean;
  dispatch?: Record<string, unknown>;
  /** Action-owned natural-language task for the primary Website Bridge. */
  website_instruction?: string;
  manual_instruction?: string;
  mcp_fallback_instruction?: string;
  bridge_hint?: BridgeHint;
  error?: string;
};

export async function createChatGptDispatch(input: {
  actionType: string;
  subjectRefs?: Record<string, unknown>;
  idempotencyKey?: string;
  displayTitle?: string;
  /** Required plain-language task owned by the action handler. */
  websiteInstruction: string;
  origin?: "user_click" | "explicit_automation";
}) {
  const response = await fetch("/api/chatgpt-bridge/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json() as DispatchApiResult;
  if (!response.ok || !result.ok) throw new Error(result.error || "Unable to create the ChatGPT dispatch.");
  if (result.bridge_hint) notifyBridgeHint(result.bridge_hint);
  return result;
}

export function dispatchStateLabel(state: string, dispatch?: Record<string, unknown>) {
  return labelDispatchState(state, dispatch);
}
