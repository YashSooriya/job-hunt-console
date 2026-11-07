import { clearCredentials, getSettings } from "./storage";
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION, EXTENSION_VERSION } from "./protocol";
import { isTerminalBridgeAuthCode, readBridgeResponse } from "./backend-response";

export type BridgeBackendResponse = Record<string, any>;

export class BridgeRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

const BRIDGE_REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = BRIDGE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function endpoint(baseUrl: string) {
  const url = baseUrl.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The JobHuntAI bridge endpoint must be HTTPS (or local development on localhost).");
  }
  const secureRemote = parsed.protocol === "https:";
  const localDevelopment = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if ((!secureRemote && !localDevelopment) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("The JobHuntAI bridge endpoint must be HTTPS (or local development on localhost).");
  }
  return url;
}

export async function pairExtension(input: { backendUrl: string; pairingCode: string; displayName: string }) {
  const response = await fetchWithTimeout(endpoint(input.backendUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-chatgpt-bridge-version": EXTENSION_VERSION },
    body: JSON.stringify({
      op: "pair_device",
      pairingCode: input.pairingCode,
      displayName: input.displayName,
      platform: "chrome",
      extensionVersion: EXTENSION_VERSION,
      protocol: BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        page_bridge: true,
        chatgpt_ui_adapter: "2.0.0",
        automatic_send: true,
        response_capture: "2.0.0",
        upgrade_recovery: true,
        ...BRIDGE_CAPABILITIES,
      },
    }),
  }, 30000);
  const body = await readBridgeResponse(response) as BridgeBackendResponse;
  if (!response.ok || !body.device?.id || typeof body.device_token !== "string") throw new Error(body.error || "Pairing failed.");
  return { backendUrl: endpoint(input.backendUrl), deviceId: body.device.id as string, deviceToken: body.device_token as string, device: body.device };
}

export async function bridgeCall(op: string, payload: Record<string, unknown> = {}, timeoutMs = BRIDGE_REQUEST_TIMEOUT_MS) {
  const settings = await getSettings();
  if (!settings.backendUrl || !settings.deviceId || !settings.deviceToken) throw new Error("The ChatGPT bridge is not paired.");
  const response = await fetchWithTimeout(endpoint(settings.backendUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chatgpt-bridge-device-id": settings.deviceId,
      "x-chatgpt-bridge-device-token": settings.deviceToken,
      "x-chatgpt-bridge-version": EXTENSION_VERSION,
    },
    // Advertise the negotiated protocol on every authenticated request. This
    // lets an already-paired device upgrade its server record during the next
    // heartbeat without requiring the user to pair the extension again.
    body: JSON.stringify({
      op,
      extensionVersion: EXTENSION_VERSION,
      protocol: BRIDGE_PROTOCOL_VERSION,
      capabilities: BRIDGE_CAPABILITIES,
      ...payload,
    }),
  }, timeoutMs);
  const body = await readBridgeResponse(response) as BridgeBackendResponse;
  if (!response.ok || body.error) {
    const message = typeof body.error === "string" ? body.error : `Bridge operation ${op} failed.`;
    const code = typeof body.code === "string" ? body.code : null;
    // Only the bridge's explicit terminal auth codes may clear credentials.
    // HTML error pages, transient 401s from a proxy, and older deployments
    // without a code must leave the local pairing intact for recovery.
    if (response.status === 401 && isTerminalBridgeAuthCode(code)) await clearCredentials();
    throw new BridgeRequestError(message, response.status, code);
  }
  return body;
}

export async function bridgeCallV2(op: string, payload: Record<string, unknown> = {}, timeoutMs = BRIDGE_REQUEST_TIMEOUT_MS) {
  return bridgeCall(op, { protocol: "v2", ...payload }, timeoutMs);
}
