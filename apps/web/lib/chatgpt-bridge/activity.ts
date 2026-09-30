type DispatchActivity = { state?: string; raw?: Record<string, unknown> };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasTimestamp(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

/** True only after the Website Bridge has sent the message and is waiting for generation. */
export function isWaitingForChatGpt(activity: DispatchActivity) {
  const progress = objectValue(activity.raw?.progress);
  const lifecycle = objectValue(progress?.lifecycle);
  if (progress?.stage === "result_pending" || progress?.stage === "result_upload_pending") return false;
  if (progress?.answer_captured === true || progress?.result_pending === true) return false;
  if (hasTimestamp(lifecycle?.response_detected_at) || hasTimestamp(lifecycle?.response_uploaded_at)) return false;
  return ["sent", "acknowledged_by_mcp", "running"].includes(activity.state || "");
}
