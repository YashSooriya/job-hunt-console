import { getSettings } from "./storage";
import { EXTENSION_VERSION } from "./protocol";

export type BridgeBackendResponse = Record<string, any>;

function endpoint(baseUrl: string) {
  const url = baseUrl.trim().replace(/\/$/, "");
  if (!/^https:\/\/[^/]+(?:\/[^/]+)*$/i.test(url) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^/]*)?$/i.test(url)) throw new Error("The Job Hunt bridge endpoint must be HTTPS (or local development on localhost).");
  return url;
}

export async function pairExtension(input: { backendUrl: string; pairingCode: string; displayName: string }) {
  const response = await fetch(endpoint(input.backendUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-chatgpt-bridge-version": EXTENSION_VERSION },
    body: JSON.stringify({ op: "pair_device", pairingCode: input.pairingCode, displayName: input.displayName, platform: "chrome", extensionVersion: EXTENSION_VERSION, capabilities: { page_bridge: true, chatgpt_ui_adapter: "1.0.0", automatic_send: true } }),
  });
  const body = await response.json().catch(() => ({})) as BridgeBackendResponse;
  if (!response.ok || !body.device?.id || typeof body.device_token !== "string") throw new Error(body.error || "Pairing failed.");
  return { backendUrl: endpoint(input.backendUrl), deviceId: body.device.id as string, deviceToken: body.device_token as string, device: body.device };
}

export async function bridgeCall(op: string, payload: Record<string, unknown> = {}) {
  const settings = await getSettings();
  if (!settings.backendUrl || !settings.deviceId || !settings.deviceToken) throw new Error("The ChatGPT bridge is not paired.");
  const response = await fetch(endpoint(settings.backendUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chatgpt-bridge-device-id": settings.deviceId,
      "x-chatgpt-bridge-device-token": settings.deviceToken,
      "x-chatgpt-bridge-version": EXTENSION_VERSION,
    },
    body: JSON.stringify({ op, extensionVersion: EXTENSION_VERSION, ...payload }),
  });
  const body = await response.json().catch(() => ({})) as BridgeBackendResponse;
  if (!response.ok || body.error) throw new Error(body.error || `Bridge operation ${op} failed.`);
  return body;
}
