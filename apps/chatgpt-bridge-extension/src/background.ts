import { bridgeCall, pairExtension } from "./shared/backend-client";
import { clearCredentials, getSettings, saveSettings } from "./shared/storage";
import { CONVERSATION_SLOT_DEFINITIONS, EXTENSION_VERSION, isNonEmptyString, isUuid, safeReason, type ConversationSlot, type ConversationSlotKey, type DispatchHint, type RuntimeMessage, type WorkflowSetupStatus } from "./shared/protocol";

const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const BOUND_PROJECT = "Job Hunt";
const inFlight = new Set<string>();
let setupInFlight = false;

type ClaimedRequest = {
  id: string;
  instruction: string;
  correlation_id?: string;
  workflow_key: ConversationSlotKey;
  workflow_display_name?: string;
  bound_conversation_url: string;
  bound_project_name: string;
  bound_project_verified: boolean;
  lease_token: string;
  lease_expires_at?: string;
};

type AdapterResult = { ok?: boolean; sent?: boolean; code?: string; reason?: string };

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function normaliseConversationUrl(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function supportedChatGptUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function projectUrlFor(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    const conversationIndex = url.pathname.indexOf("/c/");
    if (conversationIndex > 0) {
      url.pathname = `${url.pathname.slice(0, conversationIndex)}/project`;
      return url.toString().replace(/\/$/, "");
    }
    if (/\/project$/i.test(url.pathname)) return url.toString().replace(/\/$/, "");
    return null;
  } catch {
    return null;
  }
}

function slotFor(settings: Awaited<ReturnType<typeof getSettings>>, workflowKey: ConversationSlotKey) {
  return settings.conversationSlots.find((slot) => slot.workflowKey === workflowKey) || null;
}

function replaceSlot(slots: ConversationSlot[], replacement: ConversationSlot) {
  return [...slots.filter((slot) => slot.workflowKey !== replacement.workflowKey), replacement];
}

function localSlotFromRemote(workflowKey: ConversationSlotKey, value: Record<string, unknown>, fallbackUrl?: string): ConversationSlot | null {
  const conversationUrl = typeof value.conversation_url === "string" ? value.conversation_url : typeof value.bound_conversation_url === "string" ? value.bound_conversation_url : fallbackUrl;
  if (!conversationUrl) return null;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    workflowKey,
    displayName: typeof value.workflow_display_name === "string" ? value.workflow_display_name : CONVERSATION_SLOT_DEFINITIONS.find((slot) => slot.key === workflowKey)?.label || workflowKey,
    conversationUrl,
    projectName: typeof value.project_name === "string" ? value.project_name : BOUND_PROJECT,
    projectVerified: value.project_verified === true || value.bound_project_verified === true,
    boundAt: typeof value.bound_at === "string" ? value.bound_at : null,
    lastUsedAt: typeof value.last_used_at === "string" ? value.last_used_at : null,
    lastDispatchAt: typeof value.last_dispatch_at === "string" ? value.last_dispatch_at : null,
  };
}

function workflowSetupState(patch: Partial<WorkflowSetupStatus>): WorkflowSetupStatus {
  return {
    state: patch.state || "idle",
    completedKeys: patch.completedKeys || [],
    currentKey: patch.currentKey || null,
    pendingConversationUrl: patch.pendingConversationUrl || null,
    error: patch.error || null,
  };
}

function publicError(error: unknown, fallback = "The bridge stopped safely.") {
  return safeReason(error instanceof Error ? error.message : error, fallback);
}

async function rememberError(message: string, requestId?: string) {
  await saveSettings({ lastError: safeReason(message), ...(requestId ? { lastDispatchId: requestId, lastDispatchAt: new Date().toISOString() } : {}) });
}

async function clearActiveLease() {
  await saveSettings({ activeRequestId: null, activeLeaseToken: null, activeLeaseExpiresAt: null });
}

async function findBoundTab(boundUrl: string) {
  const expected = normaliseConversationUrl(boundUrl);
  if (!expected) return null;
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const matches = tabs.filter((tab) => typeof tab.id === "number" && typeof tab.url === "string" && normaliseConversationUrl(tab.url) === expected);
  return matches.find((tab) => tab.active) || matches[0] || null;
}

async function openBoundTab(boundUrl: string) {
  if (!supportedChatGptUrl(boundUrl)) throw new Error("The stored conversation URL is not a supported ChatGPT conversation URL.");
  const existing = await findBoundTab(boundUrl);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  const created = await chrome.tabs.create({ url: boundUrl, active: true });
  if (created.id === undefined) throw new Error("ChatGPT opened without a usable tab id.");
  return created;
}

async function pingContent(tabId: number, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING_CHATGPT_CONTENT" });
      if ((response as { ok?: boolean } | undefined)?.ok === true) return true;
    } catch {
      // The content script may still be loading. Retrying the ping is safe;
      // the actual dispatch message is deliberately sent only once.
    }
    await wait(250);
  }
  return false;
}

async function updateDispatch(requestId: string, leaseToken: string, state: string, progress: Record<string, unknown> = {}, error?: Record<string, unknown>) {
  return bridgeCall("update_dispatch", { requestId, leaseToken, state, progress, ...(error ? { error } : {}) });
}

async function stopForUser(request: ClaimedRequest, code: string, reason: string) {
  const safe = safeReason(reason);
  try {
    await updateDispatch(request.id, request.lease_token, "user_required", { stage: "user_required", code }, { code, message: safe });
  } catch (error) {
    await rememberError(`The bridge could not record user_required (${publicError(error)}). ${safe}`, request.id);
    return { accepted: false, reason: safe };
  }
  await rememberError(safe, request.id);
  await clearActiveLease();
  return { accepted: true, reason: safe };
}

async function executeClaimedRequest(request: ClaimedRequest) {
  if (!isUuid(request.id) || !isNonEmptyString(request.instruction, 2000) || !isNonEmptyString(request.lease_token, 200)) {
    await rememberError("The bridge received an invalid server dispatch lease.", request.id);
    return;
  }
  const settings = await getSettings();
  const slot = slotFor(settings, request.workflow_key);
  const storedUrl = slot ? normaliseConversationUrl(slot.conversationUrl) : null;
  const serverUrl = normaliseConversationUrl(request.bound_conversation_url);
  if (!slot || !storedUrl || !serverUrl || storedUrl !== serverUrl || request.bound_project_name !== BOUND_PROJECT || request.bound_project_verified !== true) {
    await stopForUser(request, "binding_mismatch", `The server dispatch target did not match the locally bound ${request.workflow_display_name || request.workflow_key} Job Hunt conversation. Nothing was sent.`);
    return;
  }
  await saveSettings({ activeRequestId: request.id, activeLeaseToken: request.lease_token, activeLeaseExpiresAt: request.lease_expires_at || null, lastError: null, lastDispatchId: request.id, lastDispatchAt: new Date().toISOString() });
  try {
    await updateDispatch(request.id, request.lease_token, "opening_chatgpt", { stage: "opening_chatgpt" });
  } catch (error) {
    await rememberError(`ChatGPT opened only if already available; the dispatch could not enter opening_chatgpt: ${publicError(error)}`, request.id);
    return;
  }
  let tab: { id?: number };
  try {
    tab = await openBoundTab(serverUrl);
  } catch (error) {
    await stopForUser(request, "conversation_open_failed", publicError(error, "The bound ChatGPT conversation could not be opened."));
    return;
  }
  if (tab.id === undefined || !(await pingContent(tab.id))) {
    await stopForUser(request, "content_script_unavailable", "The ChatGPT bridge content script was not ready. Reload the bound conversation and retry; no automatic resend is safe.");
    return;
  }
  let result: AdapterResult;
  try {
    // This is the only attempt to deliver the instruction. If the response is
    // lost, the bridge records user_required rather than sending again.
    result = await chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_DISPATCH",
      requestId: request.id,
      instruction: request.instruction,
      boundConversationUrl: serverUrl,
      boundProjectName: request.bound_project_name,
    }) as AdapterResult;
  } catch (error) {
    await stopForUser(request, "delivery_uncertain", `The ChatGPT tab did not acknowledge the one-time delivery attempt (${publicError(error)}). Do not resend automatically.`);
    return;
  }
  if (result?.ok !== true || result.sent !== true) {
    await stopForUser(request, result?.code || "adapter_stopped", result?.reason || "The visible ChatGPT controls could not be verified. Nothing was resent.");
    return;
  }
  try {
    await updateDispatch(request.id, request.lease_token, "composer_ready", { stage: "composer_ready", delivery: "verified" });
    await updateDispatch(request.id, request.lease_token, "sent", { stage: "sent", delivery: "verified" });
    await clearActiveLease();
    await saveSettings({ lastError: null, lastDispatchId: request.id, lastDispatchAt: new Date().toISOString() });
  } catch (error) {
    // The UI adapter already verified the exact outgoing message. Do not run
    // the adapter again after an acknowledgement/update timeout.
    await rememberError(`The instruction was verified in ChatGPT, but the server acknowledgement was incomplete (${publicError(error)}). Check dispatch status before retrying.`, request.id);
    await clearActiveLease();
  }
}

async function claimAndExecute(requestId: string) {
  if (!isUuid(requestId)) return { accepted: false, reason: "The dispatch id was invalid." };
  if (inFlight.has(requestId)) return { accepted: true, reason: "This dispatch is already being delivered." };
  const settings = await getSettings();
  if (!settings.deviceId || !settings.deviceToken) return { accepted: false, reason: "Pair the ChatGPT bridge extension first." };
  if (!settings.automaticSendEnabled || settings.conversationSlots.length === 0) return { accepted: false, reason: "Set up at least one Job Hunt workflow conversation and enable Automatic Send in the extension first." };
  inFlight.add(requestId);
  try {
    const body = await bridgeCall("claim_dispatch", { requestId });
    const request = body.request as ClaimedRequest | null | undefined;
    if (!request) return { accepted: false, reason: "The dispatch is not queued for this bridge device." };
    if (request.id !== requestId) return { accepted: false, reason: "The bridge refused a dispatch id mismatch." };
    void executeClaimedRequest(request).catch(async (error) => {
      await rememberError(publicError(error, "The bridge stopped during dispatch delivery."), request.id);
      await clearActiveLease();
    });
    return { accepted: true, reason: "The dispatch was claimed by the bridge." };
  } catch (error) {
    const reason = publicError(error, "The bridge could not claim the dispatch.");
    await rememberError(reason, requestId);
    return { accepted: false, reason };
  } finally {
    // executeClaimedRequest owns the lease and may run after this response;
    // the short-lived set only prevents duplicate claims during acceptance.
    setTimeout(() => inFlight.delete(requestId), 120000);
  }
}

async function pollQueue() {
  const settings = await getSettings();
  if (!settings.deviceId || !settings.deviceToken || !settings.automaticSendEnabled || settings.conversationSlots.length === 0) return;
  try {
    const body = await bridgeCall("device_poll");
    const request = body.request as ClaimedRequest | null | undefined;
    if (request?.id && !inFlight.has(request.id)) {
      inFlight.add(request.id);
      void executeClaimedRequest(request)
        .catch(async (error) => { await rememberError(publicError(error, "The bridge stopped during dispatch delivery."), request.id); await clearActiveLease(); })
        .finally(() => setTimeout(() => inFlight.delete(request.id), 120000));
    }
  } catch (error) {
    await rememberError(publicError(error, "The bridge poll failed."));
  }
}

async function bindCurrentConversation(workflowKey: ConversationSlotKey) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: CHATGPT_URL_PATTERNS });
  const tab = tabs[0];
  if (tab?.id === undefined || !tab.url || !supportedChatGptUrl(tab.url)) throw new Error("Open the dedicated Job Hunt Project conversation in the active ChatGPT tab first.");
  if (!(await pingContent(tab.id))) throw new Error("Reload the active ChatGPT conversation so the extension content script can verify it.");
  const response = await chrome.tabs.sendMessage(tab.id, { type: "BIND_CURRENT_CONVERSATION" }) as { ok?: boolean; conversationUrl?: string; projectName?: string; projectVerified?: boolean; reason?: string };
  if (response?.ok !== true || !response.conversationUrl || response.projectName !== BOUND_PROJECT || response.projectVerified !== true) throw new Error(response?.reason || "The Job Hunt Project conversation could not be verified.");
  const bound = await bridgeCall("bind_conversation", { workflowKey, conversationUrl: response.conversationUrl, projectName: response.projectName, projectVerified: true });
  const settings = await getSettings();
  const slot = localSlotFromRemote(workflowKey, bound as Record<string, unknown>, response.conversationUrl) || {
    workflowKey,
    displayName: CONVERSATION_SLOT_DEFINITIONS.find((definition) => definition.key === workflowKey)?.label || workflowKey,
    conversationUrl: response.conversationUrl,
    projectName: BOUND_PROJECT,
    projectVerified: true,
  };
  await saveSettings({ projectUrl: projectUrlFor(response.conversationUrl), conversationSlots: replaceSlot(settings.conversationSlots, slot), boundConversationUrl: response.conversationUrl, boundProjectName: BOUND_PROJECT, boundProjectVerified: true, automaticSendEnabled: false, lastError: null });
  return { ok: true, bound, workflowKey };
}

async function waitForTabUrl(tabId: number, predicate: (url: string) => boolean, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && predicate(tab.url)) return tab.url;
    } catch {
      return null;
    }
    await wait(150);
  }
  return null;
}

async function prepareProjectTab(settings: Awaited<ReturnType<typeof getSettings>>) {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: CHATGPT_URL_PATTERNS });
  let tab = activeTabs[0];
  if (tab?.id === undefined) {
    if (!settings.projectUrl) throw new Error("Open the Job Hunt Project once in an active ChatGPT tab so the extension can identify this account's Project.");
    tab = await chrome.tabs.create({ url: settings.projectUrl, active: true });
  }
  if (tab.id === undefined) throw new Error("ChatGPT opened without a usable tab id.");
  if (!(await pingContent(tab.id))) throw new Error("Reload the active ChatGPT tab so the extension can verify the Job Hunt Project.");
  const context = await chrome.tabs.sendMessage(tab.id, { type: "VERIFY_PROJECT_CONTEXT" }) as { ok?: boolean; projectUrl?: string; reason?: string };
  if (context?.ok !== true || !context.projectUrl) {
    if (!settings.projectUrl) throw new Error(context?.reason || "Open the Job Hunt Project in ChatGPT before automatic setup.");
    await chrome.tabs.update(tab.id, { url: settings.projectUrl, active: true });
    const loaded = await waitForTabUrl(tab.id, (url) => projectUrlFor(url) === projectUrlFor(settings.projectUrl || ""));
    if (!loaded || !(await pingContent(tab.id))) throw new Error("The stored Job Hunt Project could not be opened safely.");
    const storedContext = await chrome.tabs.sendMessage(tab.id, { type: "VERIFY_PROJECT_CONTEXT" }) as { ok?: boolean; projectUrl?: string; reason?: string };
    if (storedContext?.ok !== true || !storedContext.projectUrl) throw new Error(storedContext?.reason || "The stored ChatGPT Project could not be verified for this account.");
    return { tabId: tab.id, projectUrl: storedContext.projectUrl };
  }
  return { tabId: tab.id, projectUrl: context.projectUrl };
}

async function setUpWorkflowConversations(forceWorkflowKey?: ConversationSlotKey) {
  if (setupInFlight) return { ok: false, reason: "Workflow conversation setup is already running in the background." };
  const initial = await getSettings();
  if (!initial.deviceId || !initial.deviceToken) throw new Error("Pair the ChatGPT bridge extension first.");
  setupInFlight = true;
  const completedKeys = initial.conversationSlots.map((slot) => slot.workflowKey);
  const resumeKey = forceWorkflowKey ? (initial.workflowSetup.currentKey === forceWorkflowKey ? forceWorkflowKey : null) : initial.workflowSetup.currentKey || null;
  const resumePendingConversationUrl = resumeKey ? initial.workflowSetup.pendingConversationUrl || null : null;
  await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys, currentKey: resumeKey, pendingConversationUrl: resumePendingConversationUrl, error: null }), lastError: null });
  try {
    const settings = await getSettings();
    const project = await prepareProjectTab(settings);
    await saveSettings({ projectUrl: project.projectUrl });
    let currentCompleted = [...new Set(completedKeys)];
    for (const definition of CONVERSATION_SLOT_DEFINITIONS) {
      if (forceWorkflowKey ? definition.key !== forceWorkflowKey : currentCompleted.includes(definition.key)) continue;
      const currentSetup = (await getSettings()).workflowSetup;
      const pendingConversationUrl = currentSetup.currentKey === definition.key ? currentSetup.pendingConversationUrl : null;
      await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys: currentCompleted, currentKey: definition.key, pendingConversationUrl, error: null }) });
      let result: { ok?: boolean; conversationUrl?: string; projectName?: string; projectVerified?: boolean; reason?: string };
      if (pendingConversationUrl) {
        result = { ok: true, conversationUrl: pendingConversationUrl, projectName: BOUND_PROJECT, projectVerified: true };
      } else {
        const currentTab = await chrome.tabs.get(project.tabId);
        if (projectUrlFor(currentTab.url || "") !== project.projectUrl) {
          await chrome.tabs.update(project.tabId, { url: project.projectUrl, active: true });
          const loaded = await waitForTabUrl(project.tabId, (url) => projectUrlFor(url) === project.projectUrl);
          if (!loaded) throw new Error(`The Job Hunt Project did not reopen before creating ${definition.label}.`);
          if (!(await pingContent(project.tabId))) throw new Error(`The ChatGPT content adapter was not ready for ${definition.label}.`);
        }
        result = await chrome.tabs.sendMessage(project.tabId, { type: "CREATE_WORKFLOW_CONVERSATION", workflowKey: definition.key, displayName: definition.label, projectUrl: project.projectUrl }) as { ok?: boolean; conversationUrl?: string; projectName?: string; projectVerified?: boolean; reason?: string };
        if (result?.ok === true && result.conversationUrl) {
          await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys: currentCompleted, currentKey: definition.key, pendingConversationUrl: result.conversationUrl, error: null }) });
        }
      }
      if (result?.ok !== true || !result.conversationUrl || result.projectName !== BOUND_PROJECT || result.projectVerified !== true) throw new Error(result?.reason || `The ${definition.label} conversation could not be created safely.`);
      const bound = await bridgeCall("bind_conversation", { workflowKey: definition.key, conversationUrl: result.conversationUrl, projectName: BOUND_PROJECT, projectVerified: true });
      const latest = await getSettings();
      const slot = localSlotFromRemote(definition.key, bound as Record<string, unknown>, result.conversationUrl) || {
        workflowKey: definition.key,
        displayName: definition.label,
        conversationUrl: result.conversationUrl,
        projectName: BOUND_PROJECT,
        projectVerified: true,
      };
      await saveSettings({ projectUrl: project.projectUrl, conversationSlots: replaceSlot(latest.conversationSlots, slot), boundConversationUrl: result.conversationUrl, boundProjectName: BOUND_PROJECT, boundProjectVerified: true, automaticSendEnabled: false });
      currentCompleted = [...new Set([...currentCompleted, definition.key])];
      await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys: currentCompleted, currentKey: null, pendingConversationUrl: null, error: null }) });
    }
    await saveSettings({ workflowSetup: workflowSetupState({ state: "complete", completedKeys: currentCompleted, currentKey: null, pendingConversationUrl: null, error: null }), lastError: null });
    return { ok: true, completedKeys: currentCompleted, rotatedWorkflowKey: forceWorkflowKey || null };
  } catch (error) {
    const reason = publicError(error, "Automatic workflow conversation setup stopped safely.");
    const current = await getSettings();
    await saveSettings({ workflowSetup: workflowSetupState({ state: "partial", completedKeys: current.conversationSlots.map((slot) => slot.workflowKey), currentKey: current.workflowSetup.currentKey || null, pendingConversationUrl: current.workflowSetup.pendingConversationUrl || null, error: reason }), lastError: reason });
    return { ok: false, reason, completedKeys: current.conversationSlots.map((slot) => slot.workflowKey), rotatedWorkflowKey: forceWorkflowKey || null };
  } finally {
    setupInFlight = false;
  }
}

async function status() {
  const settings = await getSettings();
  return {
    ok: true,
    extensionVersion: EXTENSION_VERSION,
    paired: Boolean(settings.deviceId && settings.deviceToken),
    backendUrl: settings.backendUrl,
    deviceId: settings.deviceId,
    projectUrl: settings.projectUrl,
    conversationSlots: settings.conversationSlots,
    boundConversationUrl: settings.boundConversationUrl,
    boundProjectName: settings.boundProjectName,
    boundProjectVerified: settings.boundProjectVerified,
    automaticSendEnabled: settings.automaticSendEnabled,
    lastError: settings.lastError,
    lastDispatchId: settings.lastDispatchId,
    lastDispatchAt: settings.lastDispatchAt,
    workflowSetup: settings.workflowSetup,
  };
}

async function handleMessage(message: RuntimeMessage) {
  if (message.type === "PAGE_DISPATCH_HINT") return claimAndExecute(message.hint.request_id);
  if (message.type === "CHATGPT_CONTENT_READY") {
    const settings = await getSettings();
    if (settings.deviceId && settings.deviceToken) void bridgeCall("device_heartbeat").catch(() => undefined);
    return { ok: true };
  }
  if (message.type === "GET_EXTENSION_STATUS") return status();
  if (message.type === "PAIR_EXTENSION") {
    const paired = await pairExtension({ backendUrl: message.backendUrl, pairingCode: message.pairingCode, displayName: message.displayName });
    await saveSettings({ backendUrl: paired.backendUrl, deviceId: paired.deviceId, deviceToken: paired.deviceToken, projectUrl: null, conversationSlots: [], boundConversationUrl: null, boundProjectName: null, boundProjectVerified: false, automaticSendEnabled: false, workflowSetup: workflowSetupState({ state: "idle", completedKeys: [], currentKey: null, pendingConversationUrl: null, error: null }), lastError: null });
    try { await bridgeCall("prefer_device"); } catch (error) { await rememberError(`The device paired, but could not become preferred: ${publicError(error)}`); }
    return { ok: true, device: paired.device };
  }
  if (message.type === "FORGET_LOCAL_PAIRING") {
    await clearCredentials();
    return { ok: true };
  }
  if (message.type === "BIND_CURRENT_CONVERSATION") return bindCurrentConversation(message.workflowKey);
  if (message.type === "SET_UP_WORKFLOW_CONVERSATIONS") return setUpWorkflowConversations();
  if (message.type === "ROTATE_WORKFLOW_CONVERSATION") return setUpWorkflowConversations(message.workflowKey);
  if (message.type === "SET_AUTOMATIC_SEND") {
    const body = await bridgeCall("set_automatic_send", { enabled: message.enabled });
    await saveSettings({ automaticSendEnabled: message.enabled === true, lastError: null });
    return { ok: true, ...body };
  }
  if (message.type === "OPEN_BOUND_CONVERSATION") {
    const settings = await getSettings();
    const slot = slotFor(settings, message.workflowKey);
    if (!slot) throw new Error(`Set up or bind the ${CONVERSATION_SLOT_DEFINITIONS.find((definition) => definition.key === message.workflowKey)?.label || message.workflowKey} conversation first.`);
    await openBoundTab(slot.conversationUrl);
    return { ok: true };
  }
  if (message.type === "RETRY_DISPATCH") {
    if (!isUuid(message.requestId)) throw new Error("The dispatch id was invalid.");
    await bridgeCall("retry_dispatch", { requestId: message.requestId });
    return claimAndExecute(message.requestId);
  }
  return { ok: false, reason: "Unsupported extension message." };
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender: unknown, sendResponse) => {
  void handleMessage(raw as RuntimeMessage)
    .then((response) => sendResponse(response))
    .catch(async (error) => {
      const reason = publicError(error);
      await rememberError(reason);
      sendResponse({ ok: false, reason });
    });
  return true;
});

async function schedulePoll() {
  await chrome.alarms.create("jobhunt-chatgpt-bridge-poll", { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "jobhunt-chatgpt-bridge-poll") void pollQueue();
});
chrome.runtime.onInstalled.addListener(() => { void schedulePoll(); });
chrome.runtime.onStartup.addListener(() => { void schedulePoll(); void pollQueue(); });
void schedulePoll();
