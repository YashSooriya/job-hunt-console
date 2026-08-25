import { CONVERSATION_SLOT_DEFINITIONS, EXTENSION_VERSION, type BridgeSettings, type ConversationSlot } from "./protocol";

export const DEFAULT_SETTINGS: BridgeSettings = {
  backendUrl: "",
  deviceId: null,
  deviceToken: null,
  projectUrl: null,
  conversationSlots: [],
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
  workflowSetup: { state: "idle", completedKeys: [], currentKey: null, pendingConversationUrl: null, error: null },
};

export async function getSettings(): Promise<BridgeSettings> {
  const values = await chrome.storage.local.get(null);
  const settings = { ...DEFAULT_SETTINGS, ...values, extensionVersion: EXTENSION_VERSION } as BridgeSettings;
  // Upgrade the pre-slot extension without forcing the user to bind the
  // already-working conversation again. The legacy binding is retained as a
  // diagnostic slot until the user rotates or replaces it.
  if ((!Array.isArray(settings.conversationSlots) || settings.conversationSlots.length === 0) && settings.boundConversationUrl) {
    const legacy: ConversationSlot = {
      workflowKey: "bridge.diagnostic",
      displayName: CONVERSATION_SLOT_DEFINITIONS.find((slot) => slot.key === "bridge.diagnostic")?.label || "Bridge diagnostic",
      conversationUrl: settings.boundConversationUrl,
      projectName: settings.boundProjectName || "Job Hunt",
      projectVerified: settings.boundProjectVerified === true,
    };
    settings.conversationSlots = [legacy];
    await chrome.storage.local.set({ conversationSlots: settings.conversationSlots });
  }
  if (!Array.isArray(settings.conversationSlots)) settings.conversationSlots = [];
  if (!settings.workflowSetup || typeof settings.workflowSetup !== "object") settings.workflowSetup = DEFAULT_SETTINGS.workflowSetup;
  return settings;
}

export async function saveSettings(patch: Partial<BridgeSettings>) {
  await chrome.storage.local.set(patch);
  return getSettings();
}

export async function clearCredentials() {
  await chrome.storage.local.remove(["backendUrl", "deviceId", "deviceToken", "projectUrl", "conversationSlots", "boundConversationUrl", "boundProjectName", "boundProjectVerified", "automaticSendEnabled", "activeRequestId", "activeLeaseToken", "activeLeaseExpiresAt", "lastError", "lastDispatchId", "lastDispatchAt", "workflowSetup"]);
}
