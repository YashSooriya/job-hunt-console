import { CHATGPT_PROJECT_NAME, CONVERSATION_SLOT_DEFINITIONS, DEFAULT_BRIDGE_ENDPOINT, DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS, EXTENSION_VERSION, MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS, MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS, supportsBridgeV2, type ActiveDispatch, type BridgeCapabilities, type BridgeServerCapabilities, type BridgeSettings, type ConversationSlot } from "./protocol";

export const DEFAULT_SETTINGS: BridgeSettings = {
  backendUrl: DEFAULT_BRIDGE_ENDPOINT,
  deviceId: null,
  deviceToken: null,
  bridgeProtocolVersion: 1,
  bridgeCapabilities: {},
  bridgeServerCapabilities: {},
  projectUrl: null,
  helperWindowId: null,
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
  dispatchRecords: {},
  generationConcurrency: 1,
  generationBackoffUntil: null,
  lastError: null,
  lastHeartbeatAt: null,
  lastHeartbeatError: null,
  lastDispatchId: null,
  lastDispatchAt: null,
  workflowSetup: { state: "idle", completedKeys: [], currentKey: null, pendingConversationUrl: null, error: null },
};

// chrome.storage.local has no transaction for a read-modify-write sequence.
// Serialize every extension storage write so two response captures cannot
// overwrite or resurrect each other's durable dispatch records.
let storageMutationQueue: Promise<unknown> = Promise.resolve();

function enqueueStorageMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const operation = storageMutationQueue.then(mutation);
  storageMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

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
  const bridgeCapabilities: BridgeCapabilities = settings.bridgeCapabilities && typeof settings.bridgeCapabilities === "object" && !Array.isArray(settings.bridgeCapabilities)
    ? settings.bridgeCapabilities
    : {};
  const bridgeServerCapabilities: BridgeServerCapabilities = settings.bridgeServerCapabilities && typeof settings.bridgeServerCapabilities === "object" && !Array.isArray(settings.bridgeServerCapabilities)
    ? settings.bridgeServerCapabilities
    : {};
  const bridgeProtocolVersion: 1 | 2 = supportsBridgeV2(bridgeCapabilities) || Number(settings.bridgeProtocolVersion) >= 2 ? 2 : 1;
  if (settings.bridgeCapabilities !== bridgeCapabilities || settings.bridgeServerCapabilities !== bridgeServerCapabilities || settings.bridgeProtocolVersion !== bridgeProtocolVersion) {
    settings.bridgeCapabilities = bridgeCapabilities;
    settings.bridgeServerCapabilities = bridgeServerCapabilities;
    settings.bridgeProtocolVersion = bridgeProtocolVersion;
    await chrome.storage.local.set({ bridgeCapabilities, bridgeServerCapabilities, bridgeProtocolVersion });
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
  if (!settings.dispatchRecords || typeof settings.dispatchRecords !== "object" || Array.isArray(settings.dispatchRecords)) {
    settings.dispatchRecords = {};
    await chrome.storage.local.set({ dispatchRecords: {} });
  }
  if (settings.activeDispatch?.id && !settings.dispatchRecords[settings.activeDispatch.id]) {
    settings.dispatchRecords[settings.activeDispatch.id] = settings.activeDispatch;
    await chrome.storage.local.set({ dispatchRecords: settings.dispatchRecords });
  }
  const concurrency = Number(settings.generationConcurrency);
  const maximumConcurrency = supportsBridgeV2(settings.bridgeCapabilities) ? 2 : 1;
  const backoffUntil = typeof settings.generationBackoffUntil === "string" ? Date.parse(settings.generationBackoffUntil) : NaN;
  const backoffActive = Number.isFinite(backoffUntil) && backoffUntil > Date.now();
  const desiredConcurrency = backoffActive ? 1 : maximumConcurrency;
  if (!Number.isFinite(concurrency) || concurrency !== desiredConcurrency) {
    settings.generationConcurrency = desiredConcurrency;
    await chrome.storage.local.set({ generationConcurrency: desiredConcurrency });
  }
  if (settings.generationBackoffUntil !== null && settings.generationBackoffUntil !== undefined && typeof settings.generationBackoffUntil !== "string") {
    settings.generationBackoffUntil = null;
    await chrome.storage.local.set({ generationBackoffUntil: null });
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
  return enqueueStorageMutation(async () => {
    await chrome.storage.local.set(patch);
    return getSettings();
  });
}

export function mutateDispatchRecords<T>(
  mutation: (settings: BridgeSettings, records: Record<string, ActiveDispatch>) => Promise<{ patch?: Partial<BridgeSettings>; result: T }> | { patch?: Partial<BridgeSettings>; result: T },
): Promise<T> {
  return enqueueStorageMutation(async () => {
    const settings = await getSettings();
    const records = { ...(settings.dispatchRecords || {}) };
    const outcome = await mutation(settings, records);
    if (outcome.patch && Object.keys(outcome.patch).length > 0) await chrome.storage.local.set(outcome.patch);
    return outcome.result;
  });
}

export async function clearCredentials() {
  // The setup pause is a user preference, not a credential. Keep it when the
  // local pairing is forgotten so an extension upgrade/re-pair does not reset
  // the user's rate-limit choice.
  await enqueueStorageMutation(() => chrome.storage.local.remove(["backendUrl", "deviceId", "deviceToken", "bridgeProtocolVersion", "bridgeCapabilities", "bridgeServerCapabilities", "projectUrl", "helperWindowId", "conversationSlots", "boundConversationUrl", "boundProjectName", "boundProjectVerified", "automaticSendEnabled", "activeRequestId", "activeLeaseToken", "activeLeaseExpiresAt", "activeDispatch", "dispatchRecords", "generationConcurrency", "generationBackoffUntil", "lastError", "lastHeartbeatAt", "lastHeartbeatError", "lastDispatchId", "lastDispatchAt", "workflowSetup"]));
}
