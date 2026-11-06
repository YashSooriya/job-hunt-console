/**
 * Safe, content-free diagnostics for a Website Bridge dispatch.
 *
 * The server progress object may contain other fields used by the bridge.
 * These helpers deliberately project only phase, bounded timing values, and
 * lifecycle timestamps before anything is rendered in the diagnostics UI.
 */

export const CURRENT_BRIDGE_EXTENSION_VERSION = "0.2.16" as const;

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
  serverDeviceId?: string | null;
  extensionVersion?: string | null;
  extensionBuildId?: string | null;
  extensionCapabilities?: Record<string, unknown> | null;
  serverCapabilities?: Record<string, unknown> | null;
  online?: boolean;
};

export type BridgeLocalStatusSummary = {
  available?: boolean;
  paired?: boolean;
  deviceId?: string | null;
  extensionVersion?: string | null;
  extensionBuildId?: string | null;
};

export type BridgeConnectionState = "extension_missing" | "not_paired" | "device_mismatch" | "outdated" | "online" | "offline" | "server_unknown";

/** Capabilities required for the current Website Bridge diagnostic workflow. */
export const BRIDGE_REQUIRED_EXTENSION_CAPABILITIES = {
  protocol_version: 2,
  durable_dispatch_v2: true,
  send_authorization_v2: true,
  result_outbox_v1: true,
  concurrent_response_capture: 2,
  background_focus_policy_v2: true,
  result_completion_v3: true,
  response_provenance_v3: true,
} as const;

export const BRIDGE_REQUIRED_SERVER_CAPABILITIES = {
  result_completion_v3: true,
  response_provenance_v3: true,
} as const;

export function bridgeCapabilityGaps(extensionCapabilities: unknown, serverCapabilities: unknown): string[] {
  const extension = recordValue(extensionCapabilities);
  const server = recordValue(serverCapabilities);
  const gaps: string[] = [];
  for (const [name, required] of Object.entries(BRIDGE_REQUIRED_EXTENSION_CAPABILITIES)) {
    const actual = extension[name];
    const available = typeof required === "number" ? Number(actual) >= required : actual === required;
    if (!available) gaps.push(`extension.${name}${typeof required === "number" ? ` >= ${required}` : ""}`);
  }
  for (const [name, required] of Object.entries(BRIDGE_REQUIRED_SERVER_CAPABILITIES)) {
    if (server[name] !== required) gaps.push(`server.${name}`);
  }
  return gaps;
}

export function bridgeConnectionState(server?: BridgeStatusSummary | null, local?: BridgeLocalStatusSummary | null): BridgeConnectionState {
  if (!local || local.available !== true) return "extension_missing";
  if (local.paired !== true || !local.deviceId) return "not_paired";
  if (server?.serverDeviceId && server.serverDeviceId.toLowerCase() !== local.deviceId.toLowerCase()) return "device_mismatch";
  if (!server) return "server_unknown";
  if (!bridgeVersionAtLeast(local.extensionVersion) || !local.extensionBuildId || !server.extensionBuildId) return "outdated";
  if (server.extensionVersion && server.extensionVersion !== local.extensionVersion) return "outdated";
  if (server.extensionBuildId !== local.extensionBuildId) return "outdated";
  if (bridgeCapabilityGaps(server.extensionCapabilities, server.serverCapabilities).length > 0) return "outdated";
  return server.online === true ? "online" : "offline";
}

export function bridgeCompatibilityMessage(server?: BridgeStatusSummary | null, local?: BridgeLocalStatusSummary | null): string {
  if (!server) return "The paired Website Bridge server status could not be checked. Refresh Diagnostics before sending.";
  const version = local?.extensionVersion || "unknown";
  if (!bridgeVersionAtLeast(local?.extensionVersion)) {
    return `Installed Website Bridge version ${version} is below the supported minimum ${CURRENT_BRIDGE_EXTENSION_VERSION}. Update or reload the extension.`;
  }
  if (!local?.extensionBuildId || !server.extensionBuildId) {
    return "The installed Website Bridge build identity could not be verified. Reload the extension and refresh Diagnostics.";
  }
  if (server.extensionVersion && server.extensionVersion !== local.extensionVersion) {
    return `This browser reports Website Bridge ${version}, but the paired server device reports ${server.extensionVersion}. Reload the extension and refresh Diagnostics.`;
  }
  if (server.extensionBuildId !== local.extensionBuildId) {
    return "This browser's Website Bridge build does not match the paired server device. Reload the extension and refresh Diagnostics.";
  }
  const gaps = bridgeCapabilityGaps(server.extensionCapabilities, server.serverCapabilities);
  if (gaps.length === 0) return "Website Bridge compatibility could not be confirmed. Refresh Diagnostics and check the paired device status.";
  const extensionGaps = gaps.filter((gap) => gap.startsWith("extension."));
  const serverGaps = gaps.filter((gap) => gap.startsWith("server."));
  const nextSteps = [
    ...(extensionGaps.length ? ["Update or reload the Website Bridge extension."] : []),
    ...(serverGaps.length ? ["The Bridge server needs a deployment that advertises the listed server capabilities."] : []),
  ];
  return `Missing required Website Bridge capabilities: ${gaps.join(", ")}. ${nextSteps.join(" ")}`;
}

export function bridgeConnectionLabel(state: BridgeConnectionState): string {
  switch (state) {
    case "extension_missing": return "Extension not detected";
    case "not_paired": return "Extension not paired";
    case "device_mismatch": return "Different device paired";
    case "outdated": return "Bridge incompatible";
    case "online": return "Online";
    case "offline": return "Paired; heartbeat offline";
    case "server_unknown": return "Checking server";
  }
}

export function bridgeVersionAtLeast(value: string | null | undefined, minimum = CURRENT_BRIDGE_EXTENSION_VERSION) {
  const actual = String(value || "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0);
  const expected = String(minimum).split(".").slice(0, 3).map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0);
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    const left = actual[index] || 0;
    const right = expected[index] || 0;
    if (left !== right) return left > right;
  }
  return true;
}

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

/**
 * The terminal dispatch state is authoritative. Lifecycle writes are
 * intentionally asynchronous, so a completed response can briefly retain
 * the previous `result_pending` marker; do not present that stale marker as
 * the current phase.
 */
export function visibleRecoveryPhase(diagnostics: DispatchDiagnostics): string | null {
  if (diagnostics.state === "completed" && diagnostics.phase === "result_pending") return null;
  return diagnostics.phase || null;
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

export function bridgeBuildState(
  status?: BridgeStatusSummary | null,
  local?: BridgeLocalStatusSummary | null,
): "current" | "outdated" | "unknown" {
  if (local && local.available !== true) return "unknown";
  if (!status) return "unknown";
  const version = local?.extensionVersion || status.extensionVersion;
  const buildId = local?.extensionBuildId || status.extensionBuildId;
  if (!version && !buildId) return "unknown";
  if (!bridgeVersionAtLeast(version)) return "outdated";
  if (!buildId || !status.extensionBuildId || !status.extensionCapabilities || !status.serverCapabilities) return "unknown";
  if (status.extensionVersion && status.extensionVersion !== version) return "outdated";
  if (status.extensionBuildId !== buildId) return "outdated";
  return bridgeCapabilityGaps(status.extensionCapabilities, status.serverCapabilities).length === 0 ? "current" : "outdated";
}

export function lifecycleStatus(
  diagnostics: DispatchDiagnostics,
  bridge?: BridgeStatusSummary | null,
  local?: BridgeLocalStatusSummary | null,
): string {
  if (bridgeBuildState(bridge, local) === "outdated") return "Bridge compatibility issue";
  if (diagnostics.errorCode && /content|bridge|transport|extension|channel|lease|claim|delivery/i.test(diagnostics.errorCode)) return "Bridge transport failed; retrying";
  if (diagnostics.state === "queued" && !diagnostics.lifecycle.extension_hint_received_at) return "Waiting for extension";
  if (diagnostics.phase === "recovering_stale_chatgpt_tab") return "Recovering stale ChatGPT tab";
  if (diagnostics.state === "sent" || diagnostics.state === "acknowledged_by_mcp" || diagnostics.state === "running") {
    if (diagnostics.lifecycle.response_detected_at && !diagnostics.lifecycle.response_uploaded_at) return "Response captured; retrying upload";
    return "Message sent; waiting for ChatGPT";
  }
  // The state transition is authoritative. Lifecycle writes are queued
  // separately for observability, so a status read can briefly contain the
  // terminal state alongside the previous result_pending marker.
  if (diagnostics.state === "completed") return "Completed";
  if (diagnostics.phase === "result_pending" || (diagnostics.lifecycle.response_detected_at && !diagnostics.lifecycle.response_uploaded_at)) return "Response captured; retrying upload";
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
