import { CHATGPT_PROJECT_NAME, CONVERSATION_SLOT_DEFINITIONS, DEFAULT_BRIDGE_ENDPOINT, DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS, EXTENSION_VERSION, MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS, MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS, type BridgeSettings, type ConversationSlot } from "./protocol";

export const DEFAULT_SETTINGS: BridgeSettings = {
  backendUrl: DEFAULT_BRIDGE_ENDPOINT,
  deviceId: null,
  deviceToken: null,
  projectUrl: null,
  conversationSlots: [],
  boundConversationUrl: null,
  boundProjectName: null,
  boundProjectVerified: false,
  automaticSendEnabled: false,
  workflowSetupCooldownSeconds: DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS,
  activeRequestId: null,
  activeLeaseToken: null,
  activeLeaseExpiresAt: null,
  activeDispatch: null,
  lastError: null,
  lastDispatchId: null,
  lastDispatchAt: null,
  workflowSetup: { state: "idle", completedKeys: [], currentKey: null, pendingConversationUrl: null, error: null },
};

export async function getSettings(): Promise<BridgeSettings> {
  const values = await chrome.storage.local.get(null);
  const settings = { ...DEFAULT_SETTINGS, ...values, extensionVersion: EXTENSION_VERSION } as BridgeSettings;
  // Older builds stored an empty endpoint because it relied entirely on a
  // build-time environment variable. Restore the production default on
  // upgrade, but preserve any endpoint the user explicitly configured.
  if (typeof settings.backendUrl !== "string" || !settings.backendUrl.trim() || settings.backendUrl === "__JOB_HUNT_BRIDGE_ENDPOINT__") {
    settings.backendUrl = DEFAULT_BRIDGE_ENDPOINT;
    await chrome.storage.local.set({ backendUrl: DEFAULT_BRIDGE_ENDPOINT });
  }
  const rawCooldown = Number(settings.workflowSetupCooldownSeconds);
  const workflowSetupCooldownSeconds = Number.isFinite(rawCooldown)
    ? Math.min(MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS, Math.max(MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS, Math.round(rawCooldown)))
    : DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS;
  if (settings.workflowSetupCooldownSeconds !== workflowSetupCooldownSeconds) {
    settings.workflowSetupCooldownSeconds = workflowSetupCooldownSeconds;
    await chrome.storage.local.set({ workflowSetupCooldownSeconds });
  }
  // Upgrade the pre-slot extension without forcing the user to bind the
  // already-working conversation again. The legacy binding is retained as a
  // diagnostic slot until the user rotates or replaces it.
  if ((!Array.isArray(settings.conversationSlots) || settings.conversationSlots.length === 0) && settings.boundConversationUrl) {
    const legacy: ConversationSlot = {
      workflowKey: "bridge.diagnostic",
      displayName: CONVERSATION_SLOT_DEFINITIONS.find((slot) => slot.key === "bridge.diagnostic")?.label || "Bridge diagnostic",
      conversationUrl: settings.boundConversationUrl,
      projectName: settings.boundProjectName || CHATGPT_PROJECT_NAME,
      projectVerified: settings.boundProjectVerified === true,
    };
    settings.conversationSlots = [legacy];
    await chrome.storage.local.set({ conversationSlots: settings.conversationSlots });
  }
  if (!Array.isArray(settings.conversationSlots)) settings.conversationSlots = [];
  if (settings.activeDispatch !== null && typeof settings.activeDispatch !== "object") {
    settings.activeDispatch = null;
    await chrome.storage.local.set({ activeDispatch: null });
  }
  const migratedSlots = settings.conversationSlots.map((slot) => slot.projectName !== CHATGPT_PROJECT_NAME ? { ...slot, projectName: CHATGPT_PROJECT_NAME } : slot);
  const migratedBoundProject = settings.boundProjectName && settings.boundProjectName !== CHATGPT_PROJECT_NAME ? CHATGPT_PROJECT_NAME : settings.boundProjectName;
  if (migratedSlots.some((slot, index) => slot !== settings.conversationSlots[index]) || migratedBoundProject !== settings.boundProjectName) {
    settings.conversationSlots = migratedSlots;
    settings.boundProjectName = migratedBoundProject;
    await chrome.storage.local.set({ conversationSlots: migratedSlots, boundProjectName: migratedBoundProject });
  }
  if (!settings.workflowSetup || typeof settings.workflowSetup !== "object") settings.workflowSetup = DEFAULT_SETTINGS.workflowSetup;
  return settings;
}

export async function saveSettings(patch: Partial<BridgeSettings>) {
  await chrome.storage.local.set(patch);
  return getSettings();
}

export async function clearCredentials() {
  // The setup pause is a user preference, not a credential. Keep it when the
  // local pairing is forgotten so an extension upgrade/re-pair does not reset
  // the user's rate-limit choice.
  await chrome.storage.local.remove(["backendUrl", "deviceId", "deviceToken", "projectUrl", "conversationSlots", "boundConversationUrl", "boundProjectName", "boundProjectVerified", "automaticSendEnabled", "activeRequestId", "activeLeaseToken", "activeLeaseExpiresAt", "activeDispatch", "lastError", "lastDispatchId", "lastDispatchAt", "workflowSetup"]);
}
