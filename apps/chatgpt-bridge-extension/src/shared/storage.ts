import { EXTENSION_VERSION, type BridgeSettings } from "./protocol";

export const DEFAULT_SETTINGS: BridgeSettings = {
  backendUrl: "",
  deviceId: null,
  deviceToken: null,
  boundConversationUrl: null,
  boundProjectName: null,
  boundProjectVerified: false,
  automaticSendEnabled: false,
  activeRequestId: null,
  activeLeaseToken: null,
  activeLeaseExpiresAt: null,
  lastError: null,
  lastDispatchId: null,
  lastDispatchAt: null,
};

export async function getSettings(): Promise<BridgeSettings> {
  const values = await chrome.storage.local.get(null);
  return { ...DEFAULT_SETTINGS, ...values, extensionVersion: EXTENSION_VERSION } as BridgeSettings;
}

export async function saveSettings(patch: Partial<BridgeSettings>) {
  await chrome.storage.local.set(patch);
  return getSettings();
}

export async function clearCredentials() {
  await chrome.storage.local.remove(["backendUrl", "deviceId", "deviceToken", "boundConversationUrl", "boundProjectName", "boundProjectVerified", "automaticSendEnabled", "activeRequestId", "activeLeaseToken", "activeLeaseExpiresAt", "lastError", "lastDispatchId", "lastDispatchAt"]);
}
