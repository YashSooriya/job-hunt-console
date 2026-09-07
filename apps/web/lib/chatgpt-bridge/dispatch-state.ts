export const TERMINAL_DISPATCH_STATES = new Set([
  "completed",
  "failed",
  "user_required",
  "expired",
  "cancelled",
]);

export const DISPATCH_ACTIVE_POLL_INTERVAL_MS = 2000;
export const DISPATCH_RETRY_DELAYS_MS = [3000, 5000, 10000, 15000] as const;

export function dispatchRetryDelayMs(failures: number) {
  const index = Math.max(0, Math.min(DISPATCH_RETRY_DELAYS_MS.length - 1, Math.floor(failures) - 1));
  return DISPATCH_RETRY_DELAYS_MS[index] || DISPATCH_RETRY_DELAYS_MS[DISPATCH_RETRY_DELAYS_MS.length - 1];
}

function dispatchProgress(dispatch?: Record<string, unknown>) {
  const progress = dispatch?.progress;
  return progress && typeof progress === "object" && !Array.isArray(progress)
    ? progress as Record<string, unknown>
    : null;
}

export function dispatchStateLabel(state: string, dispatch?: Record<string, unknown>) {
  const progress = dispatchProgress(dispatch);
  const progressStage = typeof progress?.stage === "string" ? progress.stage : "";
  if (state !== "completed" && (progressStage === "result_pending" || progressStage === "result_upload_pending" || progress?.answer_captured === true || progress?.result_pending === true)) {
    return "Answer captured; saving result";
  }
  switch (state) {
    case "queued": return "Queued";
    case "claimed_by_extension":
    case "opening_chatgpt": return "Opening ChatGPT";
    case "composer_ready": return "Preparing message";
    case "send_attempted": return "Confirming delivery";
    case "sent": return "Waiting for ChatGPT";
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

export function effectiveDispatchState(liveState?: string | null, initialState?: string | null) {
  return liveState || initialState || "queued";
}

export function isDispatchActive(state?: string | null) {
  return !TERMINAL_DISPATCH_STATES.has(state || "queued");
}
