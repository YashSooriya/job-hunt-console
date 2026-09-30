import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { parseJobUrlInspectionBatchResponse, parseJobUrlInspectionResponse } from "./job-url-inspection-response.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-chatgpt-bridge-device-id, x-chatgpt-bridge-device-token, x-chatgpt-bridge-version",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const V2_CAPABILITY_NAMES = ["durable_dispatch_v2", "send_authorization_v2", "result_outbox_v1"] as const;

// These describe the deployed Edge Function/database contract, not the
// browser's advertised capabilities. The extension uses them to fail closed
// before claiming a request when an older free-tier deployment is still live.
const SERVER_CAPABILITIES = {
  result_completion_v3: true,
  response_provenance_v3: true,
  reset_reconciliation_v1: true,
} as const;

function supportsV2Device(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  const capabilities = device.capabilities && typeof device.capabilities === "object" && !Array.isArray(device.capabilities)
    ? device.capabilities as Record<string, unknown>
    : {};
  return Number(capabilities.protocol_version) >= 2
    && V2_CAPABILITY_NAMES.every((name) => capabilities[name] === true)
    && Number(capabilities.concurrent_response_capture) >= 2;
}

function supportsResultCompletionV3Device(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  const capabilities = device.capabilities && typeof device.capabilities === "object" && !Array.isArray(device.capabilities)
    ? device.capabilities as Record<string, unknown>
    : {};
  return capabilities.result_completion_v3 === true && capabilities.response_provenance_v3 === true;
}

function deviceWithProtocol(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const device = value as Record<string, unknown>;
  return { ...device, server_capabilities: SERVER_CAPABILITIES, protocol: supportsV2Device(device) ? "v2" : "v1" };
}

const V2_OPERATIONS = new Set([
  "device_poll_v2",
  "get_active_dispatches",
  "get_rollout_telemetry",
  "claim_dispatch_v2",
  "authorize_send",
  "get_dispatch_v2",
  "record_send_anchor",
  "prepare_dispatch_v2",
  "confirm_sent",
  "defer_dispatch",
  "touch_dispatch_v2",
  "complete_dispatch_v2",
  "complete_dispatch_v3",
  "complete_reused_dispatch_v2",
  "complete_reused_dispatch_v3",
  "reopen_response_capture",
  "stop_dispatch_v2",
]);

const TURN_ANCHOR_KEYS = new Set([
  "conversationUrl",
  "turnCount",
  "lastUserFingerprint",
  "lastAssistantFingerprint",
  "lastUserMessageId",
  "lastAssistantMessageId",
  "artifactCount",
  "artifactKeys",
]);

function boundedTurnAnchor(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The dispatch turn anchor must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !TURN_ANCHOR_KEYS.has(key))) throw new Error("The dispatch turn anchor contains an unsupported field.");
  if (typeof input.conversationUrl !== "string" || input.conversationUrl.length < 1 || input.conversationUrl.length > 500) throw new Error("The dispatch turn anchor conversation URL is invalid.");
  if (typeof input.turnCount !== "number" || !Number.isInteger(input.turnCount) || input.turnCount < 0 || input.turnCount > 10000) throw new Error("The dispatch turn anchor turn count is invalid.");
  for (const key of ["lastUserFingerprint", "lastAssistantFingerprint"] as const) {
    if (typeof input[key] !== "string" || input[key].length > 200) throw new Error("The dispatch turn anchor fingerprint is invalid.");
  }
  for (const key of ["lastUserMessageId", "lastAssistantMessageId"] as const) {
    if (input[key] !== null && input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 300)) throw new Error("The dispatch turn anchor message id is invalid.");
  }
  if (input.artifactCount !== undefined && (typeof input.artifactCount !== "number" || !Number.isInteger(input.artifactCount) || input.artifactCount < 0 || input.artifactCount > 1000)) throw new Error("The dispatch turn anchor artifact count is invalid.");
  if (input.artifactKeys !== undefined && (!Array.isArray(input.artifactKeys) || input.artifactKeys.length > 1000 || input.artifactKeys.some((key) => typeof key !== "string" || key.length > 1000))) throw new Error("The dispatch turn anchor artifact keys are invalid.");
  const normalized = {
    conversationUrl: input.conversationUrl,
    turnCount: input.turnCount,
    lastUserFingerprint: input.lastUserFingerprint,
    lastAssistantFingerprint: input.lastAssistantFingerprint,
    lastUserMessageId: input.lastUserMessageId ?? null,
    lastAssistantMessageId: input.lastAssistantMessageId ?? null,
    ...(input.artifactCount === undefined ? {} : { artifactCount: input.artifactCount }),
    ...(input.artifactKeys === undefined ? {} : { artifactKeys: input.artifactKeys }),
  };
  if (JSON.stringify(normalized).length > 4000) throw new Error("The dispatch turn anchor is too large.");
  return normalized;
}

function sqlTurnAnchor(anchor: Record<string, unknown> | null) {
  if (!anchor) return null;
  // Artifact identities are a local response-capture fence. The deployed v2
  // SQL functions intentionally accept the older bounded turn shape, so do
  // not pass this optional client-side field through to those RPCs.
  const { artifactKeys: _artifactKeys, ...compatible } = anchor;
  return compatible;
}

const RESPONSE_PROVENANCE_KEYS = new Set([
  "conversationUrl",
  "userTurnFingerprint",
  "userTurnMessageId",
  "assistantMessageId",
  "assistantFingerprint",
  "artifactKey",
  "source",
  "generationFinished",
]);

function boundedResponseProvenance(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Exact-turn response provenance is required.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !RESPONSE_PROVENANCE_KEYS.has(key))) throw new Error("Response provenance contains an unsupported field.");
  if (typeof input.conversationUrl !== "string" || input.conversationUrl.length < 1 || input.conversationUrl.length > 500) throw new Error("The response provenance conversation URL is invalid.");
  if (typeof input.userTurnFingerprint !== "string" || input.userTurnFingerprint.length < 1 || input.userTurnFingerprint.length > 200) throw new Error("The response provenance user-turn fingerprint is invalid.");
  if (input.source !== "assistant_turn" && input.source !== "assistant_artifact") throw new Error("The response provenance source is invalid.");
  if (input.generationFinished !== true) throw new Error("The ChatGPT generation was not finished when the response was captured.");
  for (const key of ["userTurnMessageId", "assistantMessageId", "assistantFingerprint", "artifactKey"] as const) {
    if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== "string" || input[key].length > 500)) throw new Error("The response provenance identity is invalid.");
  }
  if (input.source === "assistant_turn" && typeof input.assistantMessageId !== "string" && typeof input.assistantFingerprint !== "string") throw new Error("Assistant-turn response provenance is missing an assistant identity.");
  if (input.source === "assistant_artifact" && typeof input.artifactKey !== "string") throw new Error("Artifact response provenance is missing an artifact identity.");
  const normalized = {
    conversationUrl: input.conversationUrl,
    userTurnFingerprint: input.userTurnFingerprint,
    userTurnMessageId: input.userTurnMessageId ?? null,
    assistantMessageId: input.assistantMessageId ?? null,
    assistantFingerprint: input.assistantFingerprint ?? null,
    artifactKey: input.artifactKey ?? null,
    source: input.source,
    generationFinished: true,
  };
  if (JSON.stringify(normalized).length > 3000) throw new Error("The response provenance is too large.");
  return normalized;
}

async function authenticateDevice(request: Request, body: Record<string, unknown>) {
  const deviceId = request.headers.get("x-chatgpt-bridge-device-id") || "";
  const token = request.headers.get("x-chatgpt-bridge-device-token") || "";
  const version = request.headers.get("x-chatgpt-bridge-version") || (typeof body.extensionVersion === "string" ? body.extensionVersion : null);
  const advertisedCapabilities = body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities)
    ? {
      ...(body.capabilities as Record<string, unknown>),
      protocol_version: body.protocol === 2 || body.protocol === "v2"
        ? 2
        : Number((body.capabilities as Record<string, unknown>).protocol_version) || 1,
    }
    : null;
  if (!uuid(deviceId) || token.length < 40) throw new Error("Missing ChatGPT bridge device credentials.");
  const { data, error } = await supabase.rpc("chatgpt_bridge_service_authenticate_device", {
    p_device_id: deviceId,
    p_token_hash: await sha256(token),
    p_extension_version: version,
    p_capabilities: advertisedCapabilities,
  });
  if (error) throw error;
  if (!data?.id || !data?.user_id) throw new Error("Invalid ChatGPT bridge device credentials.");
  return { deviceId, token, device: data };
}

async function pairDevice(body: Record<string, unknown>) {
  const code = typeof body.pairingCode === "string" ? body.pairingCode.trim().toUpperCase() : "";
  if (!/^[A-F0-9-]{20,40}$/.test(code)) throw new Error("A valid one-time pairing code is required.");
  const rawToken = randomHex(32);
  const displayName = typeof body.displayName === "string" ? body.displayName.slice(0, 160) : "JobHuntAI ChatGPT Bridge";
  const platform = typeof body.platform === "string" ? body.platform.slice(0, 40) : "chrome";
  const extensionVersion = typeof body.extensionVersion === "string" ? body.extensionVersion.slice(0, 40) : null;
  const capabilities = body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities)
    ? { ...(body.capabilities as Record<string, unknown>), protocol_version: body.protocol === 2 || body.protocol === "v2" ? 2 : Number((body.capabilities as Record<string, unknown>).protocol_version) || 1 }
    : { protocol_version: body.protocol === 2 || body.protocol === "v2" ? 2 : 1 };
  const { data: device, error } = await supabase.rpc("chatgpt_bridge_service_pair_device", {
    p_code_hash: await sha256(code),
    p_token_hash: await sha256(rawToken),
    p_display_name: displayName,
    p_platform: platform,
    p_extension_version: extensionVersion,
    p_capabilities: capabilities,
  });
  if (error) throw error;
  return { device: { ...(device as Record<string, unknown>), capabilities, server_capabilities: SERVER_CAPABILITIES, protocol: supportsV2Device({ capabilities }) ? "v2" : "v1" }, device_token: rawToken };
}

async function reconcileV2Dispatches(deviceId: string) {
  const { data, error } = await supabase.rpc("chatgpt_bridge_service_reconcile_v2", { p_device_id: deviceId });
  if (error) throw error;
  return data;
}

class RetryableBridgeOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableBridgeOperationError";
  }
}

/**
 * Persist the exact completed v3 job-inspection response independently of
 * whether the /jobs/add page remains open and polls for status. The extension
 * retries the captured response upload on a 503; it never re-sends ChatGPT.
 */
async function persistCapturedJobInspection(requestId: string, responseHash: string) {
  const { data: dispatch, error: dispatchError } = await supabase
    .from("chatgpt_dispatch_requests")
    .select("id,user_id,action_type,state,subject_refs,bridge_response,response_hash,response_provenance,output_refs")
    .eq("id", requestId)
    .maybeSingle();
  if (dispatchError) throw new RetryableBridgeOperationError("The captured ChatGPT result is safe; the bridge could not read its import record yet.");
  if (!dispatch || dispatch.action_type !== "job.inspect_url") return null;

  const { data: inspections, error: inspectionError } = await supabase
    .from("job_url_inspection_requests")
    .select("id,user_id,batch_id,batch_position,dispatch_request_id")
    .eq("user_id", dispatch.user_id)
    .eq("dispatch_request_id", requestId)
    .order("batch_position", { ascending: true, nullsFirst: true });
  if (inspectionError) throw new RetryableBridgeOperationError("The captured ChatGPT result is safe; the bridge could not read the listing-import records yet.");
  if (!Array.isArray(inspections) || inspections.length < 1 || inspections.length > 10) {
    throw new RetryableBridgeOperationError("The captured ChatGPT result is safe; its listing-import records are still being linked.");
  }

  let parsed: ReturnType<typeof parseJobUrlInspectionBatchResponse> | null = null;
  let parseFailure = "ChatGPT's listing response was not one valid JSON object.";
  if (typeof dispatch.bridge_response === "string") {
    try {
      parsed = parseJobUrlInspectionBatchResponse(dispatch.bridge_response, inspections.map((inspection) => inspection.id));
    } catch (cause) {
      parseFailure = cause instanceof Error ? cause.message : parseFailure;
      // Keep the already-established single-listing schema compatible with
      // dispatched jobs created before bulk import was introduced.
      if (inspections.length === 1) {
        try {
          parsed = new Map([[inspections[0].id, {
            requestId: inspections[0].id,
            status: "found",
            extraction: parseJobUrlInspectionResponse(dispatch.bridge_response, inspections[0].id),
          }]]);
        } catch (singleCause) {
          parseFailure = singleCause instanceof Error ? singleCause.message : parseFailure;
        }
      }
    }
  }

  const writes = await Promise.allSettled(inspections.map(async (inspection) => {
    const result = parsed?.get(inspection.id);
    const resultStatus = result?.status || "invalid_response";
    const message = resultStatus === "found"
      ? null
      : resultStatus === "invalid_response"
        ? `${parseFailure} The original ChatGPT message was not resent.`
        : `${result?.reason || "ChatGPT could not verify this listing."} The original ChatGPT message was not resent.`;
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_apply_job_url_inspection_v3", {
      p_dispatch_id: requestId,
      p_request_id: inspection.id,
      p_response_hash: responseHash,
      p_result_status: resultStatus,
      p_extraction: resultStatus === "found" ? result?.extraction : null,
      p_message: message,
    });
    if (error) throw error;
    if (!data || typeof data !== "object" || (data as Record<string, unknown>).status !== (resultStatus === "found" ? "completed" : "failed")) {
      throw new Error("The database did not confirm the listing import result.");
    }
    return data;
  }));
  const failedWrites = writes.filter((result) => result.status === "rejected");
  if (failedWrites.length) {
    // Keep the bridge response HTTP-retryable. The v3 dispatch is already
    // complete and its response hash is idempotent, so the next attempt only
    // retries these database writes from the same captured response.
    throw new RetryableBridgeOperationError("The captured ChatGPT result is safe; saving it into the job pool will be retried without resending the original message.");
  }
  return { persisted: writes.length, response_hash: responseHash };
}

async function deviceOperation(request: Request, body: Record<string, unknown>) {
  const auth = await authenticateDevice(request, body);
  const op = typeof body.op === "string" ? body.op : "";
  if (V2_OPERATIONS.has(op) && !supportsV2Device(auth.device)) throw new Error("This bridge device does not advertise the v2 capabilities required for this operation.");
  if (["device_poll", "device_poll_v2", "claim_dispatch", "claim_dispatch_v2"].includes(op)
    && supportsV2Device(auth.device)
    && !supportsResultCompletionV3Device(auth.device)) {
    throw new Error("This bridge device must be updated to the v3 result-completion contract before it can claim ChatGPT requests.");
  }
  if (op === "device_heartbeat") return { ok: true, device: deviceWithProtocol(auth.device) };
  if (op === "device_poll") {
    if (auth.device.automatic_send_enabled !== true || !Array.isArray(auth.device.conversations) || auth.device.conversations.length === 0) {
      return { ok: true, request: null, ready: false, reason: "set_up_workflow_conversations_and_enable_automatic_send", protocol: "v1" };
    }
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_claim_dispatch", { p_device_id: auth.deviceId, p_request_id: null });
    if (error) throw error;
    return { ok: true, ...data, ready: true, protocol: "v1" };
  }
  if (op === "device_poll_v2") {
    await reconcileV2Dispatches(auth.deviceId);
    if (!auth.device.automatic_send_enabled || !Array.isArray(auth.device.conversations) || auth.device.conversations.length === 0) {
      return { ok: true, request: null, ready: false, reason: "set_up_workflow_conversations_and_enable_automatic_send", protocol: "v2" };
    }
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_claim_dispatch_v2", { p_device_id: auth.deviceId, p_request_id: null });
    if (error) throw error;
    return { ok: true, ...data, ready: true, protocol: "v2" };
  }
  if (op === "get_active_dispatch") {
    if (!uuid(body.requestId)) throw new Error("A valid dispatch request id is required.");
    const { data: dispatch, error: dispatchError } = await supabase
      .from("chatgpt_dispatch_requests")
      .select("id, action_type, display_title, state, manual_instruction, correlation_id, target_device_id, lease_expires_at, sent_at")
      .eq("id", body.requestId)
      .eq("user_id", auth.device.user_id)
      .eq("target_device_id", auth.deviceId)
      .maybeSingle();
    if (dispatchError) throw dispatchError;
    const slot = Array.isArray(auth.device.conversations)
      ? auth.device.conversations.find((conversation: any) => conversation?.workflow_key === dispatch?.action_type && conversation?.active !== false)
      : null;
    // Only return an already-sent request. The recovery caller has no safe
    // way to know whether a pre-send click completed after a worker restart;
    // those cases remain a user-required stop rather than an automatic resend.
    if (!dispatch || dispatch.state !== "sent" || !dispatch.sent_at || !slot?.conversation_url) return { ok: true, dispatch: null };
    return {
      ok: true,
      dispatch: {
        id: dispatch.id,
        workflow_key: dispatch.action_type,
        display_title: dispatch.display_title,
        instruction: dispatch.manual_instruction,
        correlation_id: dispatch.correlation_id,
        bound_conversation_url: slot.conversation_url,
        bound_project_name: slot.project_name || "JobHuntAI",
        bound_project_verified: slot.project_verified === true,
        lease_expires_at: dispatch.lease_expires_at,
        sent_at: dispatch.sent_at,
      },
    };
  }
  if (op === "get_active_dispatches") {
    await reconcileV2Dispatches(auth.deviceId);
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_get_active_dispatches", { p_device_id: auth.deviceId });
    if (error) throw error;
    return { ok: true, ...(data && typeof data === "object" && !Array.isArray(data) ? data : { dispatches: [] }), protocol: "v2" };
  }
  if (op === "get_rollout_telemetry") {
    // Reconcile this device before measuring the gate so an expired v2 lease
    // is moved to its explicit terminal/manual-review state first. The RPC
    // returns bounded operational metadata only; it never exposes an
    // instruction, captured response, lease token, or token hash.
    await reconcileV2Dispatches(auth.deviceId);
    const since = typeof body.since === "string" && !Number.isNaN(Date.parse(body.since))
      ? new Date(body.since).toISOString()
      : null;
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_get_rollout_telemetry", {
      p_device_id: auth.deviceId,
      p_since: since,
    });
    if (error) throw error;
    return { ok: true, telemetry: data, protocol: "v2" };
  }
  if (op === "claim_dispatch") {
    if (!auth.device.automatic_send_enabled || !Array.isArray(auth.device.conversations) || auth.device.conversations.length === 0) throw new Error("Set up at least one workflow conversation and enable Automatic Send first.");
    if (!uuid(body.requestId)) throw new Error("A valid dispatch request id is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_claim_dispatch", { p_device_id: auth.deviceId, p_request_id: body.requestId });
    if (error) throw error;
    if (data?.request?.id && data.request.id !== body.requestId) return { ok: false, error: "The requested dispatch is not the next leased request." };
    return { ok: true, ...data };
  }
  if (op === "claim_dispatch_v2") {
    if (!auth.device.automatic_send_enabled || !Array.isArray(auth.device.conversations) || auth.device.conversations.length === 0) throw new Error("Set up at least one workflow conversation and enable Automatic Send first.");
    if (!uuid(body.requestId)) throw new Error("A valid dispatch request id is required.");
    await reconcileV2Dispatches(auth.deviceId);
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_claim_dispatch_v2", { p_device_id: auth.deviceId, p_request_id: body.requestId });
    if (error) throw error;
    if (data?.request?.id && data.request.id !== body.requestId) return { ok: false, error: "The requested dispatch is not the next leased request." };
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "authorize_send") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const turnAnchor = boundedTurnAnchor(body.turnAnchor);
    if (!turnAnchor) throw new Error("A durable ChatGPT turn anchor is required before Send.");
    const userTurnFingerprint = typeof body.userTurnFingerprint === "string" ? body.userTurnFingerprint.slice(0, 200) : null;
    const userTurnMessageId = typeof body.userTurnMessageId === "string" ? body.userTurnMessageId.slice(0, 300) : null;
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_authorize_send_v2", {
      p_device_id: auth.deviceId,
      p_request_id: body.requestId,
      p_lease_token_hash: await sha256(body.leaseToken),
      p_attempt_id: body.deliveryAttemptId,
      p_turn_anchor: sqlTurnAnchor(turnAnchor),
      p_user_turn_fingerprint: userTurnFingerprint,
      p_user_turn_message_id: userTurnMessageId,
    });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "get_dispatch_v2") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_get_dispatch_v2", {
      p_device_id: auth.deviceId,
      p_request_id: body.requestId,
      p_lease_token_hash: await sha256(body.leaseToken),
      p_attempt_id: body.deliveryAttemptId,
    });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "record_send_anchor") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const turnAnchor = boundedTurnAnchor(body.turnAnchor);
    const userTurnFingerprint = typeof body.userTurnFingerprint === "string" ? body.userTurnFingerprint.slice(0, 200) : null;
    const userTurnMessageId = typeof body.userTurnMessageId === "string" ? body.userTurnMessageId.slice(0, 300) : null;
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_record_send_anchor", {
      p_device_id: auth.deviceId,
      p_request_id: body.requestId,
      p_lease_token_hash: await sha256(body.leaseToken),
      p_attempt_id: body.deliveryAttemptId,
      p_turn_anchor: sqlTurnAnchor(turnAnchor),
      p_user_turn_fingerprint: userTurnFingerprint,
      p_user_turn_message_id: userTurnMessageId,
    });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "record_dispatch_lifecycle") {
    if (!uuid(body.requestId)) throw new Error("A valid dispatch request id is required.");
    const lifecycle = body.lifecycle && typeof body.lifecycle === "object" && !Array.isArray(body.lifecycle)
      ? body.lifecycle
      : {};
    const leaseToken = typeof body.leaseToken === "string" && body.leaseToken.length >= 40 ? body.leaseToken : null;
    const deliveryAttemptId = uuid(body.deliveryAttemptId) ? body.deliveryAttemptId : null;
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_record_dispatch_lifecycle", {
      p_device_id: auth.deviceId,
      p_request_id: body.requestId,
      p_lease_token_hash: leaseToken ? await sha256(leaseToken) : null,
      p_attempt_id: deliveryAttemptId,
      p_lifecycle: lifecycle,
    });
    if (error) throw error;
    return { ok: true, ...data };
  }
  if (op === "prepare_dispatch_v2") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const stage = typeof body.stage === "string" ? body.stage : "";
    const progress = body.progress && typeof body.progress === "object" && !Array.isArray(body.progress) ? body.progress : {};
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_prepare_dispatch_v2", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId, p_stage: stage, p_progress: progress });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "confirm_sent") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_confirm_sent", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "defer_dispatch") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_defer_dispatch", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId, p_delay_seconds: Number(body.delaySeconds) || 15, p_reason: typeof body.reason === "string" ? body.reason.slice(0, 120) : "deferred" });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "touch_dispatch_v2") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_touch_dispatch_v2", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "update_dispatch") {
    if (!uuid(body.requestId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid dispatch lease is required.");
    const state = typeof body.state === "string" ? body.state : "";
    const progress = body.progress && typeof body.progress === "object" && !Array.isArray(body.progress) ? body.progress : {};
    const safeError = body.error && typeof body.error === "object" && !Array.isArray(body.error) ? body.error : null;
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_update_dispatch", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_state: state, p_progress: progress, p_error: safeError });
    if (error) throw error;
    return { ok: true, ...data };
  }
  if (op === "touch_dispatch") {
    if (!uuid(body.requestId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid dispatch lease is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_touch_dispatch", {
      p_device_id: auth.deviceId,
      p_request_id: body.requestId,
      p_lease_token_hash: await sha256(body.leaseToken),
    });
    if (error) throw error;
    return { ok: true, ...data };
  }
  if (op === "complete_dispatch") {
    if (!uuid(body.requestId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid dispatch lease is required.");
    if (typeof body.responseText !== "string" || body.responseText.trim().length < 1 || body.responseText.length > 100000) throw new Error("A bounded ChatGPT response is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_complete_dispatch", {
      p_device_id: auth.deviceId,
      p_request_id: body.requestId,
      p_lease_token_hash: await sha256(body.leaseToken),
      p_response_text: body.responseText,
    });
    if (error) throw error;
    return { ok: true, ...data };
  }
  if (op === "complete_dispatch_v2") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    if (typeof body.responseText !== "string" || body.responseText.trim().length < 1 || body.responseText.length > 100000) throw new Error("A bounded ChatGPT response is required.");
    const responseHash = await sha256(body.responseText.trim());
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_complete_dispatch_v2", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId, p_response_text: body.responseText, p_response_hash: responseHash });
    if (error) throw error;
    return { ok: data?.accepted !== false, ...data, protocol: "v2", response_hash: responseHash };
  }
  if (op === "complete_dispatch_v3") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    if (typeof body.responseText !== "string" || body.responseText.trim().length < 1 || body.responseText.length > 100000) throw new Error("A bounded ChatGPT response is required.");
    const responseHash = await sha256(body.responseText.trim());
    const responseProvenance = boundedResponseProvenance(body.responseProvenance);
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_complete_dispatch_v3", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId, p_response_text: body.responseText, p_response_hash: responseHash, p_response_provenance: responseProvenance });
    if (error) throw error;
    const jobImport = data?.accepted !== false && data?.state === "completed"
      ? await persistCapturedJobInspection(body.requestId, responseHash)
      : null;
    return { ok: data?.accepted !== false, ...data, protocol: "v3", response_hash: responseHash, job_import: jobImport };
  }
  if (op === "complete_reused_dispatch_v2") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    if (typeof body.responseText !== "string" || body.responseText.trim().length < 1 || body.responseText.length > 100000) throw new Error("A bounded ChatGPT response is required.");
    const responseHash = await sha256(body.responseText.trim());
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_complete_reused_dispatch_v2", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId, p_response_text: body.responseText, p_response_hash: responseHash });
    if (error) throw error;
    return { ok: data?.accepted !== false, ...data, protocol: "v2", response_hash: responseHash };
  }
  if (op === "complete_reused_dispatch_v3") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    if (typeof body.responseText !== "string" || body.responseText.trim().length < 1 || body.responseText.length > 100000) throw new Error("A bounded ChatGPT response is required.");
    const responseHash = await sha256(body.responseText.trim());
    const responseProvenance = boundedResponseProvenance(body.responseProvenance);
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_complete_reused_dispatch_v3", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId, p_response_text: body.responseText, p_response_hash: responseHash, p_response_provenance: responseProvenance });
    if (error) throw error;
    const jobImport = data?.accepted !== false && data?.state === "completed"
      ? await persistCapturedJobInspection(body.requestId, responseHash)
      : null;
    return { ok: data?.accepted !== false, ...data, protocol: "v3", response_hash: responseHash, job_import: jobImport };
  }
  if (op === "reopen_response_capture") {
    if (!uuid(body.requestId)) throw new Error("A valid dispatch request id is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_reopen_response_capture", { p_device_id: auth.deviceId, p_request_id: body.requestId });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "stop_dispatch_v2") {
    if (!uuid(body.requestId) || !uuid(body.deliveryAttemptId) || typeof body.leaseToken !== "string" || body.leaseToken.length < 40) throw new Error("A valid v2 delivery lease is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_stop_dispatch_v2", { p_device_id: auth.deviceId, p_request_id: body.requestId, p_lease_token_hash: await sha256(body.leaseToken), p_attempt_id: body.deliveryAttemptId, p_code: typeof body.code === "string" ? body.code : "user_required", p_message: typeof body.message === "string" ? body.message : "The bridge stopped safely." });
    if (error) throw error;
    return { ok: true, ...data, protocol: "v2" };
  }
  if (op === "retry_dispatch") {
    if (auth.device.automatic_send_enabled !== true || !Array.isArray(auth.device.conversations) || auth.device.conversations.length === 0) throw new Error("Set up at least one workflow conversation and enable Automatic Send before retrying through the bridge.");
    if (!uuid(body.requestId)) throw new Error("A valid dispatch request id is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_retry_dispatch", { p_device_id: auth.deviceId, p_request_id: body.requestId });
    if (error) throw error;
    return { ok: true, ...data };
  }
  if (op === "bind_conversation") {
    const workflowKey = typeof body.workflowKey === "string" ? body.workflowKey : "";
    const conversationUrl = typeof body.conversationUrl === "string" ? body.conversationUrl : "";
    const projectName = typeof body.projectName === "string" ? body.projectName : "";
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_bind_conversation", { p_device_id: auth.deviceId, p_workflow_key: workflowKey, p_conversation_url: conversationUrl, p_project_name: projectName, p_project_verified: body.projectVerified === true });
    if (error) throw error;
    return { ok: true, ...data };
  }
  if (op === "set_automatic_send") {
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_set_automatic_send", { p_device_id: auth.deviceId, p_enabled: body.enabled === true });
    if (error) throw error;
    return { ok: true, ...data };
  }
  if (op === "prefer_device") {
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_prefer_device", { p_device_id: auth.deviceId });
    if (error) throw error;
    return { ok: true, ...data };
  }
  throw new Error("Unsupported ChatGPT bridge operation.");
}

function publicBridgeError(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const value = error as Record<string, unknown>;
    const message = typeof value.message === "string" ? value.message.trim() : "";
    const details = typeof value.details === "string" ? value.details.trim() : "";
    const code = typeof value.code === "string" ? value.code.trim() : "";
    if (message && code) return `${message} (database error ${code})`.slice(0, 500);
    if (message) return message.slice(0, 500);
    if (details) return details.slice(0, 500);
    if (code) return `Database error ${code}.`;
  }
  return "ChatGPT bridge operation failed.";
}

const TERMINAL_AUTH_ERROR_CODES = new Set([
  "device_credentials_invalid",
  "device_revoked",
  "membership_revoked",
]);

function bridgeErrorCode(operation: string, message: string) {
  const value = message.toLowerCase();
  if (operation === "pair_device" && /pairing|one-time code/.test(value)) return "pairing_invalid";
  if (/missing .*device credentials|invalid .*device credentials|device credentials/.test(value)) return "device_credentials_invalid";
  if (/(?:device|bridge).*(?:revoked|disabled|inactive)|(?:revoked|disabled|inactive).*(?:device|bridge)/.test(value)) return "device_revoked";
  // Match the application-level membership guard, not arbitrary database
  // identifiers such as assert_active_app_membership. A permission/schema
  // failure must remain a retryable bridge operation error; it must never
  // cause a valid browser credential to be discarded.
  if (/active job hunt console membership required|membership required|account .*disabled|user .*inactive|profile .*disabled/.test(value)) return "membership_revoked";
  return "bridge_operation_failed";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "POST required." }, 405);
  let operation = "unknown";
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    operation = typeof body.op === "string" && body.op.trim() ? body.op.trim() : operation;
    if (body.op === "pair_device") return json(await pairDevice(body));
    return json(await deviceOperation(request, body));
  } catch (error) {
    const message = publicBridgeError(error);
    if (error instanceof RetryableBridgeOperationError) {
      return json({ ok: false, error: message, code: "bridge_retryable_error" }, 503);
    }
    const visibleMessage = operation === "unknown" ? message : `Bridge operation ${operation} failed: ${message}`;
    const code = bridgeErrorCode(operation, message);
    return json({ ok: false, error: visibleMessage, code }, TERMINAL_AUTH_ERROR_CODES.has(code) ? 401 : 400);
  }
});
