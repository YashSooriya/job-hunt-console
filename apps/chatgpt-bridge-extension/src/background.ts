import { bridgeCall, pairExtension } from "./shared/backend-client";
import { clearCredentials, getSettings, saveSettings } from "./shared/storage";
import { EXTENSION_VERSION, isNonEmptyString, isUuid, safeReason, type DispatchHint, type RuntimeMessage } from "./shared/protocol";

const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const BOUND_PROJECT = "Job Hunt";
const inFlight = new Set<string>();

type ClaimedRequest = {
  id: string;
  instruction: string;
  correlation_id?: string;
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
  const storedUrl = settings.boundConversationUrl ? normaliseConversationUrl(settings.boundConversationUrl) : null;
  const serverUrl = normaliseConversationUrl(request.bound_conversation_url);
  if (!storedUrl || !serverUrl || storedUrl !== serverUrl || request.bound_project_name !== BOUND_PROJECT || request.bound_project_verified !== true) {
    await stopForUser(request, "binding_mismatch", "The server dispatch target did not match the locally bound Job Hunt conversation. Nothing was sent.");
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
  if (!settings.automaticSendEnabled || !settings.boundConversationUrl || !settings.boundProjectVerified) return { accepted: false, reason: "Bind the Job Hunt conversation and enable Automatic Send in the extension first." };
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
  if (!settings.deviceId || !settings.deviceToken || !settings.automaticSendEnabled || !settings.boundProjectVerified) return;
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

async function bindCurrentConversation() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: CHATGPT_URL_PATTERNS });
  const tab = tabs[0];
  if (tab?.id === undefined || !tab.url || !supportedChatGptUrl(tab.url)) throw new Error("Open the dedicated Job Hunt Project conversation in the active ChatGPT tab first.");
  if (!(await pingContent(tab.id))) throw new Error("Reload the active ChatGPT conversation so the extension content script can verify it.");
  const response = await chrome.tabs.sendMessage(tab.id, { type: "BIND_CURRENT_CONVERSATION" }) as { ok?: boolean; conversationUrl?: string; projectName?: string; projectVerified?: boolean; reason?: string };
  if (response?.ok !== true || !response.conversationUrl || response.projectName !== BOUND_PROJECT || response.projectVerified !== true) throw new Error(response?.reason || "The Job Hunt Project conversation could not be verified.");
  const bound = await bridgeCall("bind_conversation", { conversationUrl: response.conversationUrl, projectName: response.projectName, projectVerified: true });
  await saveSettings({ boundConversationUrl: bound.bound_conversation_url || response.conversationUrl, boundProjectName: BOUND_PROJECT, boundProjectVerified: true, automaticSendEnabled: false, lastError: null });
  return { ok: true, bound };
}

async function status() {
  const settings = await getSettings();
  return {
    ok: true,
    extensionVersion: EXTENSION_VERSION,
    paired: Boolean(settings.deviceId && settings.deviceToken),
    backendUrl: settings.backendUrl,
    deviceId: settings.deviceId,
    boundConversationUrl: settings.boundConversationUrl,
    boundProjectName: settings.boundProjectName,
    boundProjectVerified: settings.boundProjectVerified,
    automaticSendEnabled: settings.automaticSendEnabled,
    lastError: settings.lastError,
    lastDispatchId: settings.lastDispatchId,
    lastDispatchAt: settings.lastDispatchAt,
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
    await saveSettings({ backendUrl: paired.backendUrl, deviceId: paired.deviceId, deviceToken: paired.deviceToken, boundConversationUrl: null, boundProjectName: null, boundProjectVerified: false, automaticSendEnabled: false, lastError: null });
    try { await bridgeCall("prefer_device"); } catch (error) { await rememberError(`The device paired, but could not become preferred: ${publicError(error)}`); }
    return { ok: true, device: paired.device };
  }
  if (message.type === "FORGET_LOCAL_PAIRING") {
    await clearCredentials();
    return { ok: true };
  }
  if (message.type === "BIND_CURRENT_CONVERSATION") return bindCurrentConversation();
  if (message.type === "SET_AUTOMATIC_SEND") {
    const body = await bridgeCall("set_automatic_send", { enabled: message.enabled });
    await saveSettings({ automaticSendEnabled: message.enabled === true, lastError: null });
    return { ok: true, ...body };
  }
  if (message.type === "OPEN_BOUND_CONVERSATION") {
    const settings = await getSettings();
    if (!settings.boundConversationUrl) throw new Error("Bind a Job Hunt conversation first.");
    await openBoundTab(settings.boundConversationUrl);
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
