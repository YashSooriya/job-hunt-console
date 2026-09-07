/**
 * Safe, content-free diagnostics for a Website Bridge dispatch.
 *
 * The server progress object may contain other fields used by the bridge.
 * These helpers deliberately project only phase, bounded timing values, and
 * lifecycle timestamps before anything is rendered in the diagnostics UI.
 */

export const CURRENT_BRIDGE_EXTENSION_VERSION = "0.2.5" as const;

export const LIFECYCLE_TIMESTAMP_FIELDS = [
  "browser_hint_emitted_at",
  "extension_hint_received_at",
  "server_claimed_at",
  "bound_tab_selected_at",
  "content_script_ready_at",
  "composer_ready_at",
  "send_boundary_recorded_at",
  "user_turn_verified_at",
  "response_detected_at",
  "response_uploaded_at",
] as const;

export type LifecycleTimestampField = typeof LIFECYCLE_TIMESTAMP_FIELDS[number];

export type DispatchLifecycle = Partial<Record<LifecycleTimestampField, string>> & {
  recovery_phase?: string;
};

export type DispatchTimingDiagnostics = Record<string, number>;

export type DispatchDiagnostics = {
  id: string | null;
  state: string;
  phase: string;
  lifecycle: DispatchLifecycle;
  timing: DispatchTimingDiagnostics;
  retryAllowed: boolean;
  sendAttempted: boolean;
  sentVerified: boolean;
  errorCode: string | null;
};

export type BridgeStatusSummary = {
  extensionVersion?: string | null;
  extensionBuildId?: string | null;
  online?: boolean;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function safePhase(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80) return undefined;
  return /^[a-z][a-z0-9_:-]*$/i.test(value) ? value : undefined;
}

export function sanitizeLifecycle(value: unknown): DispatchLifecycle {
  const input = recordValue(value);
  const result: DispatchLifecycle = {};
  for (const key of LIFECYCLE_TIMESTAMP_FIELDS) {
    const timestamp = safeTimestamp(input[key]);
    if (timestamp) result[key] = timestamp;
  }
  const recoveryPhase = safePhase(input.recovery_phase);
  if (recoveryPhase) result.recovery_phase = recoveryPhase;
  return result;
}

export function sanitizeTiming(value: unknown): DispatchTimingDiagnostics {
  const input = recordValue(value);
  const result: DispatchTimingDiagnostics = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(key) || typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (raw < 0 || raw > 86_400_000) continue;
    result[key] = Math.round(raw);
  }
  return result;
}

export function lifecyclePayload(value: unknown): DispatchLifecycle | null {
  const lifecycle = sanitizeLifecycle(value);
  return Object.keys(lifecycle).length ? lifecycle : null;
}

export function dispatchDiagnostics(raw: unknown): DispatchDiagnostics {
  const dispatch = recordValue(raw);
  const progress = recordValue(dispatch.progress);
  const lifecycle = sanitizeLifecycle(dispatch.lifecycle || progress.lifecycle);
  const timing = sanitizeTiming(dispatch.timing || progress.timing);
  const state = typeof dispatch.state === "string" ? dispatch.state : "queued";
  const phase = lifecycle.recovery_phase
    || (typeof progress.phase === "string" ? progress.phase : "")
    || (typeof progress.stage === "string" ? progress.stage : "")
    || state;
  const sendAttempted = Boolean(dispatch.send_attempted_at || dispatch.sent_at || progress.send_attempted === true);
  const sentVerified = Boolean(dispatch.sent_confirmed_at || dispatch.sent_at || progress.sent_verified === true);
  const retryAllowed = dispatch.retry_allowed === true && !sendAttempted && !sentVerified;
  const error = recordValue(dispatch.error);
  return {
    id: typeof dispatch.id === "string" ? dispatch.id : null,
    state,
    phase,
    lifecycle,
    timing,
    retryAllowed,
    sendAttempted,
    sentVerified,
    errorCode: typeof error.code === "string" ? error.code : null,
  };
}

export function hasMonotonicLifecycleSequence(lifecycle: DispatchLifecycle): boolean {
  let previous = -Infinity;
  for (const key of LIFECYCLE_TIMESTAMP_FIELDS) {
    const value = lifecycle[key];
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp < previous) return false;
    previous = timestamp;
  }
  return true;
}

export function bridgeBuildState(status?: BridgeStatusSummary | null): "current" | "outdated" | "unknown" {
  if (!status?.extensionVersion && !status?.extensionBuildId) return "unknown";
  if (status.extensionVersion !== CURRENT_BRIDGE_EXTENSION_VERSION || !status.extensionBuildId) return "outdated";
  return "current";
}

export function lifecycleStatus(diagnostics: DispatchDiagnostics, bridge?: BridgeStatusSummary | null): string {
  if (bridgeBuildState(bridge) === "outdated") return "Extension build is outdated";
  if (diagnostics.errorCode && /content|bridge|transport|extension|channel|lease|claim|delivery/i.test(diagnostics.errorCode)) return "Bridge transport failed; retrying";
  if (diagnostics.state === "queued" && !diagnostics.lifecycle.extension_hint_received_at) return "Waiting for extension";
  if (diagnostics.phase === "recovering_stale_chatgpt_tab") return "Recovering stale ChatGPT tab";
  if (diagnostics.state === "sent" || diagnostics.state === "acknowledged_by_mcp" || diagnostics.state === "running") {
    if (diagnostics.lifecycle.response_detected_at && !diagnostics.lifecycle.response_uploaded_at) return "Response captured; retrying upload";
    return "Message sent; waiting for ChatGPT";
  }
  if (diagnostics.phase === "result_pending" || (diagnostics.lifecycle.response_detected_at && !diagnostics.lifecycle.response_uploaded_at)) return "Response captured; retrying upload";
  if (diagnostics.state === "completed") return "Completed";
  if (diagnostics.retryAllowed) return "Delivery stopped; safe retry available";
  if (diagnostics.sendAttempted || diagnostics.sentVerified) return "Manual review required; do not resend";
  if (diagnostics.state === "composer_ready") return "Preparing message";
  if (diagnostics.state === "send_attempted") return "Confirming delivery";
  if (diagnostics.state === "failed" || diagnostics.state === "user_required" || diagnostics.state === "expired" || diagnostics.state === "cancelled") return "Needs attention";
  return diagnostics.phase || diagnostics.state;
}

export function lifecycleEntries(lifecycle: DispatchLifecycle) {
  return LIFECYCLE_TIMESTAMP_FIELDS
    .filter((key) => lifecycle[key])
    .map((key) => ({ key, value: lifecycle[key] as string }));
}
