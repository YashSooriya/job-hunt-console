export const RESPONSE_RECOVERY_STATUSES = [
  "eligible", "cooldown", "active_check", "captured", "exhausted", "ineligible",
] as const;

export type ResponseRecoveryStatus = typeof RESPONSE_RECOVERY_STATUSES[number];
export type ResponseRecoveryCandidate = {
  task_id: string;
  batch_id: string;
  job_id: string;
  dispatch_id: string | null;
  status: ResponseRecoveryStatus;
  reason_code: string | null;
  retry_after_seconds: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_SET = new Set<string>(RESPONSE_RECOVERY_STATUSES);

/** Validate the small, non-sensitive result returned by the recovery RPC. */
export function normalizeResponseRecoveryCandidate(value: unknown): ResponseRecoveryCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (![row.task_id, row.batch_id, row.job_id].every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (row.dispatch_id !== null && row.dispatch_id !== undefined
    && (typeof row.dispatch_id !== "string" || !UUID.test(row.dispatch_id))) return null;
  const knownStatus = typeof row.status === "string" && STATUS_SET.has(row.status);
  const retryAfter = Number(row.retry_after_seconds);
  return {
    task_id: row.task_id as string,
    batch_id: row.batch_id as string,
    job_id: row.job_id as string,
    dispatch_id: typeof row.dispatch_id === "string" ? row.dispatch_id : null,
    // Fail closed if a future or malformed status reaches an older web build.
    status: knownStatus ? row.status as ResponseRecoveryStatus : "ineligible",
    reason_code: !knownStatus
      ? "unknown_recovery_status"
      : typeof row.reason_code === "string" && row.reason_code.length <= 80 ? row.reason_code : null,
    retry_after_seconds: Number.isFinite(retryAfter) ? Math.max(0, Math.min(86400, Math.floor(retryAfter))) : 0,
  };
}
