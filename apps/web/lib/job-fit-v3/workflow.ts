import { calculateAssessment, parseAssessmentResponse, validateAssessmentResponse } from "./assessment.ts";
import { parseCriterionGroupResponse, parseCriterionUnitResponse, validateCriterionGroupResponse, validateCriterionUnitResponse, type CriterionUnitResponse } from "./criteria-preparation.ts";
import type { FitInput } from "./contract.ts";
import { buildAssessmentSteps, type AssessmentStep } from "./prompt.ts";
import { semanticKey, snapshotHash } from "./input.ts";

export const ACTIVE_PHASES = ["queued", "preparing_inputs", "waiting_for_bridge", "sending_context", "waiting_for_response", "validating", "saving"] as const;
export function assessmentDispatchKey(taskId: string, attempt: number, ordinal: number) { return `jobfit-${taskId}:${attempt}:${ordinal}`; }
export const MAX_RESPONSE_CHECK_ATTEMPTS = 4;
export const RESPONSE_CHECK_COOLDOWN_MS = 15000;

export function responseCheckEligibility(input: {
  state: string;
  attemptCount: number;
  sourceDispatchId: string | null;
  activeDispatchId: string | null;
  requestedSourceDispatchId: string;
  lastRequestedAt: string | null;
  nowMs?: number;
}) {
  if (input.state === "waiting_for_bridge"
    && input.sourceDispatchId === input.requestedSourceDispatchId
    && Boolean(input.activeDispatchId)) return { allowed: true as const, idempotent: true as const, retryAfterSeconds: 0 };
  if (input.state !== "needs_user"
    || (input.sourceDispatchId || input.activeDispatchId) !== input.requestedSourceDispatchId) {
    return { allowed: false as const, reason: "stale" as const, retryAfterSeconds: 0 };
  }
  if (!Number.isInteger(input.attemptCount) || input.attemptCount < 0 || input.attemptCount >= MAX_RESPONSE_CHECK_ATTEMPTS) {
    return { allowed: false as const, reason: "exhausted" as const, retryAfterSeconds: 0 };
  }
  const lastRequested = input.lastRequestedAt ? Date.parse(input.lastRequestedAt) : Number.NaN;
  const now = input.nowMs ?? Date.now();
  if (Number.isFinite(lastRequested) && now - lastRequested < RESPONSE_CHECK_COOLDOWN_MS) {
    return { allowed: false as const, reason: "rate_limited" as const, retryAfterSeconds: Math.max(1, Math.ceil((RESPONSE_CHECK_COOLDOWN_MS - (now - lastRequested)) / 1000)) };
  }
  return { allowed: true as const, idempotent: false as const, retryAfterSeconds: 0 };
}

/**
 * A composer verification failure happens before the bridge's durable Send
 * boundary. Retrying this exact dispatch is safe only while the server still
 * confirms that it was never sent; every other failure remains fail-closed.
 */
export function isSafeUnsentComposerMismatch(value: unknown) {
  const dispatch = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
  const error = dispatch.error && typeof dispatch.error === "object" && !Array.isArray(dispatch.error)
    ? dispatch.error as Record<string, unknown>
    : {};
  const response = typeof dispatch.bridge_response === "string" ? dispatch.bridge_response.trim() : "";
  return dispatch.state === "user_required"
    && error.code === "composer_mismatch"
    && dispatch.retry_allowed === true
    && dispatch.sent_at == null
    && dispatch.send_attempted_at == null
    && dispatch.sent_confirmed_at == null
    && dispatch.has_delivery_turn_anchor === false
    && dispatch.response_hash == null
    && !response;
}

/**
 * The authenticated dispatch-status RPC is the source of truth for whether
 * an explicit V2 retry can cross Send. Its `retry_allowed` flag is calculated
 * from the durable send-attempt timestamp, sent timestamp, exact-turn anchor,
 * retry bound, and protocol version. Accept safe pre-Send stops such as a
 * delivery lease expiry as well as a literal composer mismatch; the former
 * can also happen when the extension worker loses a pre-Send acknowledgement.
 * Never infer safety from the user-facing error string alone.
 */
export function isSafeUnsentPreDeliveryV2Dispatch(value: unknown) {
  const dispatch = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
  const protocol = dispatch.protocol ?? dispatch.progress?.protocol;
  const response = typeof dispatch.bridge_response === "string" ? dispatch.bridge_response.trim() : "";
  return protocol === "v2"
    && ["user_required", "failed", "expired"].includes(String(dispatch.state))
    && dispatch.retry_allowed === true
    && dispatch.sent_at == null
    && dispatch.send_attempted_at == null
    && dispatch.sent_confirmed_at == null
    && dispatch.has_delivery_turn_anchor === false
    && dispatch.response_hash == null
    && !response;
}

/** The generic bridge retry already requeued this same, not-yet-sent dispatch. */
export function isRequeuedUnsentDispatch(value: unknown) {
  const dispatch = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
  return dispatch.state === "queued"
    && dispatch.progress?.stage === "requeued_by_user"
    && dispatch.sent_at == null
    && dispatch.send_attempted_at == null
    && dispatch.sent_confirmed_at == null
    && dispatch.has_delivery_turn_anchor === false
    && dispatch.response_hash == null
    && !(typeof dispatch.bridge_response === "string" && dispatch.bridge_response.trim());
}

export function prepareWorkflow(userId: string, input: FitInput, testing: boolean, preferences: Record<string, unknown> = {}) {
  return { semantic_key: semanticKey(userId, input, preferences), input_hash: snapshotHash(input), steps: buildAssessmentSteps(input, testing) };
}
/** Result processing never sends a ChatGPT message. A captured result can be retried independently. */
export function processExactResponse(args: { input: FitInput; taskId: string; attempt: number; step: AssessmentStep; dispatch: Record<string, any>; expectedDispatchId: string; expectedConversationUrl?: string; assessmentAsOf: Date }) {
  const { dispatch: d, input, step } = args;
  if (d.id !== args.expectedDispatchId || d.action_type !== "jobs.analyse_selected" || d.idempotency_key !== assessmentDispatchKey(args.taskId, args.attempt, step.ordinal) || !Array.isArray(d.subject_refs?.job_ids) || d.subject_refs.job_ids.length !== 1 || d.subject_refs.job_ids[0] !== input.job_id) throw new Error("The captured response does not belong to this job-assessment step.");
  if (d.state !== "completed") return { ready: false as const, state: String(d.state) };
  if (![true, "true"].includes(d.output_refs?.response_provenance_recorded) || typeof d.bridge_response !== "string" || !d.bridge_response.trim() || !d.bridge_response_at) throw new Error("The response has no verified assistant-turn provenance. No message was resent.");
  const provenance = d.response_provenance;
  const anchor = d.delivery_turn_anchor ?? d.turn_anchor;
  const conversation = provenance?.conversationUrl;
  if (typeof conversation !== "string" || !conversation.trim()
    || typeof provenance?.userTurnFingerprint !== "string" || !provenance.userTurnFingerprint.trim()
    || provenance.generationFinished !== true
    || !(["assistant_turn", "assistant_artifact"].includes(provenance.source))
    || (provenance.source === "assistant_turn" && !((typeof provenance.assistantMessageId === "string" && provenance.assistantMessageId) || (typeof provenance.assistantFingerprint === "string" && provenance.assistantFingerprint)))
    || (provenance.source === "assistant_artifact" && !(typeof provenance.artifactKey === "string" && provenance.artifactKey))
    || anchor?.conversationUrl !== conversation
    || (typeof d.delivery_user_turn_fingerprint === "string" && d.delivery_user_turn_fingerprint !== provenance.userTurnFingerprint)) {
    throw new Error("The response is missing its exact sent-user-turn and finished assistant-turn provenance. No message was resent.");
  }
  const samePreSendAssistantId = typeof anchor?.lastAssistantMessageId === "string"
    && anchor.lastAssistantMessageId
    && provenance.assistantMessageId === anchor.lastAssistantMessageId;
  const samePreSendAssistantFingerprint = (!anchor?.lastAssistantMessageId || !provenance.assistantMessageId)
    && typeof anchor?.lastAssistantFingerprint === "string"
    && anchor.lastAssistantFingerprint
    && provenance.assistantFingerprint === anchor.lastAssistantFingerprint;
  const preSendArtifactKeys = Array.isArray(anchor?.artifactKeys) ? anchor.artifactKeys : [];
  if (samePreSendAssistantId || samePreSendAssistantFingerprint
    || (provenance.source === "assistant_artifact" && typeof provenance.artifactKey === "string" && preSendArtifactKeys.includes(provenance.artifactKey))) {
    throw new Error("The captured assistant message already existed at the saved pre-send boundary. It is not the response to this request, and the original message was not resent.");
  }
  if (args.expectedConversationUrl !== undefined && conversation !== args.expectedConversationUrl) throw new Error("The assessment conversation changed. Replay complete context in a fresh attempt before assessment.");
  if (step.phase === "context") {
    if (!/^context received[!. ]*$/i.test(d.bridge_response.trim())) throw new Error("ChatGPT did not acknowledge the complete context part. The captured response was retained; no message was resent.");
    return { ready: true as const, phase: "context" as const, response_hash: snapshotHash(d.bridge_response), conversation_url: conversation, provenance };
  }
  if (step.phase === "criteria") {
    if (Array.isArray(step.source_unit_references) && typeof step.group_id === "string") {
      const references = step.source_unit_references.filter((reference): reference is string => typeof reference === "string");
      const units = references.map((reference) => input.criteria_source_units.find((candidate) => candidate.reference === reference));
      if (!references.length || units.some((unit) => !unit)) throw new Error("The frozen criterion group does not match saved listing source units. No message was resent.");
      const prepared = validateCriterionGroupResponse(parseCriterionGroupResponse(d.bridge_response), input, step.group_id, units as NonNullable<(typeof units)[number]>[]);
      return { ready: true as const, phase: "criteria" as const, response_hash: snapshotHash(d.bridge_response), conversation_url: conversation, provenance, result: prepared };
    }
    if (!step.source_unit_reference) throw new Error("The frozen criterion-preparation source unit is missing. No message was resent.");
    const unit = input.criteria_source_units.find((candidate) => candidate.reference === step.source_unit_reference);
    if (!unit) throw new Error("The criterion-preparation message does not match a saved listing source unit. No message was resent.");
    const prepared: CriterionUnitResponse = validateCriterionUnitResponse(parseCriterionUnitResponse(d.bridge_response), input, unit);
    return { ready: true as const, phase: "criteria" as const, response_hash: snapshotHash(d.bridge_response), conversation_url: conversation, provenance, result: prepared };
  }
  const response = validateAssessmentResponse(parseAssessmentResponse(d.bridge_response), input);
  return { ready: true as const, phase: "assessment" as const, response_hash: snapshotHash(d.bridge_response), conversation_url: conversation, provenance, result: calculateAssessment(input, response, args.assessmentAsOf) };
}
