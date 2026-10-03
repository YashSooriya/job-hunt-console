type MemoryFitDispatchIdentity = Record<string, unknown>;
type MemoryFitChunkIdentity = Record<string, unknown>;

export function exactMemoryFitDispatchMatches(dispatch: MemoryFitDispatchIdentity, chunk: MemoryFitChunkIdentity) {
  const refs = dispatch.subject_refs && typeof dispatch.subject_refs === "object" && !Array.isArray(dispatch.subject_refs)
    ? dispatch.subject_refs as Record<string, unknown>
    : {};
  const subjectIds = refs.job_ids;
  const expectedIds = chunk.job_ids;
  if (typeof chunk.idempotency_key !== "string" || typeof chunk.instruction !== "string"
    || !Array.isArray(expectedIds) || expectedIds.some((id) => typeof id !== "string")) return false;
  return dispatch.action_type === "jobs.analyse_selected"
    && (chunk.dispatch_id === undefined || chunk.dispatch_id === null || dispatch.id === chunk.dispatch_id)
    && dispatch.idempotency_key === chunk.idempotency_key
    && Array.isArray(subjectIds)
    && subjectIds.length === expectedIds.length
    && subjectIds.every((id, index) => id === expectedIds[index])
    && (dispatch.website_instruction ?? dispatch.manual_instruction) === chunk.instruction;
}

/** Only a server-confirmed pre-Send V2 failure can be offered for safe retry. */
export function safeMemoryFitDispatchRetryAllowed(dispatch: MemoryFitDispatchIdentity, chunk: MemoryFitChunkIdentity) {
  return exactMemoryFitDispatchMatches(dispatch, chunk)
    && dispatch.protocol === "v2"
    && dispatch.retry_allowed === true
    && ["user_required", "failed", "expired"].includes(String(dispatch.state))
    && dispatch.sent_at == null
    && dispatch.send_attempted_at == null
    && dispatch.sent_confirmed_at == null
    && dispatch.delivery_turn_anchor == null
    && dispatch.response_hash == null
    && dispatch.bridge_response == null;
}

/**
 * Once the generic Bridge's bounded retry counter is exhausted, a new
 * Memory-fit dispatch is safe only when the prior exact V2 request is
 * server-confirmed as never sent and no response was captured. This does not
 * broaden generic Bridge retries and must never be used to replay a sent turn.
 */
export function safeMemoryFitFreshDispatchAllowed(
  dispatch: MemoryFitDispatchIdentity,
  chunk: MemoryFitChunkIdentity,
  items: Array<{ job_id?: unknown; state?: unknown; analysis_id?: unknown }>,
) {
  const error = dispatch.error && typeof dispatch.error === "object" && !Array.isArray(dispatch.error)
    ? dispatch.error as Record<string, unknown>
    : {};
  const jobIds = chunk.job_ids;
  return exactMemoryFitDispatchMatches(dispatch, chunk)
    && dispatch.protocol === "v2"
    && ["user_required", "failed", "expired"].includes(String(dispatch.state))
    && dispatch.retry_allowed === false
    && Number(dispatch.attempt_count) >= 5
    && error.code === "delivery_lease_expired"
    && dispatch.sent_at == null
    && dispatch.send_attempted_at == null
    && dispatch.sent_confirmed_at == null
    && dispatch.has_delivery_turn_anchor === false
    && dispatch.bridge_response == null
    && dispatch.completed_at == null
    && chunk.captured_response == null
    && Array.isArray(jobIds)
    && items.length === jobIds.length
    && items.every((item) => jobIds.includes(item.job_id as string)
      && ["queued", "needs_user"].includes(String(item.state)) && item.analysis_id == null);
}

/** Reattach only after the generic retry RPC has confirmed this exact V2 turn was requeued before Send. */
export function memoryFitDispatchWasSafelyRequeued(dispatch: MemoryFitDispatchIdentity, chunk: MemoryFitChunkIdentity) {
  const progress = dispatch.progress && typeof dispatch.progress === "object" && !Array.isArray(dispatch.progress)
    ? dispatch.progress as Record<string, unknown>
    : {};
  return exactMemoryFitDispatchMatches(dispatch, chunk)
    && dispatch.state === "queued"
    && dispatch.protocol === "v2"
    && progress.stage === "requeued_by_user"
    && dispatch.sent_at == null
    && dispatch.send_attempted_at == null
    && dispatch.sent_confirmed_at == null
    && dispatch.delivery_turn_anchor == null
    && dispatch.response_hash == null
    && dispatch.bridge_response == null;
}

/** The create RPC omits subject_refs, so match its receipt to the owner-scoped full read. */
export function createdMemoryFitDispatchMatches(
  created: MemoryFitDispatchIdentity,
  persisted: MemoryFitDispatchIdentity,
  chunk: MemoryFitChunkIdentity,
) {
  return typeof created.id === "string" && created.id.length > 0
    && created.id === persisted.id
    && created.action_type === "jobs.analyse_selected"
    && created.idempotency_key === chunk.idempotency_key
    && (created.website_instruction ?? created.manual_instruction) === chunk.instruction
    && exactMemoryFitDispatchMatches(persisted, chunk);
}
