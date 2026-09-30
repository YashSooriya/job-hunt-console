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
  bridge_hint?: BridgeHint;
  error?: string;
};

/** Read API responses defensively when a Worker/proxy returns an HTML error page. */
export async function readBridgeApiJson<T extends Record<string, unknown> = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text().catch(() => "");
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  } catch {
    // Fall through to a bounded, user-readable transport error.
  }
  return {
    ok: false,
    error: response.ok ? "The bridge returned an invalid response." : `The bridge request failed (HTTP ${response.status}).`,
  } as unknown as T;
}

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
  const result = await readBridgeApiJson<DispatchApiResult>(response);
  if (!response.ok || !result.ok) throw new Error(result.error || "Unable to create the ChatGPT dispatch.");
  if (result.bridge_hint) notifyBridgeHint(result.bridge_hint);
  return result;
}

export function dispatchStateLabel(state: string, dispatch?: Record<string, unknown>) {
  return labelDispatchState(state, dispatch);
}
