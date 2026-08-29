import { bridgeCall, pairExtension } from "./shared/backend-client";
import { clearCredentials, getSettings, saveSettings } from "./shared/storage";
import { CHATGPT_PROJECT_NAME, CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS, CONVERSATION_SLOT_DEFINITIONS, EXTENSION_VERSION, JOBHUNT_PAGE_PORT_NAME, MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS, MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS, PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE, RESPONSE_CHECK_DISPLAY_TITLE, extractStructuredProfileJson, isNonEmptyString, isPlainLanguageWebsiteInstruction, isUuid, safeReason, type ActiveDispatch, type ConversationSlot, type ConversationSlotKey, type DispatchHint, type DispatchResultPayload, type DispatchTiming, type RuntimeMessage, type WorkflowSetupStatus } from "./shared/protocol";

const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const CHATGPT_HOME_URL = "https://chatgpt.com/";
const BOUND_PROJECT = CHATGPT_PROJECT_NAME;
const RECENT_DISPATCH_ERROR_GRACE_MS = 120000;
const STALE_ACTIVE_LEASE_GRACE_MS = 6 * 60 * 1000;
const WORKFLOW_SETUP_RESUME_ALARM = "jobhunt-chatgpt-bridge-workflow-setup-resume";
const WORKFLOW_SETUP_RESUME_PERIOD_MINUTES = 0.5;
const PROJECT_SETUP_BEFORE_OPEN_WAIT_MS = 10000;
const PROJECT_SETUP_AFTER_OPEN_WAIT_MS = 10000;
const SETUP_CONTENT_RETRY_DELAY_MS = 350;
const SETUP_CONTENT_MAX_ATTEMPTS = 3;
// Keep each response-read message short. A single runtime message that stays
// open while ChatGPT thinks for several minutes is vulnerable to an MV3
// service-worker/page-channel reset. The outer loop below keeps the same
// already-sent dispatch alive and only asks the content script to wait again.
const RESPONSE_CAPTURE_POLL_SLICE_MS = 15000;
const RESPONSE_CAPTURE_RETRY_DELAY_MS = 350;
// Initial delivery is deliberately polled through short-lived runtime
// messages. This keeps the worker alive without holding one Chrome message
// channel open across ChatGPT's SPA re-renders.
const DISPATCH_DELIVERY_POLL_INTERVAL_MS = 250;
const DISPATCH_DELIVERY_TIMEOUT_MS = 45000;
const DISPATCH_HINT_QUEUE_RETRY_INTERVAL_MS = 100;
const DISPATCH_SENT_CONFIRMATION_DELAY_MS = 1500;
const DISPATCH_SENT_CONFIRMATION_INTERVAL_MS = 1000;
const DISPATCH_RESULT_INBOX_TTL_MS = 120000;
const DISPATCH_LEASE_TOUCH_INTERVAL_MS = 60000;
const DISPATCH_START_PORT_NAME = `jobhunt-start-dispatch-v1-${EXTENSION_VERSION}`;
const DISPATCH_START_PORT_TIMEOUT_MS = 5000;
const inFlight = new Set<string>();
const responseWaitInFlight = new Set<string>();
// A successful versioned ping proves that the current content script is
// installed in this exact tab and is reporting the expected conversation URL.
// Keep that proof only until Chrome reports a navigation/reload. Warm bound
// conversations can therefore skip the long loading retry loop, while a cold
// tab still goes through the full fail-closed readiness check below.
const contentReadyTabs = new Map<number, { url: string; version: string }>();
let setupInFlight = false;
let setupResumeCheckInFlight = false;
let pollInFlight = false;
let dispatchStartInFlight = false;
let automaticSendEnableInFlight: Promise<void> | null = null;
let queuePollTimer: ReturnType<typeof setTimeout> | null = null;
let queuePollRetryDeadline = 0;
type DispatchResultWaiter = (result: AdapterResult) => void;
const dispatchResultInbox = new Map<string, { result: AdapterResult; expiresAt: number }>();
const dispatchResultWaiters = new Map<string, Set<DispatchResultWaiter>>();

// ChatGPT exposes one mutable UI surface per tab. Keep every operation that
// can navigate, type, click, or read that surface behind one small queue so a
// late response cannot race a new navigation. A browser-wide queue is
// intentionally stronger than a per-tab queue: the bridge has one active
// delivery lease, and it prevents two ChatGPT tabs from stealing focus or
// interleaving setup state.
let chatGptUiOperationTail: Promise<void> = Promise.resolve();
let chatGptUiOperationPending = 0;

type ClaimedRequest = {
  id: string;
  instruction: string;
  correlation_id?: string;
  workflow_key: ConversationSlotKey;
  workflow_display_name?: string;
  display_title?: string;
  bound_conversation_url: string;
  bound_project_name: string;
  bound_project_verified: boolean;
  bound_project_url?: string;
  response_check_only?: boolean;
  lease_token: string;
  lease_expires_at?: string;
};

type AdapterResult = DispatchResultPayload;
type ResponseResult = { ok?: boolean; responseText?: string; artifactJson?: string; code?: string; reason?: string };
type ConversationCheckResult = { ok?: boolean; verified?: boolean; conversationUrl?: string; code?: string; reason?: string };
type WorkflowConversationResult = { ok?: boolean; conversationUrl?: string; projectName?: string; projectVerified?: boolean; setupMessageSent?: boolean; recovered?: boolean; code?: string; reason?: string };
type InitialDeliveryResult = { accepted: boolean; sent?: boolean; tabId?: number; assistantBaseline?: AdapterResult["assistantBaseline"]; existingResponseText?: string; artifactJson?: string; reason?: string };

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireChatGptUiOperation() {
  const previous = chatGptUiOperationTail;
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  chatGptUiOperationTail = previous.then(() => current, () => current);
  chatGptUiOperationPending += 1;
  await previous.catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    chatGptUiOperationPending = Math.max(0, chatGptUiOperationPending - 1);
    releaseCurrent();
    if (chatGptUiOperationPending === 0) scheduleQueuePoll();
  };
}

async function withChatGptUiOperation<T>(operation: () => Promise<T>) {
  const release = await acquireChatGptUiOperation();
  try {
    return await operation();
  } finally {
    release();
  }
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

function looksLikeJobHuntProjectUrl(value: string) {
  try {
    return /-(?:jobhuntai|job-hunt-ai|job-hunt)\/(?:project|c\/)/i.test(new URL(value).pathname);
  } catch {
    return false;
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

function isConversationSlotKey(value: unknown): value is ConversationSlotKey {
  return typeof value === "string" && CONVERSATION_SLOT_DEFINITIONS.some((definition) => definition.key === value);
}

function slotsFromRemoteDevice(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const device = value as Record<string, unknown>;
  if (!Array.isArray(device.conversations)) return [];
  return device.conversations.flatMap((conversation) => {
    if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) return [];
    const record = conversation as Record<string, unknown>;
    if (!isConversationSlotKey(record.workflow_key)) return [];
    const slot = localSlotFromRemote(record.workflow_key, record);
    return slot?.projectVerified ? [slot] : [];
  });
}

async function restoreRemoteDevice(value: unknown) {
  const slots = slotsFromRemoteDevice(value);
  if (!slots.length) return { restored: 0, automaticSendEnabled: false };
  const device = value as Record<string, unknown>;
  const current = await getSettings();
  const projectUrl = slots.map((slot) => projectUrlFor(slot.conversationUrl)).find(Boolean) || current.projectUrl;
  const automaticSendEnabled = device.automatic_send_enabled === true;
  const completedKeys = slots.map((slot) => slot.workflowKey);
  await saveSettings({
    projectUrl,
    conversationSlots: slots,
    boundConversationUrl: slots[0]?.conversationUrl || null,
    boundProjectName: BOUND_PROJECT,
    boundProjectVerified: true,
    automaticSendEnabled,
    workflowSetup: workflowSetupState({ state: completedKeys.length === CONVERSATION_SLOT_DEFINITIONS.length ? "complete" : "idle", completedKeys, currentKey: null, pendingConversationUrl: null, error: null }),
    lastError: null,
  });
  return { restored: slots.length, automaticSendEnabled };
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

function normaliseWorkflowSetupCooldownSeconds(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS || seconds > MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS) {
    throw new Error(`Choose a workflow setup pause from ${MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS} to ${MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS} seconds.`);
  }
  return Math.round(seconds);
}

async function rememberError(message: string, requestId?: string) {
  await saveSettings({ lastError: safeReason(message), ...(requestId ? { lastDispatchId: requestId, lastDispatchAt: new Date().toISOString() } : {}) });
}

async function ensureAutomaticSendEnabled() {
  const settings = await getSettings();
  // The server deliberately requires at least one verified workflow slot
  // before it accepts this operation. Fresh pairing therefore leaves the
  // invariant pending until setup or manual binding has created a slot.
  if (!settings.deviceId || !settings.deviceToken || settings.automaticSendEnabled === true || !settings.conversationSlots.some((slot) => slot.projectVerified === true)) return;
  if (automaticSendEnableInFlight) return automaticSendEnableInFlight;
  automaticSendEnableInFlight = (async () => {
    // Automatic Send is now a bridge invariant, not a user preference. This
    // one-time migration also upgrades devices paired by an older extension
    // version whose server flag was still false.
    await bridgeCall("set_automatic_send", { enabled: true });
    await saveSettings({ automaticSendEnabled: true, lastError: null });
  })();
  try {
    await automaticSendEnableInFlight;
  } finally {
    automaticSendEnableInFlight = null;
  }
}

async function clearActiveLease() {
  await saveSettings({ activeRequestId: null, activeLeaseToken: null, activeLeaseExpiresAt: null, activeDispatch: null });
}

async function findBoundTab(boundUrl: string) {
  const expected = normaliseConversationUrl(boundUrl);
  if (!expected) return null;
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const matches = tabs.filter((tab) => typeof tab.id === "number" && typeof tab.url === "string" && normaliseConversationUrl(tab.url) === expected);
  return matches.find((tab) => tab.active) || matches[0] || null;
}

async function openBoundTab(boundUrl: string, activate = true) {
  if (!supportedChatGptUrl(boundUrl)) throw new Error("The stored conversation URL is not a supported ChatGPT conversation URL.");
  const existing = await findBoundTab(boundUrl);
  if (existing?.id !== undefined) {
    if (activate) await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  const created = await chrome.tabs.create({ url: boundUrl, active: true });
  if (created.id === undefined) throw new Error("ChatGPT opened without a usable tab id.");
  return created;
}

function forgetContentReadyTab(tabId: number) {
  contentReadyTabs.delete(tabId);
}

function rememberContentReadyTab(tabId: number, url: string) {
  const normalised = normaliseConversationUrl(url);
  if (normalised) contentReadyTabs.set(tabId, { url: normalised, version: EXTENSION_VERSION });
}

function cachedContentReady(tabId: number, expectedUrl: string) {
  const expected = normaliseConversationUrl(expectedUrl);
  const cached = contentReadyTabs.get(tabId);
  return Boolean(expected && cached && cached.version === EXTENSION_VERSION && cached.url === expected);
}

async function probeContentReady(tabId: number, expectedUrl: string) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING_CHATGPT_CONTENT_VERSIONED" });
    const ping = response as { ok?: boolean; version?: string; url?: string } | undefined;
    const current = ping?.url ? normaliseConversationUrl(ping.url) : null;
    if (ping?.ok === true && ping.version === EXTENSION_VERSION && current === normaliseConversationUrl(expectedUrl)) {
      rememberContentReadyTab(tabId, current || expectedUrl);
      return true;
    }
  } catch {
    // A missing listener is expected on a cold or recently navigated tab.
  }
  return false;
}

async function ensureContentReady(tabId: number, expectedUrl: string) {
  const expected = normaliseConversationUrl(expectedUrl);
  if (!expected) return false;

  // Probe the existing listener before touching the page. This is the normal
  // warm-tab path: a synchronous versioned ping is cheaper and safer than
  // injecting a second copy of the content script into an already-mounted
  // ChatGPT SPA. The adapter still performs the authoritative conversation,
  // authentication, and composer checks before typing or clicking.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (normaliseConversationUrl(tab.url || "") !== expected) return pingContent(tabId, 30000, expectedUrl);
    if (tab.status !== "loading" && await probeContentReady(tabId, expected)) return true;
    // The listener is missing or reports an older version. Inject the current
    // script once, then let the bounded ping verify its version and URL. The
    // old listener is reloaded only by pingContent when that is necessary.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt.js"] });
  } catch {
    // A newly opened/loading tab or a restricted page may reject immediate
    // injection. The bounded versioned ping below retains the safe fallback.
  }
  forgetContentReadyTab(tabId);
  return pingContent(tabId, 30000, expectedUrl);
}

async function pingContent(tabId: number, timeoutMs = 12000, expectedUrl?: string, reloadAfterInjection = false) {
  const started = Date.now();
  let injectionAttempted = false;
  let reloadedAfterInjection = false;
  const expected = expectedUrl ? normaliseConversationUrl(expectedUrl) : null;
  while (Date.now() - started < timeoutMs) {
    try {
      // Use a version-specific ping so a stale content script left in an
      // already-open ChatGPT tab cannot satisfy the readiness check. If the
      // listener is missing, the first failed attempt below injects the
      // current content script into that tab.
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING_CHATGPT_CONTENT_VERSIONED" });
      const ping = response as { ok?: boolean; version?: string; url?: string } | undefined;
      const current = ping?.url ? normaliseConversationUrl(ping.url) : null;
      if (ping?.ok === true && ping.version === EXTENSION_VERSION && (!expected || current === expected)) {
        if ((reloadAfterInjection || injectionAttempted) && !reloadedAfterInjection) {
          // A current script may have been injected beside an older script in
          // an already-open tab. Reload once so subsequent setup or dispatch
          // messages have exactly one listener; otherwise an older listener
          // could send the same instruction as well.
          reloadedAfterInjection = true;
          await chrome.tabs.reload(tabId);
          continue;
        }
        rememberContentReadyTab(tabId, current || expected || ping.url || "");
        return true;
      }
      if (ping?.ok === true && ping.version !== EXTENSION_VERSION && !reloadedAfterInjection) {
        // An extension reload updates the service worker immediately, but an
        // already-open ChatGPT tab can still contain the previous content
        // script. Reload that bound tab once so the new listener replaces the
        // old one before any dispatch or response check is attempted.
        reloadedAfterInjection = true;
        await chrome.tabs.reload(tabId);
        continue;
      }
    } catch {
      // The content script may still be loading. Retrying the ping is safe;
      // the actual dispatch message is deliberately sent only once.
      if (!injectionAttempted) {
        injectionAttempted = true;
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt.js"] });
        } catch {
          // Restricted pages and older installations may not allow dynamic
          // injection. The bounded retry below preserves the safe stop.
        }
      }
    }
    await wait(250);
  }
  return false;
}

async function sendSetupContentMessage<T>(tabId: number, message: RuntimeMessage, expectedUrl?: string): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < SETUP_CONTENT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message) as T;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= SETUP_CONTENT_MAX_ATTEMPTS) break;
      // Project creation and SPA route changes can unload the content-script
      // listener while it is still trying to answer. Reconnect to the current
      // page and retry the idempotent setup/check request instead of turning
      // that expected navigation into a permanent safe stop.
      await wait(SETUP_CONTENT_RETRY_DELAY_MS);
      await pingContent(tabId, 12000, expectedUrl).catch(() => false);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(publicError(lastError, "The ChatGPT setup message channel closed before it replied."));
}

async function confirmDispatchMessageVisible(tabId: number, request: ClaimedRequest) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "CHECK_DISPATCH_SENT",
      requestId: request.id,
      instruction: request.instruction,
      boundConversationUrl: request.bound_conversation_url,
      boundProjectName: request.bound_project_name,
      boundProjectUrl: request.bound_project_url,
    }) as AdapterResult;
  } catch {
    return null;
  }
}

function dispatchResultFromUnknown(value: unknown): AdapterResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean") return null;
  return result as AdapterResult;
}

function publishDispatchResult(requestId: string, result: AdapterResult, dispatchStartedAtMs?: number) {
  const receivedAt = Date.now();
  const enriched: AdapterResult = {
    ...result,
    timing: {
      ...result.timing,
      result_signal_received_at_ms: typeof dispatchStartedAtMs === "number" && Number.isFinite(dispatchStartedAtMs)
        ? Math.max(0, receivedAt - dispatchStartedAtMs)
        : undefined,
    },
  };
  const entry = { result: enriched, expiresAt: receivedAt + DISPATCH_RESULT_INBOX_TTL_MS };
  dispatchResultInbox.set(requestId, entry);
  setTimeout(() => {
    if (dispatchResultInbox.get(requestId) === entry) dispatchResultInbox.delete(requestId);
  }, DISPATCH_RESULT_INBOX_TTL_MS);
  const waiters = dispatchResultWaiters.get(requestId);
  if (!waiters) return;
  dispatchResultWaiters.delete(requestId);
  for (const waiter of waiters) waiter(enriched);
}

function waitForDispatchResult(requestId: string, timeoutMs: number): Promise<AdapterResult | null> {
  const cached = dispatchResultInbox.get(requestId);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
    dispatchResultInbox.delete(requestId);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AdapterResult | null) => {
      if (settled) return;
      settled = true;
      const waiters = dispatchResultWaiters.get(requestId);
      waiters?.delete(finish);
      if (waiters?.size === 0) dispatchResultWaiters.delete(requestId);
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    const waiters = dispatchResultWaiters.get(requestId) || new Set<DispatchResultWaiter>();
    waiters.add(finish);
    dispatchResultWaiters.set(requestId, waiters);
  });
}

async function waitForDispatchDelivery(tabId: number, request: ClaimedRequest, initialTiming: DispatchTiming = {}, dispatchStartedAtMs?: number) {
  const deadline = Date.now() + DISPATCH_DELIVERY_TIMEOUT_MS;
  const started = Date.now();
  let pollAttempts = 0;
  let firstPollResponseAt: number | null = null;
  let latestTiming: DispatchTiming = { ...initialTiming };
  const signalPromise = waitForDispatchResult(request.id, Math.max(1, deadline - Date.now()));
  const signalOutcomePromise = signalPromise.then((result) => ({ kind: "signal" as const, result }));
  let nextVisibleMessageCheck = started + DISPATCH_SENT_CONFIRMATION_DELAY_MS;
  let consecutiveChannelErrors = 0;
  let lastChannelError: unknown = null;
  while (Date.now() < deadline) {
    pollAttempts += 1;
    const pollPromise = chrome.tabs.sendMessage(tabId, { type: "GET_DISPATCH_DELIVERY", requestId: request.id })
      .then((raw) => ({ kind: "poll" as const, result: raw as AdapterResult, responseAt: Date.now() }))
      .catch((error) => ({ kind: "error" as const, error, responseAt: Date.now() }));
    const outcome = await Promise.race([pollPromise, signalOutcomePromise]);
    if (outcome.kind === "signal") {
      if (outcome.result) {
        const resultAt = Date.now();
        latestTiming = {
          ...latestTiming,
          ...outcome.result.timing,
          delivery_signal_wait_ms: resultAt - started,
          delivery_result_at_ms: dispatchStartedAtMs === undefined ? latestTiming.delivery_result_at_ms : Math.max(0, resultAt - dispatchStartedAtMs),
        };
        return { ...outcome.result, timing: latestTiming };
      }
      break;
    }
    if (outcome.kind === "error") {
      lastChannelError = outcome.error;
      consecutiveChannelErrors += 1;
    } else {
      const { result, responseAt } = outcome;
      firstPollResponseAt ??= responseAt;
      latestTiming = {
        ...latestTiming,
        ...result?.timing,
        delivery_poll_ms: responseAt - started,
        delivery_poll_attempts: pollAttempts,
        delivery_poll_first_response_at_ms: firstPollResponseAt - started,
        delivery_result_at_ms: result?.deliveryPending === true || dispatchStartedAtMs === undefined
          ? latestTiming.delivery_result_at_ms
          : Math.max(0, responseAt - dispatchStartedAtMs),
      };
      consecutiveChannelErrors = 0;
      if (result?.deliveryPending !== true) return { ...result, timing: latestTiming };
    }
    // A ChatGPT SPA reload can briefly remove the listener. A bounded set of
    // read-only retries is safe; starting EXECUTE_DISPATCH again would not
    // be safe because the first operation may already have clicked Send.
    // If the operation result is lost during a ChatGPT SPA update, inspect
    // only the exact user message. This is strictly read-only and therefore
    // safe even when the original operation may already have clicked Send.
    // Once the message is visible, continue with the normal server state and
    // response capture instead of waiting for a result that may never return.
    // The exact-message fallback is intentionally reserved for a broken or
    // recycled runtime channel. On a healthy channel, repeatedly scanning the
    // entire ChatGPT DOM while the adapter is typing/clicking only adds main-
    // thread work and can delay the very render we are waiting to observe.
    if (consecutiveChannelErrors > 0 && Date.now() >= nextVisibleMessageCheck) {
      const visible = await confirmDispatchMessageVisible(tabId, request);
      if (visible?.ok === true && visible.sent === true) return visible;
      nextVisibleMessageCheck = Date.now() + DISPATCH_SENT_CONFIRMATION_INTERVAL_MS;
    }
    await wait(Math.min(DISPATCH_DELIVERY_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  const visible = await confirmDispatchMessageVisible(tabId, request);
  if (visible?.ok === true && visible.sent === true) return visible;
  return {
    ok: false,
    code: "delivery_uncertain",
    reason: lastChannelError
      ? `The ChatGPT delivery result could not be read safely (${publicError(lastChannelError)}). No automatic resend is safe.`
      : "The ChatGPT delivery operation did not finish within the safe delivery window. No automatic resend is safe.",
    timing: {
      ...latestTiming,
      delivery_poll_ms: Date.now() - started,
      delivery_poll_attempts: pollAttempts,
    },
  } as AdapterResult;
}

function startDispatchOverPort(tabId: number, message: Extract<RuntimeMessage, { type: "START_DISPATCH" }>): Promise<AdapterResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();
    const port = chrome.tabs.connect(tabId, { name: DISPATCH_START_PORT_NAME });
    const timer = setTimeout(() => finish(new Error("The ChatGPT delivery port did not acknowledge the one-time delivery attempt.")), DISPATCH_START_PORT_TIMEOUT_MS);
    const finish = (error?: unknown, result?: AdapterResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* The tab may already have navigated. */ }
      if (error) reject(error);
      else resolve(result || { ok: false, code: "delivery_unacknowledged", reason: "The ChatGPT delivery port returned no acknowledgement." });
    };
    port.onMessage.addListener((raw: unknown) => {
      const acknowledgedAt = Date.now();
      const result = raw as AdapterResult;
      finish(undefined, {
        ...result,
        timing: {
          ...result.timing,
          port_ack_wait_ms: acknowledgedAt - startedAt,
          port_ack_at_ms: typeof message.dispatchStartedAtMs === "number" && Number.isFinite(message.dispatchStartedAtMs)
            ? Math.max(0, acknowledgedAt - message.dispatchStartedAtMs)
            : undefined,
        },
      });
    });
    port.onDisconnect.addListener(() => finish(new Error("The ChatGPT delivery port closed before acknowledging the one-time delivery attempt.")));
    try {
      port.postMessage(message);
    } catch (error) {
      finish(error);
    }
  });
}

async function updateDispatch(requestId: string, leaseToken: string, state: string, progress: Record<string, unknown> = {}, error?: Record<string, unknown>) {
  return bridgeCall("update_dispatch", { requestId, leaseToken, state, progress, ...(error ? { error } : {}) });
}

async function touchDispatchLease(request: Pick<ClaimedRequest, "id" | "lease_token">) {
  return bridgeCall("touch_dispatch", { requestId: request.id, leaseToken: request.lease_token });
}

function startDispatchLeaseHeartbeat(request: Pick<ClaimedRequest, "id" | "lease_token">) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    // A failed touch is intentionally ignored here. The normal operation will
    // report the actual lease error, while the server-side expiry remains the
    // safe fallback if the extension or network has disappeared.
    void touchDispatchLease(request).catch(() => undefined);
  }, DISPATCH_LEASE_TOUCH_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function stopForUser(request: ClaimedRequest, code: string, reason: string) {
  const safe = safeReason(reason);
  try {
    await updateDispatch(request.id, request.lease_token, "user_required", { stage: "user_required", code }, { code, message: safe });
  } catch (error) {
    await rememberError(`The bridge could not record user_required (${publicError(error)}). ${safe}`, request.id);
    return { accepted: false, reason: safe };
  } finally {
    // Whether or not the server accepted the safe stop, this local worker no
    // longer owns a usable delivery lease. Clearing it prevents the service
    // worker from blocking later user actions behind a dead in-memory lease;
    // the server-side lease recovery migration preserves at-most-once safety.
    await clearActiveLease();
  }
  await rememberError(safe, request.id);
  return { accepted: true, reason: safe };
}

function expectsStructuredProfileResponse(request: ClaimedRequest) {
  if (request.workflow_key !== "profile.background") return false;
  // Source-context messages deliberately receive ordinary confirmations. The
  // profile interview is the one background task with a machine-readable
  // contract and a JSON artifact.
  return /structured onboarding profile|professional-profile\.json|return exactly one json object/i.test(request.instruction);
}

async function saveProfessionalProfileArtifact(json: string) {
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(`${json}\n`)}`;
  await chrome.downloads.download({
    url,
    filename: "JobHuntAI/professional-profile.json",
    saveAs: false,
    conflictAction: "overwrite",
  });
}

function activeDispatchForRequest(request: ClaimedRequest, sentVerified = false, assistantBaseline?: AdapterResult["assistantBaseline"], boundProjectUrl?: string | null): ActiveDispatch {
  return {
    id: request.id,
    workflowKey: request.workflow_key,
    displayTitle: request.display_title || null,
    instruction: request.instruction,
    boundConversationUrl: request.bound_conversation_url,
    boundProjectUrl: boundProjectUrl || null,
    boundProjectName: request.bound_project_name,
    sentVerified,
    assistantBaseline: assistantBaseline || null,
  };
}

async function persistClaimedLease(request: ClaimedRequest) {
  // Persist the claimed lease before any tab navigation or content-script
  // work. If Chrome suspends the MV3 worker in this narrow window, the local
  // state still identifies an in-progress, not-yet-sent request and the
  // server-side lease expiry can stop it safely without a blind resend.
  await saveSettings({
    activeRequestId: request.id,
    activeLeaseToken: request.lease_token,
    activeLeaseExpiresAt: request.lease_expires_at || null,
    activeDispatch: activeDispatchForRequest(request, false, undefined, request.bound_project_url || projectUrlFor(request.bound_conversation_url)),
    lastError: null,
    lastDispatchId: request.id,
    lastDispatchAt: new Date().toISOString(),
  });
}

function scheduleQueuePoll(retryForMs = 0) {
  if (retryForMs > 0) queuePollRetryDeadline = Math.max(queuePollRetryDeadline, Date.now() + retryForMs);
  // Let the current completion/recovery task finish before starting the next
  // dependency. When a page hint arrives while another ChatGPT operation is
  // transitioning, keep this short retry alive instead of deferring the
  // queued request to the 30-second alarm recovery path.
  if (queuePollTimer) return;
  queuePollTimer = setTimeout(() => {
    queuePollTimer = null;
    void pollQueue().finally(() => {
      if (queuePollRetryDeadline <= Date.now()) {
        queuePollRetryDeadline = 0;
        return;
      }
      if (chatGptUiOperationPending > 0 || dispatchStartInFlight || pollInFlight) {
        scheduleQueuePoll(Math.max(1, queuePollRetryDeadline - Date.now()));
      } else {
        queuePollRetryDeadline = 0;
      }
    });
  }, DISPATCH_HINT_QUEUE_RETRY_INTERVAL_MS);
}

async function completeCapturedDispatch(request: Pick<ClaimedRequest, "id" | "lease_token" | "workflow_key">, capturedResponse: string, artifactJson?: string | null) {
  if (artifactJson) {
    try {
      await saveProfessionalProfileArtifact(artifactJson);
    } catch (error) {
      // The JSON is still recorded in the bridge response even if Chrome
      // blocks local downloads in this profile.
      await rememberError(`The professional profile was captured and will be imported, but the local JSON file could not be saved (${publicError(error)}).`, request.id);
    }
  }
  await bridgeCall("complete_dispatch", { requestId: request.id, leaseToken: request.lease_token, responseText: capturedResponse });
  await clearActiveLease();
  await saveSettings({ lastError: null, lastDispatchId: request.id, lastDispatchAt: new Date().toISOString() });
  scheduleQueuePoll();
}

async function waitForDispatchResponse(tabId: number, request: ClaimedRequest, baseline: NonNullable<AdapterResult["assistantBaseline"]>) {
  const deadline = Date.now() + CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS;
  let latest: ResponseResult = {
    ok: false,
    code: "response_not_captured",
    reason: "ChatGPT did not expose a completed assistant response in the bound conversation. The message was sent once; the bridge is still checking the same conversation.",
  };
  let lastChannelError: unknown = null;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      // Never send the Website Bridge instruction here. This is a read-only
      // response check for the exact message that was already verified above.
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "WAIT_FOR_DISPATCH_RESPONSE",
        requestId: request.id,
        workflowKey: request.workflow_key,
        baseline,
        timeoutMs: Math.min(RESPONSE_CAPTURE_POLL_SLICE_MS, remaining),
        expectStructuredProfile: expectsStructuredProfileResponse(request),
      }) as ResponseResult;
      if (result?.ok === true) return result;
      latest = result || latest;
      // A transient read timeout is expected while ChatGPT is still thinking.
      // Other adapter failures are actionable and must stop without a retry.
      if (result?.code && !["response_not_captured", "response_not_ready", "response_capture_failed"].includes(result.code)) return result;
    } catch (error) {
      // Chrome can close a long-lived content-script message when the MV3
      // worker or ChatGPT's SPA surface is recycled. Do not turn that into a
      // user_required state: the outgoing message is already sent, and the
      // next short read or the alarm recovery path can still capture it.
      lastChannelError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(RESPONSE_CAPTURE_RETRY_DELAY_MS, deadline - Date.now()));
  }

  if (lastChannelError && !latest.reason) {
    latest = {
      ok: false,
      code: "response_capture_failed",
      reason: `The ChatGPT response reader closed before a completed response was exposed (${publicError(lastChannelError)}). The message was sent once; review the same conversation or use the read-only response check.`,
    };
  }
  return latest;
}

function activeDispatchFromRemote(value: unknown, settings: Awaited<ReturnType<typeof getSettings>>): ActiveDispatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const dispatch = value as Record<string, unknown>;
  const workflowKey = dispatch.workflow_key;
  const instruction = dispatch.instruction;
  const conversationUrl = dispatch.bound_conversation_url;
  const conversationProjectUrl = typeof conversationUrl === "string" ? projectUrlFor(conversationUrl) : null;
  const boundProjectUrl = typeof dispatch.bound_project_url === "string" ? normaliseConversationUrl(dispatch.bound_project_url) : conversationProjectUrl;
  const localSlot = isConversationSlotKey(workflowKey) ? slotFor(settings, workflowKey) : null;
  const localConversationUrl = localSlot ? normaliseConversationUrl(localSlot.conversationUrl) : null;
  const localProjectUrl = normaliseConversationUrl(settings.projectUrl || "") || (localConversationUrl ? projectUrlFor(localConversationUrl) : null);
  if (!isUuid(dispatch.id) || dispatch.id !== settings.activeRequestId || !isConversationSlotKey(workflowKey)
    || !isPlainLanguageWebsiteInstruction(instruction) || typeof conversationUrl !== "string"
    || !normaliseConversationUrl(conversationUrl) || !conversationProjectUrl || !boundProjectUrl || conversationProjectUrl !== boundProjectUrl
    || !localSlot || localSlot.projectVerified !== true || localConversationUrl !== normaliseConversationUrl(conversationUrl) || localProjectUrl !== boundProjectUrl
    || dispatch.bound_project_name !== BOUND_PROJECT || dispatch.bound_project_verified !== true) return null;
  return {
    id: dispatch.id,
    workflowKey,
    displayTitle: typeof dispatch.display_title === "string" ? dispatch.display_title : null,
    instruction,
    boundConversationUrl: conversationUrl,
    boundProjectUrl,
    boundProjectName: BOUND_PROJECT,
    sentVerified: true,
    assistantBaseline: null,
  };
}

async function restoreLegacyActiveDispatch(settings: Awaited<ReturnType<typeof getSettings>>) {
  if (settings.activeDispatch || !settings.activeRequestId || !settings.activeLeaseToken) return null;
  try {
    const body = await bridgeCall("get_active_dispatch", { requestId: settings.activeRequestId });
    const active = activeDispatchFromRemote(body.dispatch, settings);
    if (!active) return null;
    await saveSettings({ activeDispatch: active });
    return active;
  } catch {
    // Older bridge deployments do not expose this upgrade-recovery operation.
    // The local active state remains untouched and the regular lease safety
    // path continues to apply.
    return null;
  }
}

async function recoverActiveDispatchUnsafe(active: ActiveDispatch, settings: Awaited<ReturnType<typeof getSettings>>) {
  if (!active.sentVerified || settings.activeRequestId !== active.id || !settings.activeLeaseToken) return false;
  if (responseWaitInFlight.has(active.id)) return false;

  let tab: { id?: number };
  try {
    // Do not steal focus from the user on an alarm-based recovery check. If
    // the bound conversation is not open, opening it is still necessary.
    tab = await openBoundTab(active.boundConversationUrl, false);
  } catch {
    return false;
  }
  // The tab may have been opened by the response-recovery alarm while ChatGPT
  // is still completing a SPA route transition. Require the content script to
  // report the exact bound conversation URL before attempting a read-only
  // response check; a readiness response from a stale/loading ChatGPT surface
  // must never be treated as the target conversation.
  if (tab.id === undefined || !(await pingContent(tab.id, 30000, active.boundConversationUrl))) return false;

  let result: AdapterResult;
  try {
    result = await chrome.tabs.sendMessage(tab.id, {
      type: "CHECK_EXISTING_DISPATCH_RESPONSE",
      requestId: active.id,
      workflowKey: active.workflowKey,
      instruction: active.instruction,
      boundConversationUrl: active.boundConversationUrl,
      boundProjectUrl: active.boundProjectUrl || undefined,
      boundProjectName: active.boundProjectName,
      timeoutMs: 30000,
    }) as AdapterResult;
  } catch {
    return false;
  }

  if (result?.ok !== true || result.sent !== true) return false;
  const artifactJson = isNonEmptyString(result.artifactJson, 100000)
    ? result.artifactJson
    : active.workflowKey === "profile.background" ? extractStructuredProfileJson(result.existingResponseText) : null;
  const capturedResponse = artifactJson || result.existingResponseText;
  if (!isNonEmptyString(capturedResponse, 100000)) return false;
  try {
    await completeCapturedDispatch({ id: active.id, lease_token: settings.activeLeaseToken, workflow_key: active.workflowKey }, capturedResponse, artifactJson);
  } catch (error) {
    // Keep the persisted active lease so the next alarm can retry the
    // server-side completion. The ChatGPT message is never sent again.
    await rememberError(`ChatGPT finished this dispatch, but the bridge could not record the response yet (${publicError(error)}).`, active.id);
  }
  return true;
}

async function recoverActiveDispatch(active: ActiveDispatch, settings: Awaited<ReturnType<typeof getSettings>>) {
  return withChatGptUiOperation(() => recoverActiveDispatchUnsafe(active, settings));
}

async function captureClaimedResponseUnsafe(request: ClaimedRequest, delivery: InitialDeliveryResult): Promise<InitialDeliveryResult> {
  if (!delivery.tabId) return { ...delivery, reason: "The instruction was sent, but no ChatGPT tab remained available for response capture." };
  let response: ResponseResult;
  if (isNonEmptyString(delivery.existingResponseText, 100000)) {
    response = {
      ok: true,
      responseText: delivery.existingResponseText,
      artifactJson: delivery.artifactJson || extractStructuredProfileJson(delivery.existingResponseText) || undefined,
    };
  } else {
    responseWaitInFlight.add(request.id);
    try {
      response = await waitForDispatchResponse(delivery.tabId, request, delivery.assistantBaseline || { count: 0, lastText: "" });
    } catch (error) {
      // The message was already sent and acknowledged. Preserve the active
      // lease so the periodic read-only recovery check can capture a response
      // after a tab/service-worker channel reset; never resend the prompt.
      await rememberError(`The message was sent, but the ChatGPT response reader closed (${publicError(error)}). The bridge will keep checking the same conversation without resending.`, request.id);
      scheduleQueuePoll();
      return { ...delivery, reason: "The message was sent; the bridge will keep checking the same conversation without resending." };
    } finally {
      responseWaitInFlight.delete(request.id);
    }
  }
  const artifactJson = isNonEmptyString(response?.artifactJson, 100000)
    ? response.artifactJson
    : request.workflow_key === "profile.background" ? extractStructuredProfileJson(response?.responseText) : null;
  const capturedResponse = artifactJson || response?.responseText;
  if (response?.ok !== true || !isNonEmptyString(capturedResponse, 100000)) {
    const stopped = await stopForUser(request, response?.code || "response_not_captured", response?.reason || "The message was sent, but no completed ChatGPT response was captured.");
    return { ...delivery, accepted: stopped.accepted, reason: stopped.reason };
  }
  try {
    await completeCapturedDispatch(request, capturedResponse, artifactJson);
  } catch (error) {
    const stopped = await stopForUser(request, "response_recording_failed", `ChatGPT returned a response, but the bridge could not record it in JobHuntAI (${publicError(error)}).`);
    return { ...delivery, accepted: stopped.accepted, reason: stopped.reason };
  }
  return delivery;
}

async function executeClaimedRequestCore(request: ClaimedRequest, runtimeTiming: { uiQueueWaitMs?: number } = {}): Promise<InitialDeliveryResult> {
  if (!isUuid(request.id) || !isPlainLanguageWebsiteInstruction(request.instruction) || !isNonEmptyString(request.lease_token, 200)) {
    if (isUuid(request.id) && isNonEmptyString(request.instruction, 6000) && !isPlainLanguageWebsiteInstruction(request.instruction)) {
      const stopped = await stopForUser(request, "server_instruction_not_plain_language", "The server returned an internal MCP command instead of a plain-language Website Bridge task. Update the JobHuntAI server before retrying; nothing was sent.");
      return { accepted: stopped.accepted, reason: stopped.reason };
    }
    await rememberError("The bridge received an invalid server dispatch lease.", request.id);
    return { accepted: false, reason: "The bridge received an invalid server dispatch lease." };
  }
  const settings = await getSettings();
  const slot = slotFor(settings, request.workflow_key);
  const storedUrl = slot ? normaliseConversationUrl(slot.conversationUrl) : null;
  const serverUrl = normaliseConversationUrl(request.bound_conversation_url);
  const storedProjectUrl = normaliseConversationUrl(settings.projectUrl || "") || (storedUrl ? projectUrlFor(storedUrl) : null);
  const conversationProjectUrl = storedUrl ? projectUrlFor(storedUrl) : null;
  const serverProjectUrl = request.bound_project_url === undefined
    ? storedProjectUrl
    : normaliseConversationUrl(request.bound_project_url);
  if (!slot || slot.projectVerified !== true || !storedUrl || !serverUrl || storedUrl !== serverUrl
    || !storedProjectUrl || !conversationProjectUrl || conversationProjectUrl !== storedProjectUrl
    || !serverProjectUrl || serverProjectUrl !== storedProjectUrl
    || request.bound_project_name !== BOUND_PROJECT || request.bound_project_verified !== true) {
    const stopped = await stopForUser(request, "binding_mismatch", `The server dispatch target did not match the locally bound ${request.workflow_display_name || request.workflow_key} JobHuntAI conversation. Nothing was sent.`);
    return { accepted: stopped.accepted, reason: stopped.reason };
  }
  const responseCheckOnly = request.response_check_only === true
    || (request.workflow_key === "profile.background" && request.display_title === RESPONSE_CHECK_DISPLAY_TITLE);
  await saveSettings({ activeRequestId: request.id, activeLeaseToken: request.lease_token, activeLeaseExpiresAt: request.lease_expires_at || null, activeDispatch: activeDispatchForRequest(request, false, undefined, storedProjectUrl), lastError: null, lastDispatchId: request.id, lastDispatchAt: new Date().toISOString() });
  try {
    await updateDispatch(request.id, request.lease_token, "opening_chatgpt", { stage: "opening_chatgpt" });
  } catch (error) {
    const stopped = await stopForUser(request, "progress_update_failed", `The bridge could not record the start of this delivery (${publicError(error)}). Nothing was sent.`);
    return { accepted: stopped.accepted, reason: stopped.reason };
  }
  const deliveryStartedAt = Date.now();
  let tabReadyMs: number | null = null;
  let contentReadyMs: number | null = null;
  let adapterResultMs: number | null = null;
  let tab: { id?: number };
  try {
    tab = await openBoundTab(serverUrl);
    tabReadyMs = Date.now() - deliveryStartedAt;
  } catch (error) {
    const stopped = await stopForUser(request, "conversation_open_failed", publicError(error, "The bound ChatGPT conversation could not be opened."));
    return { accepted: stopped.accepted, reason: stopped.reason };
  }
  // `openBoundTab` can return as soon as Chrome has created the tab, before
  // the ChatGPT SPA has settled on the stored conversation route. The
  // versioned, URL-bound readiness check prevents a stale content listener or
  // an intermediate ChatGPT page from swallowing the one-time dispatch.
  const contentReadyStartedAt = Date.now();
  if (tab.id === undefined || !(await ensureContentReady(tab.id, serverUrl))) {
    const stopped = await stopForUser(request, "content_script_unavailable", "The ChatGPT bridge content script was not ready. Reload the bound conversation and retry; no automatic resend is safe.");
    return { accepted: stopped.accepted, reason: stopped.reason };
  }
  contentReadyMs = Date.now() - contentReadyStartedAt;
  let result: AdapterResult;
  try {
    const adapterStartedAt = Date.now();
    if (responseCheckOnly) {
      // A manual recovery check is deliberately read-only. It may reuse a
      // completed JSON answer already visible after a long ChatGPT run, but
      // it must never send the original instruction again.
      result = await chrome.tabs.sendMessage(tab.id, {
        type: "CHECK_DISPATCH_RESPONSE",
        requestId: request.id,
        workflowKey: request.workflow_key,
        instruction: request.instruction,
        boundConversationUrl: serverUrl,
        boundProjectUrl: storedProjectUrl,
        boundProjectName: request.bound_project_name,
        timeoutMs: 30000,
      }) as AdapterResult;
    } else {
      // This is the only attempt to deliver the instruction. If a prior failed
      // profile import already has a complete structured answer visible, the
      // content adapter may safely reuse that answer without sending again.
      result = await startDispatchOverPort(tab.id, {
        type: "START_DISPATCH",
        requestId: request.id,
        workflowKey: request.workflow_key,
        instruction: request.instruction,
        boundConversationUrl: serverUrl,
        boundProjectUrl: storedProjectUrl,
        boundProjectName: request.bound_project_name,
        dispatchStartedAtMs: deliveryStartedAt,
      }) as AdapterResult;
      if (result?.deliveryPending === true) result = await waitForDispatchDelivery(tab.id, request, result.timing, deliveryStartedAt);
    }
    adapterResultMs = Date.now() - adapterStartedAt;
  } catch (error) {
    // A port/runtime channel can close after the content script has already
    // started the one-time adapter operation. Before stopping, perform only
    // the bounded read-only delivery check. This recovers a real send without
    // ever starting the adapter a second time; if neither the operation nor
    // the exact visible message can be confirmed, the safe stop remains.
    const recovered = responseCheckOnly ? null : await waitForDispatchDelivery(tab.id, request);
    if (recovered?.ok === true && recovered.sent === true) {
      result = recovered;
    } else {
      const stopped = await stopForUser(request, "delivery_uncertain", recovered?.reason || `The ChatGPT tab did not acknowledge the one-time delivery attempt (${publicError(error)}). Do not resend automatically.`);
      return { accepted: stopped.accepted, reason: stopped.reason };
    }
  }
  if (result?.ok !== true || result.sent !== true) {
    const stopped = await stopForUser(request, result?.code || "adapter_stopped", result?.reason || "The visible ChatGPT controls could not be verified. Nothing was resent.");
    return { accepted: stopped.accepted, reason: stopped.reason };
  }
  try {
    const delivery = result.delivery || "verified";
    const timing = {
      ...result.timing,
      ui_queue_wait_ms: runtimeTiming.uiQueueWaitMs ?? null,
      tab_ready_ms: tabReadyMs,
      content_ready_ms: contentReadyMs,
      composer_wait_ms: result.timing?.composer_wait_ms ?? null,
      pre_send_validation_ms: result.timing?.pre_send_validation_ms ?? null,
      send_control_wait_ms: result.timing?.send_control_wait_ms ?? null,
      post_click_verification_ms: result.timing?.post_click_verification_ms ?? null,
      adapter_result_ms: adapterResultMs,
      total_ms: Date.now() - deliveryStartedAt,
    };
    // Persist the fact that the exact outgoing message was verified before
    // sending acknowledgement updates to the server. If an acknowledgement
    // request times out, the recovery alarm can inspect the response without
    // ever typing or clicking Send again.
    await saveSettings({ activeDispatch: activeDispatchForRequest(request, true, result.assistantBaseline, storedProjectUrl) });
    await updateDispatch(request.id, request.lease_token, "composer_ready", { stage: "composer_ready", delivery, timing });
    await updateDispatch(request.id, request.lease_token, "sent", { stage: "sent", delivery, timing });
  } catch (error) {
    // The UI adapter already verified the exact outgoing message. Do not run
    // the adapter again after an acknowledgement/update timeout. Keep the
    // active lease and sent marker so the response recovery path can finish
    // this request; clearing it here could lose the only safe recovery anchor.
    await rememberError(`The instruction was verified in ChatGPT, but the server acknowledgement was incomplete (${publicError(error)}). Check dispatch status before retrying.`, request.id);
    return { accepted: true, sent: true, tabId: tab.id, assistantBaseline: result.assistantBaseline, existingResponseText: result.existingResponseText, artifactJson: result.artifactJson, reason: "The instruction was verified in ChatGPT; the server is still recording it." };
  }

  const delivery: InitialDeliveryResult = {
    accepted: true,
    sent: true,
    tabId: tab.id,
    assistantBaseline: result.assistantBaseline,
    existingResponseText: result.existingResponseText,
    artifactJson: result.artifactJson,
  };
  return delivery;
}

async function executeClaimedRequestUnsafe(request: ClaimedRequest) {
  return executeClaimedRequestCore(request);
}

async function executeClaimedRequest(request: ClaimedRequest) {
  // Start the heartbeat before waiting for the UI queue. A setup or response
  // read that is already using ChatGPT must not consume the entire five-minute
  // server lease before this request gets its first progress update.
  const validLease = isUuid(request.id) && isNonEmptyString(request.lease_token, 200);
  const stopLeaseHeartbeat = validLease ? startDispatchLeaseHeartbeat(request) : () => undefined;
  const queueWaitStartedAt = Date.now();
  try {
    return await withChatGptUiOperation(() => executeClaimedRequestCore(request, { uiQueueWaitMs: Date.now() - queueWaitStartedAt }));
  } finally {
    stopLeaseHeartbeat();
  }
}

async function captureClaimedResponse(request: ClaimedRequest, delivery: InitialDeliveryResult) {
  const validLease = isUuid(request.id) && isNonEmptyString(request.lease_token, 200);
  const stopLeaseHeartbeat = validLease ? startDispatchLeaseHeartbeat(request) : () => undefined;
  try {
    return await withChatGptUiOperation(() => captureClaimedResponseUnsafe(request, delivery));
  } finally {
    stopLeaseHeartbeat();
  }
}

function launchResponseCapture(request: ClaimedRequest, delivery: InitialDeliveryResult) {
  if (delivery.sent !== true || delivery.tabId === undefined || responseWaitInFlight.has(request.id)) return;
  // Mark this synchronously before queueing the read-only capture. A poll
  // alarm may fire in the same turn; it must not start a second reader while
  // this one is acquiring the ChatGPT UI queue.
  responseWaitInFlight.add(request.id);
  void captureClaimedResponse(request, delivery)
    .catch(async (error) => {
      // Sending has already been verified. Keep the active dispatch as the
      // durable recovery anchor; the next alarm will perform a read-only
      // response check and will never resend the instruction.
      await rememberError(`The message was sent, but response capture stopped (${publicError(error)}). The bridge will keep checking the same conversation without resending.`, request.id);
    })
    .finally(() => {
      responseWaitInFlight.delete(request.id);
      scheduleQueuePoll();
    });
}

async function deliverClaimedRequest(request: ClaimedRequest) {
  // Acceptance covers only the initial delivery phase. ChatGPT may take many
  // minutes to answer, so response capture is launched separately and is
  // recoverable from the persisted sent marker if this worker is suspended.
  const delivery = await executeClaimedRequest(request);
  launchResponseCapture(request, delivery);
  return delivery;
}

async function runClaimedRequest(request: ClaimedRequest): Promise<InitialDeliveryResult> {
  dispatchStartInFlight = true;
  try {
    return await deliverClaimedRequest(request);
  } catch (error) {
    const reason = publicError(error, "The bridge stopped during dispatch delivery.");
    await rememberError(reason, request.id);
    await clearActiveLease();
    return { accepted: false, reason };
  } finally {
    dispatchStartInFlight = false;
    setTimeout(() => inFlight.delete(request.id), 120000);
    scheduleQueuePoll();
  }
}

async function claimAndExecute(requestId: string) {
  if (!isUuid(requestId)) return { accepted: false, reason: "The dispatch id was invalid." };
  if (inFlight.has(requestId)) return { accepted: true, reason: "This dispatch is already being delivered." };
  const settings = await getSettings();
  if (!settings.deviceId || !settings.deviceToken) return { accepted: false, reason: "Pair the ChatGPT bridge extension first." };
  if (settings.workflowSetup.state === "running" || setupInFlight) {
    scheduleQueuePoll(DISPATCH_DELIVERY_TIMEOUT_MS);
    return { accepted: true, reason: "This dispatch is queued until workflow setup finishes." };
  }
  if (chatGptUiOperationPending > 0 || dispatchStartInFlight) {
    scheduleQueuePoll(DISPATCH_DELIVERY_TIMEOUT_MS);
    return { accepted: true, reason: "This dispatch is queued behind the current ChatGPT operation." };
  }
  if (settings.activeRequestId && settings.activeRequestId !== requestId) {
    scheduleQueuePoll(DISPATCH_DELIVERY_TIMEOUT_MS);
    return { accepted: true, reason: "The bridge is already delivering another request; this request remains queued." };
  }
  dispatchStartInFlight = true;
  inFlight.add(requestId);
  try {
    const body = await bridgeCall("claim_dispatch", { requestId });
    const request = body.request as ClaimedRequest | null | undefined;
    if (!request) {
      dispatchStartInFlight = false;
      return { accepted: false, reason: "The dispatch is not queued for this bridge device." };
    }
    if (request.id !== requestId) {
      dispatchStartInFlight = false;
      return { accepted: false, reason: "The bridge refused a dispatch id mismatch." };
    }
    try {
      await persistClaimedLease(request);
    } catch (error) {
      const stopped = await stopForUser(request, "local_lease_persist_failed", `The bridge could not persist the delivery lease locally (${publicError(error)}). Nothing was sent.`);
      return { accepted: stopped.accepted, reason: stopped.reason };
    }
    const delivery = await runClaimedRequest(request);
    return { accepted: delivery.accepted, reason: delivery.reason || (delivery.sent === true ? "The dispatch was sent to the bound ChatGPT conversation." : "The bridge could not deliver the dispatch safely.") };
  } catch (error) {
    const reason = publicError(error, "The bridge could not claim the dispatch.");
    await rememberError(reason, requestId);
    return { accepted: false, reason };
  } finally {
    dispatchStartInFlight = false;
    // Keep the short-lived set through the delivery transition so a duplicate
    // page hint cannot claim the same request while its initial send is being
    // acknowledged. The server also enforces the lease token.
    setTimeout(() => inFlight.delete(requestId), 120000);
  }
}

async function pollQueue() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const settings = await getSettings();
    if (!settings.deviceId || !settings.deviceToken) return;
    if (chatGptUiOperationPending > 0 || dispatchStartInFlight) return;
    // Workflow setup owns the active ChatGPT tab while it creates or repairs
    // chats. Do not let the dispatch poller navigate that same tab midway
    // through setup. If the worker was restarted, hand the persisted running
    // checkpoint to the resumable setup path instead.
    if (settings.workflowSetup.state === "running") {
      void resumeWorkflowSetupIfNeeded();
      return;
    }

    try {
      await bridgeCall("device_heartbeat");
    } catch {
      return;
    }

    // Pairing leaves Automatic Send pending until a verified workflow slot
    // exists. Once a slot is present, repair a stale false server flag before
    // polling so every queued request uses the only delivery mode exposed by
    // this extension.
    if (settings.conversationSlots.some((slot) => slot.projectVerified === true)) {
      try {
        await ensureAutomaticSendEnabled();
      } catch (error) {
        await rememberError(`Automatic Send could not be enabled: ${publicError(error)}`);
        return;
      }
    }

    if (settings.activeRequestId) {
      let activeLeaseExpiresAt = settings.activeLeaseExpiresAt;
      if (settings.activeLeaseToken) {
        try {
          const touched = await bridgeCall("touch_dispatch", { requestId: settings.activeRequestId, leaseToken: settings.activeLeaseToken });
          if (typeof touched.lease_expires_at === "string") {
            activeLeaseExpiresAt = touched.lease_expires_at;
            await saveSettings({ activeLeaseExpiresAt });
          }
        } catch {
          // The active request may have reached a terminal server state while
          // this worker was suspended. The normal recovery/expiry checks below
          // decide whether it is still safe to keep local state.
        }
      }
      const active = settings.activeDispatch || await restoreLegacyActiveDispatch(settings);
      if (active && active.id === settings.activeRequestId && active.sentVerified && !responseWaitInFlight.has(active.id)) {
        // A Manifest V3 worker may be restarted while the content script is
        // waiting for ChatGPT's response. Resume by looking for the exact
        // already-sent user message; this path never types or clicks Send.
        await recoverActiveDispatch(active, settings);
      }
      const leaseExpiresAt = activeLeaseExpiresAt ? Date.parse(activeLeaseExpiresAt) : NaN;
      const lastDispatchAt = settings.lastDispatchAt ? Date.parse(settings.lastDispatchAt) : NaN;
      const leaseExpired = Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= Date.now();
      const legacyLeaseStale = !Number.isFinite(leaseExpiresAt)
        && Number.isFinite(lastDispatchAt)
        && Date.now() - lastDispatchAt > STALE_ACTIVE_LEASE_GRACE_MS;
      if (leaseExpired || legacyLeaseStale) {
        await clearActiveLease();
      } else {
        return;
      }
    }

    const body = await bridgeCall("device_poll");
    const request = body.request as ClaimedRequest | null | undefined;
    if (request?.id && !inFlight.has(request.id)) {
      inFlight.add(request.id);
      try {
        await persistClaimedLease(request);
        // Keep the delivery phase awaited in this poll event too. A queued
        // dispatch must not be handed to another fire-and-forget promise that
        // can outlive the MV3 worker before its first progress update.
        await runClaimedRequest(request);
      } catch (error) {
        inFlight.delete(request.id);
        await stopForUser(request, "local_lease_persist_failed", `The bridge could not persist the delivery lease locally (${publicError(error)}). Nothing was sent.`);
      }
    }
  } catch (error) {
    const latest = await getSettings();
    const lastDispatchAt = latest.lastDispatchAt ? Date.parse(latest.lastDispatchAt) : NaN;
    const recentDispatch = Number.isFinite(lastDispatchAt) && Date.now() - lastDispatchAt < RECENT_DISPATCH_ERROR_GRACE_MS;
    // A one-minute poll can overlap the one-time delivery attempt. Preserve
    // the actionable adapter stop (for example, a missing MCP app) while the
    // dispatch is still recent instead of replacing it with a generic poll
    // error that makes the extension appear idle.
    if (!recentDispatch) await rememberError(publicError(error, "The bridge poll failed."));
  } finally {
    pollInFlight = false;
  }
}

async function bindCurrentConversationUnsafe(workflowKey: ConversationSlotKey) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: CHATGPT_URL_PATTERNS });
  const tab = tabs[0];
  if (tab?.id === undefined || !tab.url || !supportedChatGptUrl(tab.url)) throw new Error("Open the dedicated JobHuntAI Project conversation in the active ChatGPT tab first.");
  if (!(await pingContent(tab.id))) throw new Error("Reload the active ChatGPT conversation so the extension content script can verify it.");
  const response = await chrome.tabs.sendMessage(tab.id, { type: "BIND_CURRENT_CONVERSATION" }) as { ok?: boolean; conversationUrl?: string; projectName?: string; projectVerified?: boolean; reason?: string };
  if (response?.ok !== true || !response.conversationUrl || response.projectName !== BOUND_PROJECT || response.projectVerified !== true) throw new Error(response?.reason || "The JobHuntAI Project conversation could not be verified.");
  const bound = await bridgeCall("bind_conversation", { workflowKey, conversationUrl: response.conversationUrl, projectName: response.projectName, projectVerified: true });
  const settings = await getSettings();
  const slot = localSlotFromRemote(workflowKey, bound as Record<string, unknown>, response.conversationUrl) || {
    workflowKey,
    displayName: CONVERSATION_SLOT_DEFINITIONS.find((definition) => definition.key === workflowKey)?.label || workflowKey,
    conversationUrl: response.conversationUrl,
    projectName: BOUND_PROJECT,
    projectVerified: true,
  };
  // Persist the verified binding before enabling Automatic Send. The server
  // requires this ordering, and the binding remains recoverable if the
  // enable call is temporarily unavailable.
  await saveSettings({ projectUrl: projectUrlFor(response.conversationUrl), conversationSlots: replaceSlot(settings.conversationSlots, slot), boundConversationUrl: response.conversationUrl, boundProjectName: BOUND_PROJECT, boundProjectVerified: true, lastError: null });
  await ensureAutomaticSendEnabled();
  return { ok: true, bound, workflowKey };
}

async function bindCurrentConversation(workflowKey: ConversationSlotKey) {
  return withChatGptUiOperation(() => bindCurrentConversationUnsafe(workflowKey));
}

function waitForTabCondition(tabId: number, predicate: (url: string) => boolean, timeoutMs = 12000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(url);
    };
    const inspect = async () => {
      if (settled) return;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && predicate(tab.url)) return finish(tab.url);
      } catch {
        return finish(null);
      }
      if (Date.now() >= deadline) return finish(null);
      // The update event is the fast path. This bounded fallback covers SPA
      // transitions and test/mocked tabs that do not emit onUpdated.
      timer = setTimeout(inspect, 250);
    };
    const onUpdated = (updatedTabId: number, changeInfo: { url?: string; status?: string }, tab: ChromeTab) => {
      if (updatedTabId !== tabId) return;
      const candidates = [changeInfo.url, tab.url].filter((url): url is string => Boolean(url));
      if (candidates.some((url) => {
        try { return predicate(url); } catch { return false; }
      })) finish(candidates.find((url) => {
        try { return predicate(url); } catch { return false; }
      }) || null);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void inspect();
  });
}

async function waitForTabUrl(tabId: number, predicate: (url: string) => boolean, timeoutMs = 12000) {
  return waitForTabCondition(tabId, predicate, timeoutMs);
}

async function waitForTabNavigation(tabId: number, previousUrl: string | null, timeoutMs = 12000) {
  return waitForTabCondition(tabId, (url) => {
    const currentUrl = normaliseConversationUrl(url);
    return Boolean(currentUrl && currentUrl !== previousUrl);
  }, timeoutMs).then((url) => normaliseConversationUrl(url || ""));
}

async function openProjectHome(tabId: number, projectUrl: string, settleMs = PROJECT_SETUP_AFTER_OPEN_WAIT_MS) {
  const expected = normaliseConversationUrl(projectUrl);
  if (!expected) throw new Error("The JobHuntAI Project URL could not be normalised safely.");
  const current = await chrome.tabs.get(tabId);
  if (normaliseConversationUrl(current.url || "") !== expected) {
    await chrome.tabs.update(tabId, { url: expected, active: true });
    const loaded = await waitForTabUrl(tabId, (url) => normaliseConversationUrl(url) === expected);
    if (!loaded) throw new Error("The JobHuntAI Project did not reopen before creating the workflow chat.");
  } else if (current.active !== true) {
    await chrome.tabs.update(tabId, { active: true });
  }
  await wait(settleMs);
  if (!(await pingContent(tabId, 12000, expected))) throw new Error("The ChatGPT Project page did not finish loading before creating the workflow chat.");
  const verified = await sendSetupContentMessage<{ ok?: boolean; projectUrl?: string; reason?: string }>(tabId, { type: "VERIFY_PROJECT_CONTEXT", projectUrl: expected }, expected);
  if (verified?.ok !== true || verified.projectUrl !== expected) throw new Error(verified?.reason || "The ChatGPT Project page could not be verified before creating the workflow chat.");
}

async function prepareProjectTab(settings: Awaited<ReturnType<typeof getSettings>>) {
  const chatTabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: CHATGPT_URL_PATTERNS });
  const storedProjectUrl = normaliseConversationUrl(settings.projectUrl || "");
  // Prefer an already-open tab for the stored JobHuntAI Project, even when
  // the user is currently looking at the web app. This is important during
  // recovery: the tab may contain the exact setup marker that was sent just
  // before the MV3 worker was suspended.
  const matchingProjectTab = storedProjectUrl
    ? chatTabs.find((candidate) => projectUrlFor(candidate.url || "") === storedProjectUrl)
    : chatTabs.find((candidate) => looksLikeJobHuntProjectUrl(candidate.url || ""));
  let tab = matchingProjectTab || activeTabs[0];
  if (tab?.id === undefined) {
    tab = await chrome.tabs.create({ url: settings.projectUrl || CHATGPT_HOME_URL, active: true });
  }
  if (tab.id === undefined) throw new Error("ChatGPT opened without a usable tab id.");
  if (tab.active !== true) await chrome.tabs.update(tab.id, { active: true });
  if (!(await pingContent(tab.id, 12000, undefined, true))) throw new Error("The extension could not load its current ChatGPT controls. Setup stopped safely; retry the setup button.");
  let context = await sendSetupContentMessage<{ ok?: boolean; projectUrl?: string; createdProject?: boolean; reason?: string }>(tab.id, { type: "ENSURE_PROJECT_CONTEXT", projectUrl: settings.projectUrl || undefined }, settings.projectUrl || undefined);
  if (context?.ok !== true || !context.projectUrl) {
    if (!settings.projectUrl) throw new Error(context?.reason || "The JobHuntAI Project could not be created or verified safely.");
    await chrome.tabs.update(tab.id, { url: settings.projectUrl, active: true });
    const loaded = await waitForTabUrl(tab.id, (url) => normaliseConversationUrl(url) === normaliseConversationUrl(settings.projectUrl || ""));
    if (!loaded || !(await pingContent(tab.id))) throw new Error("The stored JobHuntAI Project could not be opened safely.");
    context = await sendSetupContentMessage<{ ok?: boolean; projectUrl?: string; createdProject?: boolean; reason?: string }>(tab.id, { type: "ENSURE_PROJECT_CONTEXT", projectUrl: settings.projectUrl || undefined }, settings.projectUrl || undefined);
  }
  if (context?.ok !== true || !context.projectUrl) throw new Error(context?.reason || "The JobHuntAI Project could not be created or verified safely.");
  // A newly created Project needs the deliberate two-stage settle requested
  // by the setup workflow. An already existing, verified Project can use the
  // readiness checks immediately, avoiding an unnecessary 20-second delay.
  if (context.createdProject === true) await wait(PROJECT_SETUP_BEFORE_OPEN_WAIT_MS);
  await openProjectHome(tab.id, context.projectUrl, context.createdProject === true ? PROJECT_SETUP_AFTER_OPEN_WAIT_MS : 0);
  return { tabId: tab.id, projectUrl: context.projectUrl };
}

async function checkBoundConversation(tabId: number, slot: ConversationSlot, projectUrl?: string) {
  const boundUrl = normaliseConversationUrl(slot.conversationUrl);
  if (!boundUrl || !supportedChatGptUrl(boundUrl)) return { valid: false as const, missing: true as const };
  const current = await chrome.tabs.get(tabId);
  if (normaliseConversationUrl(current.url || "") !== boundUrl) {
    const previousUrl = normaliseConversationUrl(current.url || "");
    await chrome.tabs.update(tabId, { url: boundUrl, active: true });
    const navigatedUrl = await waitForTabNavigation(tabId, previousUrl);
    if (!navigatedUrl) throw new Error(`The existing ${slot.displayName} conversation did not finish navigating for verification.`);
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }
  if (!(await pingContent(tabId))) throw new Error(`The existing ${slot.displayName} conversation could not be loaded for verification.`);
  const result = await sendSetupContentMessage<ConversationCheckResult>(tabId, {
    type: "VERIFY_BOUND_CONVERSATION",
    boundConversationUrl: boundUrl,
    boundProjectName: BOUND_PROJECT,
    boundProjectUrl: projectUrl || undefined,
    timeoutMs: 12000,
  }, projectUrl || undefined);
  if (result?.ok === true && result.verified === true) return { valid: true as const, missing: false as const };
  if (result?.code === "conversation_missing" || result?.code === "conversation_wrong_project") return { valid: false as const, missing: true as const };
  throw new Error(result?.reason || `The existing ${slot.displayName} conversation could not be verified safely.`);
}

async function checkExistingWorkflowConversations(tabId: number, slots: ConversationSlot[], projectUrl?: string) {
  const validSlots: ConversationSlot[] = [];
  const missingSlots: ConversationSlot[] = [];
  for (const slot of slots) {
    const result = await checkBoundConversation(tabId, slot, projectUrl);
    if (result.missing) missingSlots.push(slot);
    else validSlots.push(slot);
  }
  return { validSlots, missingSlots };
}

function workflowSetupMarker(definition: typeof CONVERSATION_SLOT_DEFINITIONS[number]) {
  return definition.key === "profile.background"
    ? PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE
    : `This conversation is reserved for my ${definition.label} workflow. Do not browse, call tools, or change any application data during setup. Reply only Ready.`;
}

async function recoverWorkflowConversation(tabId: number, definition: typeof CONVERSATION_SLOT_DEFINITIONS[number], projectUrl: string): Promise<WorkflowConversationResult | null> {
  try {
    if (!(await pingContent(tabId))) return null;
    return await sendSetupContentMessage<WorkflowConversationResult>(tabId, {
      type: "RECOVER_WORKFLOW_CONVERSATION",
      marker: workflowSetupMarker(definition),
      projectUrl,
    }, projectUrl);
  } catch {
    // Recovery is best-effort. A normal Project-home creation attempt remains
    // safe when no exact setup marker is visible in the active tab.
    return null;
  }
}

async function createWorkflowConversationInTab(tabId: number, definition: typeof CONVERSATION_SLOT_DEFINITIONS[number], projectUrl: string) {
  try {
    // This request is intentionally sent only once. If ChatGPT navigates to
    // the new conversation before the content listener can reply, resending
    // the setup marker could create duplicate messages. Recovery below checks
    // for the exact marker instead.
    return await chrome.tabs.sendMessage(tabId, {
      type: "CREATE_WORKFLOW_CONVERSATION",
      workflowKey: definition.key,
      displayName: definition.label,
      projectUrl,
    }) as WorkflowConversationResult;
  } catch (error) {
    const recovered = await recoverWorkflowConversation(tabId, definition, projectUrl);
    if (recovered?.ok === true && recovered.conversationUrl) return recovered;
    throw error;
  }
}

async function setUpWorkflowConversations(forceWorkflowKey?: ConversationSlotKey, lockAlreadyHeld = false) {
  if (setupInFlight && !lockAlreadyHeld) return { ok: false, reason: "Workflow conversation setup is already running in the background." };
  setupInFlight = true;
  let releaseUi: (() => void) | null = null;
  let initial: Awaited<ReturnType<typeof getSettings>> | null = null;
  try {
    releaseUi = await acquireChatGptUiOperation();
    initial = await getSettings();
    if (!initial.deviceId || !initial.deviceToken) throw new Error("Pair the ChatGPT bridge extension first.");
    const initialCompletedKeys = initial.conversationSlots.map((slot) => slot.workflowKey);
    const resumeKey = forceWorkflowKey ? (initial.workflowSetup.currentKey === forceWorkflowKey ? forceWorkflowKey : null) : initial.workflowSetup.currentKey || null;
    let resumePendingConversationUrl = resumeKey ? initial.workflowSetup.pendingConversationUrl || null : null;
    // Write the running checkpoint before any tab work. If the MV3 worker is
    // suspended immediately after the button click, the resume alarm can
    // still see exactly which workflow was in progress.
    await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys: initialCompletedKeys, currentKey: resumeKey, pendingConversationUrl: resumePendingConversationUrl, error: null }), lastError: null });
    const settings = await getSettings();
    const project = await prepareProjectTab(settings);
    await saveSettings({ projectUrl: project.projectUrl });
    let currentCompleted = [...new Set(initialCompletedKeys)];
    let repairedWorkflowKeys: ConversationSlotKey[] = [];

    // If the worker stopped after ChatGPT accepted a setup marker but before
    // the new URL was saved, recover that exact conversation before validating
    // the other slots (validation navigates through their URLs).
    if (resumeKey && !resumePendingConversationUrl) {
      const definition = CONVERSATION_SLOT_DEFINITIONS.find((candidate) => candidate.key === resumeKey);
      if (definition) {
        const recoveryTab = await chrome.tabs.get(project.tabId);
        const recovered = await recoverWorkflowConversation(project.tabId, definition, project.projectUrl);
        if (recovered?.ok === true && recovered.conversationUrl) {
          resumePendingConversationUrl = recovered.conversationUrl;
          await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys: currentCompleted, currentKey: resumeKey, pendingConversationUrl: resumePendingConversationUrl, error: null }) });
        } else if (recovered === null && normaliseConversationUrl(recoveryTab.url || "") !== project.projectUrl) {
          throw new Error(`The active ChatGPT tab could not be checked safely before resuming ${definition.label}.`);
        }
      }
    }

    if (!forceWorkflowKey && settings.conversationSlots.length > 0) {
      // Setup doubles as repair: check every existing URL before deciding
      // that a workflow is complete. Only a confirmed missing/deleted chat is
      // removed and recreated; transient verification failures stop safely.
      const checked = await checkExistingWorkflowConversations(project.tabId, settings.conversationSlots, project.projectUrl);
      repairedWorkflowKeys = checked.missingSlots.map((slot) => slot.workflowKey);
      currentCompleted = [...new Set(checked.validSlots.map((slot) => slot.workflowKey))];
      await saveSettings({
        conversationSlots: checked.validSlots,
        boundConversationUrl: checked.validSlots[0]?.conversationUrl || null,
        boundProjectName: checked.validSlots.length ? BOUND_PROJECT : null,
        boundProjectVerified: checked.validSlots.length > 0,
        workflowSetup: workflowSetupState({ state: "running", completedKeys: currentCompleted, currentKey: resumeKey, pendingConversationUrl: resumePendingConversationUrl, error: null }),
      });
    }
    const setupDefinitions = CONVERSATION_SLOT_DEFINITIONS.filter((definition) => forceWorkflowKey
      ? definition.key === forceWorkflowKey
      : !currentCompleted.includes(definition.key));
    // The configurable pause is a protection for bulk chat creation only.
    // Repairing one or two missing chats should feel immediate, and normal
    // Website Bridge dispatches never use this setup pause.
    const shouldThrottleSetup = setupDefinitions.length > 2;
    let createdThisRun = 0;
    for (const definition of CONVERSATION_SLOT_DEFINITIONS) {
      if (forceWorkflowKey ? definition.key !== forceWorkflowKey : currentCompleted.includes(definition.key)) continue;
      const currentSetup = (await getSettings()).workflowSetup;
      const pendingConversationUrl = currentSetup.currentKey === definition.key ? currentSetup.pendingConversationUrl : null;
      await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys: currentCompleted, currentKey: definition.key, pendingConversationUrl, error: null }) });
      let result: WorkflowConversationResult;
      if (pendingConversationUrl) {
        result = { ok: true, conversationUrl: pendingConversationUrl, projectName: BOUND_PROJECT, projectVerified: true };
      } else {
        const setupSettings = await getSettings();
        if (shouldThrottleSetup && createdThisRun > 0 && setupSettings.workflowSetupCooldownSeconds > 0) {
          // ChatGPT rate-limits rapid creation of conversations. Keep the
          // bulk setup resumable, but let the user choose the deliberate gap.
          await wait(setupSettings.workflowSetupCooldownSeconds * 1000);
        }
        const currentTab = await chrome.tabs.get(project.tabId);
        const recovered = await recoverWorkflowConversation(project.tabId, definition, project.projectUrl);
        if (recovered?.ok === true && recovered.conversationUrl) {
          result = recovered;
        } else {
          if (recovered === null && normaliseConversationUrl(currentTab.url || "") !== project.projectUrl) {
            throw new Error(`The active ChatGPT tab could not be checked safely before creating ${definition.label}.`);
          }
          if (normaliseConversationUrl(currentTab.url || "") !== project.projectUrl) {
            await openProjectHome(project.tabId, project.projectUrl, 0);
          } else if (!(await pingContent(project.tabId, 12000, project.projectUrl))) {
            throw new Error(`The ChatGPT Project page was not ready for ${definition.label}.`);
          }
          result = await createWorkflowConversationInTab(project.tabId, definition, project.projectUrl);
        }
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
      // Creating/binding a missing or freshly rotated chat preserves the
      // bridge's always-on Automatic Send state.
      await saveSettings({ projectUrl: project.projectUrl, conversationSlots: replaceSlot(latest.conversationSlots, slot), boundConversationUrl: result.conversationUrl, boundProjectName: BOUND_PROJECT, boundProjectVerified: true });
      if (!pendingConversationUrl && result.recovered !== true) createdThisRun += 1;
      currentCompleted = [...new Set([...currentCompleted, definition.key])];
      await saveSettings({ workflowSetup: workflowSetupState({ state: "running", completedKeys: currentCompleted, currentKey: null, pendingConversationUrl: null, error: null }) });
    }
    // All setup bindings are now durable, so the server can safely accept the
    // always-on Automatic Send invariant. Do this before marking setup
    // complete; a failed enable remains a resumable, visible safe stop.
    await ensureAutomaticSendEnabled();
    await saveSettings({ workflowSetup: workflowSetupState({ state: "complete", completedKeys: currentCompleted, currentKey: null, pendingConversationUrl: null, error: null }), lastError: null });
    return { ok: true, completedKeys: currentCompleted, repairedWorkflowKeys, rotatedWorkflowKey: forceWorkflowKey || null };
  } catch (error) {
    const reason = publicError(error, "Automatic workflow conversation setup stopped safely.");
    const current = await getSettings().catch(() => initial);
    const completedKeys = current?.conversationSlots.map((slot) => slot.workflowKey) || [];
    const currentSetup = current?.workflowSetup || workflowSetupState({ state: "running", completedKeys, currentKey: forceWorkflowKey || null, pendingConversationUrl: null, error: null });
    try {
      await saveSettings({ workflowSetup: workflowSetupState({ state: "partial", completedKeys, currentKey: currentSetup.currentKey || null, pendingConversationUrl: currentSetup.pendingConversationUrl || null, error: reason }), lastError: reason });
    } catch {
      // The durable checkpoint is best effort if storage itself is unavailable.
    }
    return { ok: false, reason, completedKeys, rotatedWorkflowKey: forceWorkflowKey || null };
  } finally {
    releaseUi?.();
    setupInFlight = false;
    scheduleQueuePoll();
  }
}

async function resumeWorkflowSetupIfNeeded() {
  if (setupInFlight || setupResumeCheckInFlight) return;
  setupResumeCheckInFlight = true;
  try {
    const settings = await getSettings();
    if (settings.workflowSetup.state === "running") await setUpWorkflowConversations();
  } catch (error) {
    const reason = publicError(error, "Automatic workflow conversation setup could not resume safely.");
    try { await rememberError(reason); } catch { /* storage may be unavailable during worker startup */ }
  } finally {
    setupResumeCheckInFlight = false;
  }
}

async function status() {
  let settings = await getSettings();
  if (!setupInFlight && settings.deviceId && settings.deviceToken && settings.automaticSendEnabled !== true && settings.conversationSlots.some((slot) => slot.projectVerified === true)) {
    try {
      await ensureAutomaticSendEnabled();
      settings = await getSettings();
    } catch {
      // Status remains readable while the migration retries on the next poll.
    }
  }
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
    workflowSetupCooldownSeconds: settings.workflowSetupCooldownSeconds,
    uiOperationPending: Math.max(chatGptUiOperationPending, setupInFlight ? 1 : 0),
    activeRequestId: settings.activeRequestId || null,
    activeDispatch: settings.activeDispatch || null,
    lastError: settings.lastError,
    lastDispatchId: settings.lastDispatchId,
    lastDispatchAt: settings.lastDispatchAt,
    workflowSetup: settings.workflowSetup,
  };
}

function startWorkflowSetup(forceWorkflowKey?: ConversationSlotKey) {
  if (setupInFlight) return { ok: false, reason: "Workflow conversation setup is already running in the background." };
  // The setup operation deliberately outlives the extension popup. It
  // navigates/activates ChatGPT, which can destroy the popup's message
  // channel before a long-running response is available. Durable checkpoints
  // and the resume alarm keep the operation recoverable after worker/page
  // suspension.
  // Defer the first tab activation until after the runtime message response
  // has been delivered. Opening ChatGPT can close the popup's document, and
  // launching setup in the same turn can otherwise make Chrome report that a
  // listener returned true before its message channel closed.
  setupInFlight = true;
  setTimeout(() => { void setUpWorkflowConversations(forceWorkflowKey, true); }, 0);
  return { ok: true, started: true };
}

// Keep a dedicated page-to-worker channel for the fast path. A one-shot
// runtime message can be lost while an MV3 worker is waking or while the page
// is being restored; an open port gives Chrome a durable sender to reconnect
// and keeps the acknowledgement independent from the delivery work itself.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== JOBHUNT_PAGE_PORT_NAME) return;
  port.onMessage.addListener((raw: unknown) => {
    const message = raw as { type?: string; hint?: DispatchHint };
    if (message?.type !== "PAGE_DISPATCH_HINT" || !message.hint) return;
    const hint = message.hint;
    void claimAndExecute(hint.request_id)
      .then((result) => {
        try {
          if (result?.accepted) {
            port.postMessage({ type: "JOBHUNT_DISPATCH_ACCEPTED", version: 1, request_id: hint.request_id, nonce: hint.nonce });
          } else {
            port.postMessage({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: hint.request_id, nonce: hint.nonce, reason: result?.reason || "The extension could not accept the dispatch hint." });
          }
        } catch {
          // The page may have navigated away; the server-side dispatch remains
          // queued for the ChatGPT-tab heartbeat/alarm recovery path.
        }
      })
      .catch((error) => {
        try {
          port.postMessage({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: hint.request_id, nonce: hint.nonce, reason: publicError(error, "The extension could not accept the dispatch hint.") });
        } catch {
          // The page may have navigated away; leave the queued request for
          // heartbeat/alarm recovery rather than attempting a second send.
        }
      });
  });
});

async function handleMessage(message: RuntimeMessage) {
  if (message.type === "DISPATCH_RESULT_READY") {
    if (!isUuid(message.requestId)) return { ok: false, reason: "The dispatch id was invalid." };
    const result = dispatchResultFromUnknown(message.result);
    if (!result) return { ok: false, reason: "The dispatch result was invalid." };
    publishDispatchResult(message.requestId, result, message.dispatchStartedAtMs);
    return { ok: true };
  }
  if (message.type === "PAGE_DISPATCH_HINT") return claimAndExecute(message.hint.request_id);
  if (message.type === "CHATGPT_CONTENT_READY") {
    const settings = await getSettings();
    if (settings.deviceId && settings.deviceToken) {
      if (settings.workflowSetup.state === "running") void resumeWorkflowSetupIfNeeded();
      else void pollQueue();
    }
    return { ok: true };
  }
  if (message.type === "CHATGPT_CONTENT_HEARTBEAT") {
    const settings = await getSettings();
    if (!settings.deviceId || !settings.deviceToken || settings.workflowSetup.state === "running") return { ok: true, bound: false };
    const currentUrl = normaliseConversationUrl(message.url);
    const bound = Boolean(currentUrl && settings.conversationSlots.some((slot) => normaliseConversationUrl(slot.conversationUrl) === currentUrl));
    if (bound) scheduleQueuePoll();
    return { ok: true, bound };
  }
  if (message.type === "GET_EXTENSION_STATUS") return status();
  if (message.type === "PAIR_EXTENSION") {
    const paired = await pairExtension({ backendUrl: message.backendUrl, pairingCode: message.pairingCode, displayName: message.displayName });
    await saveSettings({ backendUrl: paired.backendUrl, deviceId: paired.deviceId, deviceToken: paired.deviceToken, projectUrl: null, conversationSlots: [], boundConversationUrl: null, boundProjectName: null, boundProjectVerified: false, automaticSendEnabled: false, activeRequestId: null, activeLeaseToken: null, activeLeaseExpiresAt: null, activeDispatch: null, workflowSetup: workflowSetupState({ state: "idle", completedKeys: [], currentKey: null, pendingConversationUrl: null, error: null }), lastError: null });
    let restored = await restoreRemoteDevice(paired.device);
    try {
      const heartbeat = await bridgeCall("device_heartbeat");
      const synced = await restoreRemoteDevice(heartbeat.device);
      if (synced.restored > 0) restored = synced;
    } catch (error) {
      await rememberError(`The device paired, but existing workflow bindings could not be restored yet: ${publicError(error)}`);
    }
    try { await bridgeCall("prefer_device"); } catch (error) { await rememberError(`The device paired, but could not become preferred: ${publicError(error)}`); }
    // A newly paired device has no verified conversation yet. Automatic Send
    // is enabled by setup or manual binding after that prerequisite exists.
    await ensureAutomaticSendEnabled();
    return { ok: true, device: paired.device, restored };
  }
  if (message.type === "FORGET_LOCAL_PAIRING") {
    await clearCredentials();
    return { ok: true };
  }
  if (message.type === "RESET_LOCAL_PAIRING") {
    await clearCredentials();
    return { ok: true };
  }
  if (message.type === "BIND_CURRENT_CONVERSATION") return bindCurrentConversation(message.workflowKey);
  if (message.type === "SET_UP_WORKFLOW_CONVERSATIONS") return startWorkflowSetup();
  if (message.type === "ROTATE_WORKFLOW_CONVERSATION") return startWorkflowSetup(message.workflowKey);
  if (message.type === "SET_AUTOMATIC_SEND") {
    if (message.enabled !== true) throw new Error("Automatic Send is always enabled and cannot be turned off.");
    await ensureAutomaticSendEnabled();
    void pollQueue();
    return { ok: true, automaticSendEnabled: true };
  }
  if (message.type === "SET_WORKFLOW_SETUP_COOLDOWN") {
    const seconds = normaliseWorkflowSetupCooldownSeconds(message.seconds);
    await saveSettings({ workflowSetupCooldownSeconds: seconds });
    return { ok: true, workflowSetupCooldownSeconds: seconds };
  }
  if (message.type === "OPEN_BOUND_CONVERSATION") {
    const settings = await getSettings();
    const slot = slotFor(settings, message.workflowKey);
    if (!slot) throw new Error(`Set up or bind the ${CONVERSATION_SLOT_DEFINITIONS.find((definition) => definition.key === message.workflowKey)?.label || message.workflowKey} conversation first.`);
    await withChatGptUiOperation(() => openBoundTab(slot.conversationUrl));
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A URL/status transition invalidates the proof held in the warm-tab cache.
  // The next dispatch will perform the normal versioned readiness check.
  if (changeInfo.url || changeInfo.status === "loading") forgetContentReadyTab(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => forgetContentReadyTab(tabId));

async function schedulePoll() {
  // Direct page hints are the fast path. A 30-second alarm is the recovery
  // path for a suspended MV3 worker or a page that was closed during delivery.
  await chrome.alarms.create("jobhunt-chatgpt-bridge-poll", { periodInMinutes: 0.5 });
  // Setup has its own recovery alarm because the dispatch poller must not
  // navigate the active ChatGPT tab while a workflow chat is being created.
  await chrome.alarms.create(WORKFLOW_SETUP_RESUME_ALARM, { periodInMinutes: WORKFLOW_SETUP_RESUME_PERIOD_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "jobhunt-chatgpt-bridge-poll") void pollQueue();
  if (alarm.name === WORKFLOW_SETUP_RESUME_ALARM) void resumeWorkflowSetupIfNeeded();
});
chrome.runtime.onInstalled.addListener(() => { void schedulePoll(); void resumeWorkflowSetupIfNeeded(); void pollQueue(); });
chrome.runtime.onStartup.addListener(() => { void schedulePoll(); void resumeWorkflowSetupIfNeeded(); void pollQueue(); });
void schedulePoll();
void resumeWorkflowSetupIfNeeded();
void pollQueue();
