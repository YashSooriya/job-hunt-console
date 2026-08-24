export type BridgeHint = {
  version: 1;
  type: "JOBHUNT_DISPATCH_HINT";
  request_id: string;
  correlation_id: string;
  nonce: string;
};

export type DispatchApiResult = {
  ok: boolean;
  dispatch?: Record<string, unknown>;
  manual_instruction?: string;
  bridge_hint?: BridgeHint;
  error?: string;
};

export async function createChatGptDispatch(input: {
  actionType: string;
  subjectRefs?: Record<string, unknown>;
  idempotencyKey?: string;
  displayTitle?: string;
  origin?: "user_click" | "explicit_automation";
}) {
  const response = await fetch("/api/chatgpt-bridge/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json() as DispatchApiResult;
  if (!response.ok || !result.ok) throw new Error(result.error || "Unable to create the ChatGPT dispatch.");
  if (typeof window !== "undefined" && result.bridge_hint) window.postMessage(result.bridge_hint, window.location.origin);
  return result;
}

export function dispatchStateLabel(state: string) {
  switch (state) {
    case "queued": return "Queued";
    case "claimed_by_extension":
    case "opening_chatgpt": return "Opening ChatGPT";
    case "composer_ready": return "Preparing message";
    case "sent": return "Sent to ChatGPT";
    case "acknowledged_by_mcp":
    case "running": return "ChatGPT working";
    case "completed": return "Completed";
    case "user_required": return "Needs attention";
    case "cancelled": return "Cancelled";
    case "expired": return "Expired";
    case "failed": return "Failed";
    default: return state.replaceAll("_", " ");
  }
}
