import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

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

async function authenticateDevice(request: Request, body: Record<string, unknown>) {
  const deviceId = request.headers.get("x-chatgpt-bridge-device-id") || "";
  const token = request.headers.get("x-chatgpt-bridge-device-token") || "";
  const version = request.headers.get("x-chatgpt-bridge-version") || (typeof body.extensionVersion === "string" ? body.extensionVersion : null);
  if (!uuid(deviceId) || token.length < 40) throw new Error("Missing ChatGPT bridge device credentials.");
  const { data, error } = await supabase.rpc("chatgpt_bridge_service_authenticate_device", { p_device_id: deviceId, p_token_hash: await sha256(token), p_extension_version: version });
  if (error) throw error;
  if (!data?.id || !data?.user_id) throw new Error("Invalid ChatGPT bridge device credentials.");
  return { deviceId, token, device: data };
}

async function pairDevice(body: Record<string, unknown>) {
  const code = typeof body.pairingCode === "string" ? body.pairingCode.trim().toUpperCase() : "";
  if (!/^[A-F0-9-]{20,40}$/.test(code)) throw new Error("A valid one-time pairing code is required.");
  const rawToken = randomHex(32);
  const displayName = typeof body.displayName === "string" ? body.displayName.slice(0, 160) : "Job Hunt ChatGPT Bridge";
  const platform = typeof body.platform === "string" ? body.platform.slice(0, 40) : "chrome";
  const extensionVersion = typeof body.extensionVersion === "string" ? body.extensionVersion.slice(0, 40) : null;
  const capabilities = body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities) ? body.capabilities : {};
  const { data: device, error } = await supabase.rpc("chatgpt_bridge_service_pair_device", {
    p_code_hash: await sha256(code),
    p_token_hash: await sha256(rawToken),
    p_display_name: displayName,
    p_platform: platform,
    p_extension_version: extensionVersion,
    p_capabilities: capabilities,
  });
  if (error) throw error;
  return { device, device_token: rawToken };
}

async function deviceOperation(request: Request, body: Record<string, unknown>) {
  const auth = await authenticateDevice(request, body);
  const op = typeof body.op === "string" ? body.op : "";
  if (op === "device_heartbeat") return { ok: true, device: auth.device };
  if (op === "device_poll") {
    if (auth.device.automatic_send_enabled !== true || !Array.isArray(auth.device.conversations) || auth.device.conversations.length === 0) {
      return { ok: true, request: null, ready: false, reason: "set_up_workflow_conversations_and_enable_automatic_send" };
    }
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_claim_dispatch", { p_device_id: auth.deviceId, p_request_id: null });
    if (error) throw error;
    return { ok: true, ...data, ready: true };
  }
  if (op === "claim_dispatch") {
    if (!auth.device.automatic_send_enabled || !Array.isArray(auth.device.conversations) || auth.device.conversations.length === 0) throw new Error("Set up at least one workflow conversation and enable Automatic Send first.");
    if (!uuid(body.requestId)) throw new Error("A valid dispatch request id is required.");
    const { data, error } = await supabase.rpc("chatgpt_bridge_service_claim_dispatch", { p_device_id: auth.deviceId, p_request_id: body.requestId });
    if (error) throw error;
    if (data?.request?.id && data.request.id !== body.requestId) return { ok: false, error: "The requested dispatch is not the next leased request." };
    return { ok: true, ...data };
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

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "POST required." }, 405);
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (body.op === "pair_device") return json(await pairDevice(body));
    return json(await deviceOperation(request, body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "ChatGPT bridge operation failed.";
    return json({ error: message }, /credential|pairing|revoked|membership|authentication/i.test(message) ? 401 : 400);
  }
});
