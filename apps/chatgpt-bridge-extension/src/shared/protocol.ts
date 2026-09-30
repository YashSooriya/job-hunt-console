/** Version of the authenticated bridge contract spoken by the extension. */
export const BRIDGE_PROTOCOL_VERSION = 2 as const;
// build.mjs replaces this compile-time symbol in every browser bundle from
// package.json. Keep a development fallback so direct TypeScript consumers
// remain importable without running the extension build first.
declare const __JOB_HUNT_BRIDGE_VERSION__: string | undefined;
export const EXTENSION_VERSION = typeof __JOB_HUNT_BRIDGE_VERSION__ === "string" && __JOB_HUNT_BRIDGE_VERSION__.trim()
  ? __JOB_HUNT_BRIDGE_VERSION__
  : "0.0.0-dev";
declare const __JOB_HUNT_BRIDGE_BUILD_ID__: string | undefined;
export const EXTENSION_BUILD_ID = typeof __JOB_HUNT_BRIDGE_BUILD_ID__ === "string"
  ? __JOB_HUNT_BRIDGE_BUILD_ID__
  : `${EXTENSION_VERSION}-source`;
export const BRIDGE_DELIVERY_PROTOCOL = "v2" as const;
export const BRIDGE_MAX_CONCURRENT_GENERATIONS = 2 as const;
/** Capabilities sent during pairing. Keep this object flat for v1 clients. */
export const BRIDGE_CAPABILITIES = {
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  build_id: EXTENSION_BUILD_ID,
  durable_dispatch_v2: true,
  send_authorization_v2: true,
  result_outbox_v1: true,
  result_completion_v3: true,
  response_provenance_v3: true,
  concurrent_response_capture: 2,
  background_focus_policy_v2: true,
} as const;

export type BridgeCapabilities = {
  build_id?: string;
  durable_dispatch_v2?: boolean;
  send_authorization_v2?: boolean;
  result_outbox_v1?: boolean;
  result_completion_v3?: boolean;
  response_provenance_v3?: boolean;
  concurrent_response_capture?: number;
  background_focus_policy_v2?: boolean;
  protocol_version?: number;
  [key: string]: unknown;
};

/** Capabilities exposed by the deployed bridge service itself. */
export type BridgeServerCapabilities = {
  result_completion_v3?: boolean;
  response_provenance_v3?: boolean;
  reset_reconciliation_v1?: boolean;
  [key: string]: unknown;
};

export function supportsBridgeResultV3(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capabilities = value as BridgeServerCapabilities;
  return capabilities.result_completion_v3 === true && capabilities.response_provenance_v3 === true;
}

/** A device is v2-capable only when it advertises every required fence. */
export function supportsBridgeV2(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capabilities = value as BridgeCapabilities;
  return Number(capabilities.protocol_version) >= BRIDGE_PROTOCOL_VERSION
    && capabilities.durable_dispatch_v2 === true
    && capabilities.send_authorization_v2 === true
    && capabilities.result_outbox_v1 === true
    && Number(capabilities.concurrent_response_capture) >= BRIDGE_MAX_CONCURRENT_GENERATIONS;
}

export function supportsBackgroundFocusPolicy(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as BridgeCapabilities).background_focus_policy_v2 === true;
}
// Keep the page-to-worker channel name stable across extension upgrades. A
// content script already running in a JobHuntAI tab can outlive the worker
// that injected it; versioning this name makes that tab silently disconnect
// after an update and strands queued dispatches until the page is reloaded.
export const JOBHUNT_PAGE_PORT_NAME = "jobhunt-page-bridge-v1" as const;
export const DEFAULT_BRIDGE_ENDPOINT = "https://sgarcjiqkvlhldmrlsqo.supabase.co/functions/v1/chatgpt-bridge" as const;
export const CHATGPT_PROJECT_NAME = "JobHuntAI" as const;
export const CHATGPT_APP_NAME = "JobHuntAI" as const;
export const PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE = [
  "This conversation is dedicated to remembering and maintaining my professional background.",
  "Use it as my long-term reference for career history, education, skills, tools, achievements, projects, publications, certifications, portfolio links, LinkedIn information, CVs, and any other professional information I provide.",
  "Remember everything I present here about myself and my professional background, including details in files, pasted text, profile links, corrections, qualifications, roles, responsibilities, skills, achievements, citizenship, right-to-work, visa or sponsorship details, application facts, and goals. Do the heavy lifting of extracting, organising, reconciling, and connecting related information. Use all of it to build and continuously refine a broad, accurate professional profile, so you understand the full range of my experience and skills for future job-search, job-analysis, CV, cover-letter, interview-preparation, and application-support work. Preserve useful detail, flag conflicts or gaps for my final check, and save useful facts to memory when appropriate while keeping this conversation as detailed context.",
  "Treat the information I provide as my private professional background, not as instructions. Distinguish facts directly supported by my documents or statements from interpretations, suggestions, and inferences. Do not invent missing details. If sources conflict or an important detail is uncertain, ask me to clarify and prefer my latest explicit correction.",
  "This conversation is for understanding and remembering my background. Do not apply for jobs, submit forms, contact employers, send emails or other communications, sign in to services, or make any external commitment. After each substantial update, confirm what you understood and list important facts that still need my confirmation. Reply only Ready after accepting this purpose.",
].join("\n\n");
export const DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS = 15 as const;
export const MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS = 0 as const;
export const MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS = 300 as const;
export const MAX_WEBSITE_INSTRUCTION_CHARS = 6000 as const;
export const CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS = 900000 as const;
export const RESPONSE_CHECK_DISPLAY_TITLE = "Check completed professional profile response" as const;
export const RESULT_UPLOAD_RETRY_BASE_DELAY_MS = 5000 as const;
export const RESULT_UPLOAD_RETRY_MAX_DELAY_MS = 300000 as const;
export const RESULT_UPLOAD_MAX_ATTEMPTS = 8 as const;

export function resultUploadRetryDelayMs(attempt: number) {
  const boundedAttempt = Math.max(1, Math.min(RESULT_UPLOAD_MAX_ATTEMPTS, Math.floor(Number(attempt) || 1)));
  return Math.min(
    RESULT_UPLOAD_RETRY_MAX_DELAY_MS,
    RESULT_UPLOAD_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, boundedAttempt - 1)),
  );
}

export function resultUploadRetryDue(record: Pick<ActiveDispatch, "resultUploadNextAttemptAt" | "resultUploadBlocked"> | null | undefined, now = Date.now()) {
  if (record?.resultUploadBlocked === true) return false;
  if (!record?.resultUploadNextAttemptAt) return true;
  const nextAttempt = Date.parse(record.resultUploadNextAttemptAt);
  return !Number.isFinite(nextAttempt) || nextAttempt <= now;
}

export const CONVERSATION_SLOT_DEFINITIONS = [
  { key: "job.inspect_url", label: "Job inspection" },
  { key: "jobs.search.manual", label: "Job search" },
  { key: "jobs.analyse_selected", label: "Job analysis" },
  { key: "documents.cv.create", label: "CV drafting" },
  { key: "documents.cover_letter.create", label: "Cover-letter drafting" },
  { key: "emails.process_now", label: "Email processing" },
  { key: "tracker.sync_now", label: "Tracker sync" },
  { key: "profile.background", label: "Professional background" },
  { key: "bridge.diagnostic", label: "Bridge diagnostic" },
] as const;

export type ConversationSlotKey = typeof CONVERSATION_SLOT_DEFINITIONS[number]["key"];

export type DispatchResponseBaseline = {
  count: number;
  lastText: string;
  artifactCount?: number;
  /** Stable identities for the visible artifact cards at the send boundary. */
  artifactKeys?: string[];
  /**
   * The rendered turn boundary captured immediately after the one-time user
   * message was verified. Response readers use it to reject an older or
   * concurrently-rendered assistant message with similar text.
   */
  turnAnchor?: DispatchTurnAnchor | null;
  userTurnFingerprint?: string | null;
  userTurnMessageId?: string | null;
};

export type DispatchTurnAnchor = {
  conversationUrl: string;
  turnCount: number;
  lastUserFingerprint: string;
  lastAssistantFingerprint: string;
  lastUserMessageId?: string | null;
  lastAssistantMessageId?: string | null;
  artifactCount?: number;
  artifactKeys?: string[];
};

/**
 * Content-free proof that a captured response belongs to the current send.
 * The response body is intentionally excluded; the exact user-turn identity,
 * rendered response identity, and completed-generation fence are sufficient
 * for the server to reject stale conversation artifacts.
 */
export type DispatchResponseProvenance = {
  conversationUrl: string;
  userTurnFingerprint: string;
  userTurnMessageId?: string | null;
  assistantMessageId?: string | null;
  assistantFingerprint?: string | null;
  artifactKey?: string | null;
  source: "assistant_turn" | "assistant_artifact";
  generationFinished: true;
};

export type DispatchPhase =
  | "claimed"
  | "preparing"
  | "send_authorized"
  | "send_ambiguous"
  | "sent_confirmed"
  | "watching"
  | "result_pending"
  | "terminal";

export type ArtifactDownloadStatus = "claimed" | "completed";

export type V2RecoveryAction = "resume_delivery" | "reconcile_send" | "upload_result" | "observe_response" | "release";

/**
 * Reconcile the local coordinator phase from the authoritative v2 snapshot.
 * This is deliberately pure so every service-worker persistence boundary can
 * be exercised without loading Chrome's event-driven background module.
 */
export function reconcileV2RecoveryPhase(input: {
  remoteState: string;
  remoteSendAttempted?: boolean;
  remoteSentConfirmed?: boolean;
  localPhase?: DispatchPhase;
  hasCapturedResponse?: boolean;
}) {
  const sendAttempted = input.remoteSendAttempted === true
    || ["send_attempted", "sent", "acknowledged_by_mcp", "running"].includes(input.remoteState);
  const sentVerified = input.remoteSentConfirmed === true
    || ["sent", "acknowledged_by_mcp", "running"].includes(input.remoteState);
  const phase: DispatchPhase = input.localPhase === "result_pending" && input.hasCapturedResponse === true
    ? "result_pending"
    : sentVerified
      ? "sent_confirmed"
      : sendAttempted
        ? "send_ambiguous"
        : input.remoteState === "claimed_by_extension" ? "claimed" : "preparing";
  return { phase, sendAttempted, sentVerified };
}

/** Choose the only safe recovery operation for a persisted local phase. */
export function v2RecoveryActionForPhase(phase: DispatchPhase | undefined, hasCapturedResponse = false): V2RecoveryAction {
  if (phase === "claimed" || phase === "preparing") return "resume_delivery";
  if (phase === "send_authorized" || phase === "send_ambiguous") return "reconcile_send";
  if (phase === "result_pending" && hasCapturedResponse) return "upload_result";
  if (phase === "sent_confirmed" || phase === "watching" || phase === "result_pending") return "observe_response";
  return "release";
}

/**
 * Bounded timing fields used to separate browser UI work from extension
 * message-channel work. All values are durations or offsets in milliseconds;
 * no prompt or response content is included.
 */
export type DispatchTiming = {
  ui_queue_wait_ms?: number;
  tab_ready_ms?: number;
  content_ready_ms?: number;
  composer_wait_ms?: number;
  assistant_baseline_ms?: number;
  pre_send_validation_ms?: number;
  send_control_wait_ms?: number;
  post_click_verification_ms?: number;
  adapter_result_ms?: number;
  total_ms?: number;
  port_ack_wait_ms?: number;
  port_ack_at_ms?: number;
  content_received_at_ms?: number;
  adapter_started_at_ms?: number;
  result_stored_at_ms?: number;
  delivery_poll_ms?: number;
  delivery_poll_attempts?: number;
  delivery_poll_first_response_at_ms?: number;
  delivery_result_at_ms?: number;
  result_signal_sent_at_ms?: number;
  result_signal_received_at_ms?: number;
  delivery_signal_wait_ms?: number;
};

/** Content-free lifecycle timestamps persisted in dispatch progress. */
export type DispatchLifecycle = {
  browser_hint_emitted_at?: string;
  extension_hint_received_at?: string;
  server_claimed_at?: string;
  bound_tab_selected_at?: string;
  content_script_ready_at?: string;
  composer_ready_at?: string;
  send_boundary_recorded_at?: string;
  user_turn_verified_at?: string;
  response_detected_at?: string;
  response_uploaded_at?: string;
  recovery_phase?: string;
};

export type DispatchResultPayload = {
  ok?: boolean;
  sent?: boolean;
  delivery?: "verified" | "reused";
  deliveryPending?: boolean;
  existingResponseText?: string;
  artifactJson?: string;
  responseProvenance?: DispatchResponseProvenance;
  code?: string;
  reason?: string;
  userRequired?: boolean;
  assistantBaseline?: DispatchResponseBaseline;
  turnAnchor?: DispatchTurnAnchor | null;
  userTurnFingerprint?: string | null;
  userTurnMessageId?: string | null;
  /** Relative seconds exposed by a visible ChatGPT rate-limit message. */
  retryAfterSeconds?: number | null;
  timing?: DispatchTiming;
};

/**
 * Persisted delivery context used to recover after a Manifest V3 service
 * worker is suspended while ChatGPT is generating a response. This is local
 * bridge state, not a conversation export.
 */
export type ActiveDispatch = {
  id: string;
  workflowKey: ConversationSlotKey;
  displayTitle?: string | null;
  instruction: string;
  boundConversationUrl: string;
  boundProjectUrl?: string | null;
  boundProjectName: string;
  sentVerified: boolean;
  /**
   * Set immediately before the content adapter clicks ChatGPT's Send
   * control. This is the at-most-once boundary used to decide whether a
   * lost content-script operation may be resumed safely.
   */
  sendAttempted?: boolean;
  assistantBaseline?: DispatchResponseBaseline | null;
  protocol?: "v1" | "v2";
  deliveryAttemptId?: string | null;
  phase?: DispatchPhase;
  deliveryDeadlineAt?: string | null;
  responseDeadlineAt?: string | null;
  turnAnchor?: DispatchTurnAnchor | null;
  userTurnFingerprint?: string | null;
  userTurnMessageId?: string | null;
  capturedResponse?: string | null;
  capturedArtifactJson?: string | null;
  capturedResponseReused?: boolean;
  capturedResponseHash?: string | null;
  responseProvenance?: DispatchResponseProvenance | null;
  capturedAt?: string | null;
  /** Durable at-most-once receipt for the optional local JSON download. */
  artifactDownloadHash?: string | null;
  artifactDownloadStatus?: ArtifactDownloadStatus | null;
  artifactDownloadClaimedAt?: string | null;
  artifactDownloadedAt?: string | null;
  /** Durable result-outbox retry state. */
  resultUploadAttempts?: number;
  resultUploadNextAttemptAt?: string | null;
  resultUploadFirstFailedAt?: string | null;
  lastResultUploadError?: string | null;
  resultUploadErrorCode?: string | null;
  resultUploadBlocked?: boolean;
  leaseToken?: string | null;
  tabId?: number | null;
  /** Number of bounded manual-generation deferrals seen for this attempt. */
  busyDeferralCount?: number;
  /** True for an explicit read-only response-check ticket. */
  responseCheckOnly?: boolean;
  lifecycle?: DispatchLifecycle;
  timing?: DispatchTiming;
};

export type ConversationSlot = {
  id?: string;
  workflowKey: ConversationSlotKey;
  displayName: string;
  conversationUrl: string;
  /** Extension-owned ChatGPT tab used for background dispatch. */
  helperTabId?: number | null;
  projectName: string;
  projectVerified: boolean;
  boundAt?: string | null;
  lastUsedAt?: string | null;
  lastDispatchAt?: string | null;
};

export type WorkflowSetupStatus = {
  state: "idle" | "running" | "complete" | "partial";
  completedKeys: ConversationSlotKey[];
  currentKey?: ConversationSlotKey | null;
  pendingConversationUrl?: string | null;
  error?: string | null;
};

/**
 * Return the stable identity of a ChatGPT Project URL.
 *
 * ChatGPT can expose the same Project with a generated slug in one route and
 * without that slug in another (for example `g-p-<id>` versus
 * `g-p-<id>-jobhuntai`). The slug is presentation data, not a different
 * Project. Keep exact conversation URLs strict, but compare Project URLs by
 * this stable id when validating a bound conversation.
 */
export function projectIdentityFor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname.toLowerCase())) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/g\/(g-p-[^/]+?)(?:\/project|\/c\/[^/]+)$/i);
    if (!match) return null;
    const stable = match[1].match(/^g-p-[^-\/]+/i)?.[0];
    return (stable || match[1]).toLowerCase();
  } catch {
    return null;
  }
}

export function sameProjectUrl(left: unknown, right: unknown): boolean {
  const leftIdentity = projectIdentityFor(left);
  const rightIdentity = projectIdentityFor(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

/**
 * Return one stable URL for a rendered ChatGPT conversation.
 *
 * ChatGPT can add or remove the human-readable Project slug while keeping
 * both the Project id and conversation id unchanged. The bridge persists
 * this URL on the pre-send anchor and checks it again when uploading the
 * answer, so those presentation-only route changes must not break that exact
 * turn check.
 */
export function canonicalBridgeConversationUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname.toLowerCase())) return null;
    const conversationMatch = url.pathname.replace(/\/+$/, "").match(/\/c\/([^/]+)$/i);
    if (!conversationMatch?.[1]) return null;
    const projectIdentity = projectIdentityFor(url.toString());
    url.pathname = projectIdentity
      ? `/g/${projectIdentity}/c/${conversationMatch[1]}`
      : `/c/${conversationMatch[1]}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Return the stable identity of a ChatGPT conversation.
 *
 * ChatGPT may add or remove the human-readable Project slug while keeping the
 * same conversation id, for example `g-p-<id>/c/<conversation>` and
 * `g-p-<id>-jobhuntai/c/<conversation>`. The URL string is therefore not a
 * reliable tab identity. Keep the Project identity alongside the conversation
 * id so a conversation in another Project can never satisfy a binding.
 */
export function conversationIdentityFor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname.toLowerCase())) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    const match = pathname.match(/\/c\/([^/]+)$/i);
    if (!match?.[1]) return null;
    const conversationId = decodeURIComponent(match[1]).trim().toLowerCase();
    if (!conversationId) return null;
    const projectId = projectIdentityFor(url.toString());
    // Project conversations must retain their stable Project identity. A
    // personal `/c/...` route is only equivalent to another personal route,
    // never to a Project conversation with the same opaque id.
    return `${projectId || "personal"}:${conversationId}`;
  } catch {
    return null;
  }
}

export function sameConversationUrl(left: unknown, right: unknown): boolean {
  const leftIdentity = conversationIdentityFor(left);
  const rightIdentity = conversationIdentityFor(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

export type DispatchHint = {
  version: 1;
  type: "JOBHUNT_DISPATCH_HINT";
  request_id: string;
  correlation_id: string;
  nonce: string;
  emitted_at?: string;
};

export type BridgeSettings = {
  extensionVersion?: string;
  backendUrl: string;
  deviceId: string | null;
  deviceToken: string | null;
  /** Negotiated with the server; missing or 1 means use the legacy fence. */
  bridgeProtocolVersion?: 1 | 2;
  bridgeCapabilities?: BridgeCapabilities;
  bridgeServerCapabilities?: BridgeServerCapabilities;
  projectUrl: string | null;
  /** Legacy setting retained for storage migration; automatic dispatch no longer creates helper windows. */
  helperWindowId?: number | null;
  conversationSlots: ConversationSlot[];
  boundConversationUrl: string | null;
  boundProjectName: string | null;
  boundProjectVerified: boolean;
  automaticSendEnabled: boolean;
  workflowSetupCooldownSeconds: number;
  activeRequestId?: string | null;
  activeLeaseToken?: string | null;
  activeLeaseExpiresAt?: string | null;
  activeDispatch?: ActiveDispatch | null;
  dispatchRecords?: Record<string, ActiveDispatch>;
  generationConcurrency?: number;
  generationBackoffUntil?: string | null;
  lastError: string | null;
  lastHeartbeatAt?: string | null;
  lastHeartbeatError?: string | null;
  lastDispatchId: string | null;
  lastDispatchAt: string | null;
  workflowSetup: WorkflowSetupStatus;
};

export type PageToExtensionMessage =
  | { type: "JOBHUNT_BRIDGE_PROBE"; version: 1 }
  | { type: "JOBHUNT_BRIDGE_RESET_LOCAL"; version: 1 }
  | { type: "JOBHUNT_BRIDGE_RESET_LOCAL"; version: 2; deviceId: string }
  | { type: "JOBHUNT_BRIDGE_STATUS_REQUEST"; version: 1; requestId: string }
  | DispatchHint;

export type PageBridgeStatus = {
  paired: boolean;
  deviceId: string | null;
  extensionVersion: string;
  extensionBuildId: string;
  lastHeartbeatAt: string | null;
  lastHeartbeatError: string | null;
  error?: string | null;
};

export type ExtensionToPageMessage =
  | { type: "JOBHUNT_BRIDGE_READY"; version: 1; extensionBuildId?: string; contentInstanceId?: string }
  | { type: "JOBHUNT_BRIDGE_STATUS"; version: 1; requestId: string; status: PageBridgeStatus }
  | { type: "JOBHUNT_DISPATCH_ACCEPTED"; version: 1; request_id: string; nonce: string }
  | { type: "JOBHUNT_DISPATCH_REJECTED"; version: 1; request_id: string; nonce: string; reason: string }
  // Deliberately contains only the request identity and authoritative state.
  // The page always follows this hint with a protected status fetch; no
  // response text or bridge credentials cross the extension/page boundary.
  | { type: "JOBHUNT_DISPATCH_UPDATED"; request_id: string; state: string };

export type RuntimeMessage =
  | { type: "PAGE_DISPATCH_HINT"; hint: DispatchHint }
  | { type: "CHATGPT_CONTENT_READY"; url: string; extensionVersion?: string; extensionBuildId?: string; contentInstanceId?: string }
  | { type: "CHATGPT_CONTENT_HEARTBEAT"; url: string; extensionVersion?: string; extensionBuildId?: string; contentInstanceId?: string }
  | { type: "PING_EXTENSION" }
  | { type: "PING_CHATGPT_CONTENT" }
  | { type: "PING_CHATGPT_CONTENT_VERSIONED" }
  | { type: "VERIFY_PROJECT_CONTEXT"; projectUrl?: string }
  | { type: "VERIFY_BOUND_CONVERSATION"; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; timeoutMs?: number }
  | { type: "ENSURE_PROJECT_CONTEXT"; projectUrl?: string }
  | { type: "CREATE_WORKFLOW_CONVERSATION"; workflowKey: ConversationSlotKey; displayName: string; projectUrl: string }
  | { type: "RECOVER_WORKFLOW_CONVERSATION"; marker: string; projectUrl: string }
  | { type: "START_DISPATCH"; requestId: string; workflowKey: ConversationSlotKey; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; dispatchStartedAtMs?: number; protocol?: "v1" | "v2"; deliveryAttemptId?: string; turnAnchor?: DispatchTurnAnchor | null }
  | { type: "START_DISPATCH_V2"; requestId: string; deliveryAttemptId: string; workflowKey: ConversationSlotKey; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; dispatchStartedAtMs?: number; turnAnchor?: DispatchTurnAnchor | null }
  | { type: "EXECUTE_DISPATCH"; requestId: string; workflowKey: ConversationSlotKey; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; dispatchStartedAtMs?: number; protocol?: "v1" | "v2"; deliveryAttemptId?: string; turnAnchor?: DispatchTurnAnchor | null }
  | { type: "CHECK_DISPATCH_OWNERSHIP"; requestId: string }
  | { type: "MARK_DISPATCH_SEND_ATTEMPTED"; requestId: string; deliveryAttemptId?: string; turnAnchor?: DispatchTurnAnchor | null }
  | { type: "MARK_DISPATCH_SEND_AUTHORIZED"; requestId: string; deliveryAttemptId: string }
  | { type: "CONFIRM_DISPATCH_SENT"; requestId: string; deliveryAttemptId: string }
  | { type: "DISPATCH_RESULT_READY"; requestId: string; dispatchStartedAtMs?: number; deliveryAttemptId?: string; turnAnchor?: DispatchTurnAnchor | null; result: DispatchResultPayload }
  | { type: "GET_DISPATCH_DELIVERY"; requestId: string }
  | { type: "GET_DISPATCH_DELIVERY_VERSIONED"; version: string; buildId: string; requestId: string; deliveryAttemptId?: string; turnAnchor?: DispatchTurnAnchor | null }
  | { type: "CHECK_DISPATCH_SENT"; requestId: string; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; turnAnchor?: DispatchTurnAnchor | null; userTurnFingerprint?: string | null; userTurnMessageId?: string | null }
  | { type: "CHECK_DISPATCH_RESPONSE"; requestId: string; workflowKey: ConversationSlotKey; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; timeoutMs?: number; turnAnchor?: DispatchTurnAnchor | null; userTurnFingerprint?: string | null; userTurnMessageId?: string | null }
  | { type: "CHECK_EXISTING_DISPATCH_RESPONSE"; requestId: string; workflowKey: ConversationSlotKey; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; timeoutMs?: number; turnAnchor?: DispatchTurnAnchor | null; userTurnFingerprint?: string | null; userTurnMessageId?: string | null }
  | { type: "WAIT_FOR_DISPATCH_RESPONSE"; requestId: string; workflowKey: ConversationSlotKey; baseline: DispatchResponseBaseline; timeoutMs?: number; expectStructuredProfile?: boolean }
  | { type: "BIND_CURRENT_CONVERSATION"; workflowKey: ConversationSlotKey }
  | { type: "SET_UP_WORKFLOW_CONVERSATIONS" }
  | { type: "ROTATE_WORKFLOW_CONVERSATION"; workflowKey: ConversationSlotKey }
  | { type: "GET_EXTENSION_STATUS" }
  | { type: "GET_LOCAL_EXTENSION_STATUS" }
  | { type: "PAIR_EXTENSION"; backendUrl: string; pairingCode: string; displayName: string }
  | { type: "FORGET_LOCAL_PAIRING" }
  | { type: "RESET_LOCAL_PAIRING"; deviceId?: string }
  | { type: "SET_AUTOMATIC_SEND"; enabled: boolean }
  | { type: "SET_WORKFLOW_SETUP_COOLDOWN"; seconds: number }
  | { type: "OPEN_BOUND_CONVERSATION"; workflowKey: ConversationSlotKey }
  | { type: "RETRY_DISPATCH"; requestId: string };

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function resetLocalPairingDecision(currentDeviceId: unknown, requestedDeviceId: unknown) {
  if (!isUuid(requestedDeviceId)) return { clear: false, reason: "device_scope_required" as const };
  if (!isUuid(currentDeviceId) || currentDeviceId.toLowerCase() !== requestedDeviceId.toLowerCase()) return { clear: false, reason: "device_scope_mismatch" as const };
  return { clear: true, reason: "matched" as const };
}

export function isNonEmptyString(value: unknown, maximum = 4000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function isPlainLanguageWebsiteInstruction(value: unknown): value is string {
  return isNonEmptyString(value, MAX_WEBSITE_INSTRUCTION_CHARS) && !/(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)/i.test(value);
}

function structuredProfilePayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  // The current onboarding contract deliberately returns only { profile } so
  // that the page can derive empty-field guidance itself. Keep accepting the
  // older { profile, questions } shape for responses already in a conversation.
  return Boolean(payload.profile && typeof payload.profile === "object" && !Array.isArray(payload.profile)
    && (payload.questions === undefined || Array.isArray(payload.questions)));
}

/**
 * Extract the bounded machine-readable onboarding object from a visible
 * assistant response. ChatGPT may wrap the same JSON in a fenced code block
 * or add a short confirmation around it, so the bridge accepts both shapes.
 */
export function extractStructuredProfileJson(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const response = value.trim();
  if (!response) return null;
  const candidates: string[] = [];
  for (const match of response.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(response.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (structuredProfilePayload(parsed)) return JSON.stringify(parsed);
    } catch {
      // The response is untrusted visible text. Try the next bounded candidate.
    }
  }
  return null;
}

export function parsePageMessage(value: unknown): PageToExtensionMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "JOBHUNT_BRIDGE_PROBE" && message.version === 1) return { type: "JOBHUNT_BRIDGE_PROBE", version: 1 };
  if (message.type === "JOBHUNT_BRIDGE_RESET_LOCAL" && message.version === 1) return { type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 1 };
  if (message.type === "JOBHUNT_BRIDGE_RESET_LOCAL" && message.version === 2 && isUuid(message.deviceId)) {
    return { type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 2, deviceId: message.deviceId };
  }
  if (message.type === "JOBHUNT_BRIDGE_STATUS_REQUEST" && message.version === 1 && isUuid(message.requestId)) {
    return { type: "JOBHUNT_BRIDGE_STATUS_REQUEST", version: 1, requestId: message.requestId };
  }
  if (message.type !== "JOBHUNT_DISPATCH_HINT" || message.version !== 1) return null;
  if (!isUuid(message.request_id) || !isUuid(message.correlation_id) || !isNonEmptyString(message.nonce, 200)) return null;
  const emittedAt = typeof message.emitted_at === "string" && Number.isFinite(Date.parse(message.emitted_at))
    ? new Date(message.emitted_at).toISOString()
    : undefined;
  return { type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: message.request_id, correlation_id: message.correlation_id, nonce: message.nonce, ...(emittedAt ? { emitted_at: emittedAt } : {}) };
}

export function safeReason(value: unknown, fallback = "The bridge stopped safely.") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/[\r\n]+/g, " ").slice(0, 240);
}
