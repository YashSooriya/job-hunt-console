import { ChatGptUiAdapter, type AdapterFailure, type AdapterSuccess } from "./ui-adapter";
import { CHATGPT_PROJECT_NAME, EXTENSION_BUILD_ID, EXTENSION_VERSION, isUuid, safeReason, type DispatchTiming, type RuntimeMessage } from "../shared/protocol";
import { createRuntimeMessageHelper, type RuntimeMessageHelper } from "../shared/runtime-messaging";

const CHATGPT_CONTENT_HEARTBEAT_INTERVAL_MS = 1000;

function respond(sendResponse: (value?: unknown) => void, value: unknown) {
  sendResponse(value);
}

type AdapterResult = AdapterSuccess | AdapterFailure;
type DispatchOperation = {
  signature: string;
  deliveryAttemptId?: string;
  result: AdapterResult | null;
};

type ContentController = {
  buildId: string;
  instanceId: string;
  dispose: () => void;
};

function createContentInstanceId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Use the bounded fallback below if the page exposes a partial Crypto API.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const pageGlobal = globalThis as typeof globalThis & {
  __jobHuntChatGptBridgeContentLoaded?: ContentController | boolean | string;
  __jobHuntChatGptBridgeDispatchOperations?: Map<string, DispatchOperation>;
};
const existingController = pageGlobal.__jobHuntChatGptBridgeContentLoaded;

// A content script can remain in a SPA document while the extension service
// worker is replaced. A version-only global flag then makes the newly injected
// script believe that a live listener exists, even though its old runtime
// context can no longer answer messages. Probe the exact controller before
// deciding to reuse it; a build change or a rejected probe always replaces
// the controller and removes its listeners/timers first.
async function existingControllerIsLive(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const controller = value as Partial<ContentController>;
  if (controller.buildId !== EXTENSION_BUILD_ID || typeof controller.instanceId !== "string") return false;
  const probe = createRuntimeMessageHelper({
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    maxAttempts: 1,
  });
  const result = await probe.send<{ ok?: boolean; buildId?: string; instanceId?: string }>({ type: "PING_CHATGPT_CONTENT_VERSIONED" }, { retry: false });
  probe.dispose();
  return result.ok === true
    && result.value?.ok === true
    && result.value.buildId === EXTENSION_BUILD_ID
    && result.value.instanceId === controller.instanceId;
}

void (async () => {
  if (await existingControllerIsLive(existingController)) return;
  if (existingController && typeof existingController === "object" && typeof (existingController as Partial<ContentController>).dispose === "function") {
    try { (existingController as ContentController).dispose(); } catch { /* A recycled context may already be invalid. */ }
  }

  let disposed = false;
  let heartbeatTimer: number | null = null;
  let beforeUnloadListener: (() => void) | null = null;
  let runtimeMessageListener: ((raw: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void) | null = null;
  let runtimeConnectListener: ((port: ChromePort) => void) | null = null;
  let runtimeMessenger: RuntimeMessageHelper | null = null;
  const pendingNotificationSends = new Map<string, Promise<void>>();
  const cleanupTimers = new Set<number>();
  const contentInstanceId = createContentInstanceId();
  const controller: ContentController = {
    buildId: EXTENSION_BUILD_ID,
    instanceId: contentInstanceId,
    dispose() {
      if (disposed) return;
      disposed = true;
      runtimeMessenger?.dispose();
      pendingNotificationSends.clear();
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (beforeUnloadListener) {
        try { window.removeEventListener("beforeunload", beforeUnloadListener); } catch { /* The document may already be unloading. */ }
      }
      if (runtimeMessageListener) {
        try { chrome.runtime.onMessage.removeListener(runtimeMessageListener); } catch { /* The extension context may already be invalid. */ }
      }
      if (runtimeConnectListener) {
        try { chrome.runtime.onConnect.removeListener(runtimeConnectListener); } catch { /* The extension context may already be invalid. */ }
      }
      for (const timer of cleanupTimers) window.clearTimeout(timer);
      cleanupTimers.clear();
      // Preserve completed results for the read-only recovery poll, but drop
      // operations whose adapter was interrupted by the replacement.
      const operations = pageGlobal.__jobHuntChatGptBridgeDispatchOperations;
      if (operations) for (const [requestId, operation] of operations) if (!operation.result) operations.delete(requestId);
      if (pageGlobal.__jobHuntChatGptBridgeContentLoaded === controller) delete pageGlobal.__jobHuntChatGptBridgeContentLoaded;
    },
  };
  pageGlobal.__jobHuntChatGptBridgeContentLoaded = controller;
  runtimeMessenger = createRuntimeMessageHelper({
    sendMessage: (message) => {
      // Reading runtime.id is itself capable of throwing after Chrome has
      // invalidated this content script's extension context.
      if (!chrome.runtime.id) throw new Error("Extension context invalidated.");
      return chrome.runtime.sendMessage(message);
    },
    onContextInvalidated: () => controller.dispose(),
    maxAttempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 4000,
  });
  const adapter = new ChatGptUiAdapter();
  // Keep this operation registry on the page global. Chrome can inject a new
  // content-script instance into an already-open SPA document during an
  // extension update or duplicate-frame handoff; a module-local Map in that
  // instance would make the background worker see an empty operation even
  // though the original adapter is still running.
  const dispatchOperations = pageGlobal.__jobHuntChatGptBridgeDispatchOperations || new Map<string, DispatchOperation>();
  pageGlobal.__jobHuntChatGptBridgeDispatchOperations = dispatchOperations;

  type DispatchStartMessage = Extract<RuntimeMessage, { type: "START_DISPATCH" | "EXECUTE_DISPATCH" }>;

  function dispatchSignature(message: DispatchStartMessage) {
    return [message.workflowKey, message.boundConversationUrl, message.boundProjectUrl || "", message.instruction, message.turnAnchor ? JSON.stringify(message.turnAnchor) : ""].join("\u0000");
  }

  function elapsedSinceDispatch(dispatchStartedAtMs: number | undefined, timestamp: number) {
    return typeof dispatchStartedAtMs === "number" && Number.isFinite(dispatchStartedAtMs)
      ? Math.max(0, timestamp - dispatchStartedAtMs)
      : undefined;
  }

  function notificationKey(message: RuntimeMessage | Record<string, unknown>) {
    const record = message as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "runtime";
    const requestId = typeof record.requestId === "string" ? record.requestId : "";
    return `${type}:${requestId}`;
  }

  function safeRuntimeSend(message: RuntimeMessage | Record<string, unknown>) {
    if (disposed || !runtimeMessenger) return;
    const key = notificationKey(message);
    if (pendingNotificationSends.has(key)) return;
    const pending = runtimeMessenger.send(message)
      .then((result) => {
        // The helper retries temporary worker failures with bounded backoff.
        // An invalidated context is terminal for this script and disposes all
        // listeners/timers through the controller callback above.
        if (!result.ok && result.kind === "context_invalidated") controller.dispose();
      })
      .catch(() => undefined);
    pendingNotificationSends.set(key, pending);
    void pending.finally(() => {
      if (pendingNotificationSends.get(key) === pending) pendingNotificationSends.delete(key);
    });
  }

  function retainDispatchResult(requestId: string, operation: DispatchOperation, result: AdapterResult, dispatchStartedAtMs?: number) {
    const resultStoredAt = Date.now();
    const signalSentAt = Date.now();
    const finalResult: AdapterResult = {
      ...result,
      timing: {
        ...result.timing,
        result_stored_at_ms: result.timing?.result_stored_at_ms ?? elapsedSinceDispatch(dispatchStartedAtMs, resultStoredAt),
        result_signal_sent_at_ms: elapsedSinceDispatch(dispatchStartedAtMs, signalSentAt),
      },
    };
    operation.result = finalResult;
    // The background worker can receive this event without asking the ChatGPT
    // tab for another result. The bounded GET_DISPATCH_DELIVERY poll remains
    // the recovery path if the worker or runtime channel is recycled.
    const resultWithAnchors = finalResult as Partial<AdapterSuccess>;
    safeRuntimeSend({
      type: "DISPATCH_RESULT_READY",
      requestId,
      dispatchStartedAtMs,
      deliveryAttemptId: operation.deliveryAttemptId,
      turnAnchor: resultWithAnchors.turnAnchor || resultWithAnchors.assistantBaseline?.turnAnchor || null,
      result: finalResult,
    });
    // Keep a finished result long enough for a worker retry to query the same
    // one-time operation, but never let old request ids accumulate in a tab.
    const cleanupTimer = window.setTimeout(() => {
      cleanupTimers.delete(cleanupTimer);
      if (dispatchOperations.get(requestId) === operation) dispatchOperations.delete(requestId);
    }, 120000);
    cleanupTimers.add(cleanupTimer);
  }

  function startDispatchOperation(message: DispatchStartMessage): AdapterResult | { ok: true; deliveryPending: true } {
    if (!isUuid(message.requestId)) return { ok: false, code: "request_invalid", reason: "The dispatch id was invalid.", userRequired: true };
    const signature = dispatchSignature(message) + `\u0000${message.protocol || "v1"}\u0000${message.deliveryAttemptId || ""}`;
    const existing = dispatchOperations.get(message.requestId);
    if (existing) {
      if (existing.signature !== signature) return { ok: false, code: "dispatch_conflict", reason: "A different dispatch is already using this request id.", userRequired: true };
      if (existing.result) return existing.result;
      return { ok: true, deliveryPending: true };
    }

    // Do not keep a runtime message channel open while ChatGPT is mounting
    // its composer or while the visible Send action is being verified. The
    // SPA can recycle that surface and close an asynchronous response even
    // though this one-time operation is still running. A short immediate
    // acknowledgement plus a read-only result poll avoids that race; the
    // adapter still types and clicks at most once.
    const operation: DispatchOperation = { signature, deliveryAttemptId: message.deliveryAttemptId, result: null };
    dispatchOperations.set(message.requestId, operation);
    const contentReceivedAt = Date.now();
    const adapterStartedAt = Date.now();
    void adapter.executeDispatch({ requestId: message.requestId, workflowKey: message.workflowKey, instruction: message.instruction, boundConversationUrl: message.boundConversationUrl, boundProjectName: message.boundProjectName, boundProjectUrl: message.boundProjectUrl, protocol: message.protocol, beforeSend: async (turnAnchor) => {
      if (!runtimeMessenger) throw new Error("The ChatGPT bridge runtime is not ready.");
      const sendResult = await runtimeMessenger.send<{ ok?: boolean; reason?: string }>({ type: "MARK_DISPATCH_SEND_ATTEMPTED", requestId: message.requestId, deliveryAttemptId: message.deliveryAttemptId, turnAnchor: turnAnchor || null });
      if (!sendResult.ok) {
        const reason = sendResult.kind === "context_invalidated"
          ? "The extension context was invalidated before the one-time ChatGPT Send attempt could be authorized."
          : "The bridge service worker was temporarily unavailable while authorizing the one-time ChatGPT Send attempt.";
        throw new Error(reason);
      }
      const response = sendResult.value;
      if (!response || response.ok !== true) throw new Error(response?.reason || "The bridge could not record the one-time ChatGPT send attempt safely.");
    } })
      .then((result) => {
        const resultStoredAt = Date.now();
        const timing: DispatchTiming = {
          ...result.timing,
          content_received_at_ms: elapsedSinceDispatch(message.dispatchStartedAtMs, contentReceivedAt),
          adapter_started_at_ms: elapsedSinceDispatch(message.dispatchStartedAtMs, adapterStartedAt),
          result_stored_at_ms: elapsedSinceDispatch(message.dispatchStartedAtMs, resultStoredAt),
        };
        retainDispatchResult(message.requestId, operation, { ...result, timing }, message.dispatchStartedAtMs);
      })
      .catch((error) => {
        const resultStoredAt = Date.now();
        retainDispatchResult(message.requestId, operation, {
          ok: false,
          code: "adapter_failed",
          reason: safeReason(error instanceof Error ? error.message : error),
          userRequired: true,
          timing: {
            content_received_at_ms: elapsedSinceDispatch(message.dispatchStartedAtMs, contentReceivedAt),
            adapter_started_at_ms: elapsedSinceDispatch(message.dispatchStartedAtMs, adapterStartedAt),
            result_stored_at_ms: elapsedSinceDispatch(message.dispatchStartedAtMs, resultStoredAt),
          },
        }, message.dispatchStartedAtMs);
      });
    return { ok: true, deliveryPending: true };
  }

  runtimeMessageListener = (raw: unknown, _sender: unknown, sendResponse) => {
    const message = raw as RuntimeMessage;
    if (message?.type === "CHATGPT_CONTENT_READY") return false;
    if (message?.type === "PING_CHATGPT_CONTENT") { respond(sendResponse, { ok: true, version: EXTENSION_VERSION, buildId: EXTENSION_BUILD_ID, instanceId: contentInstanceId, url: window.location.href }); return false; }
    if (message?.type === "PING_CHATGPT_CONTENT_VERSIONED") { respond(sendResponse, { ok: true, version: EXTENSION_VERSION, buildId: EXTENSION_BUILD_ID, instanceId: contentInstanceId, url: window.location.href }); return false; }
    if (message?.type === "VERIFY_PROJECT_CONTEXT") {
      void adapter.waitForProjectContext(CHATGPT_PROJECT_NAME, 12000, message.projectUrl)
        .then((result) => respond(sendResponse, result));
      return true;
    }
    if (message?.type === "VERIFY_BOUND_CONVERSATION") {
      void adapter.checkBoundConversation(message.boundConversationUrl, message.boundProjectName, message.timeoutMs, message.boundProjectUrl)
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "conversation_check_failed", reason: safeReason(error instanceof Error ? error.message : error), userRequired: true }));
      return true;
    }
    if (message?.type === "ENSURE_PROJECT_CONTEXT") {
      void adapter.ensureProjectContext(2500, message.projectUrl)
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "project_setup_failed", reason: safeReason(error instanceof Error ? error.message : error), userRequired: true }));
      return true;
    }
    if (message?.type === "CREATE_WORKFLOW_CONVERSATION") {
      void adapter.createWorkflowConversation({ workflowKey: message.workflowKey, displayName: message.displayName, projectUrl: message.projectUrl })
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "conversation_setup_failed", reason: safeReason(error instanceof Error ? error.message : error), userRequired: true }));
      return true;
    }
    if (message?.type === "RECOVER_WORKFLOW_CONVERSATION") {
      void adapter.recoverWorkflowConversation({ marker: message.marker, projectUrl: message.projectUrl })
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "conversation_recovery_failed", reason: safeReason(error instanceof Error ? error.message : error), userRequired: true }));
      return true;
    }
    if (message?.type === "BIND_CURRENT_CONVERSATION") {
      const result = adapter.bindCurrentConversation(CHATGPT_PROJECT_NAME);
      respond(sendResponse, result);
      return true;
    }
    // Keep this handler for backwards compatibility with a direct message
    // from an older background worker. New workers use the dedicated port
    // below so a stale listener cannot own the acknowledgement channel.
    if (message?.type === "START_DISPATCH" || message?.type === "EXECUTE_DISPATCH") {
      respond(sendResponse, startDispatchOperation(message));
      return false;
    }
    if (message?.type === "GET_DISPATCH_DELIVERY") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      const operation = dispatchOperations.get(message.requestId);
      if (!operation) {
        respond(sendResponse, { ok: false, code: "dispatch_operation_not_found", reason: "The one-time ChatGPT delivery operation is no longer present in this tab." });
        return false;
      }
      respond(sendResponse, operation.result || { ok: true, deliveryPending: true });
      return false;
    }
    if (message?.type === "GET_DISPATCH_DELIVERY_VERSIONED") {
      // A stale content script may still be mounted in an already-open tab
      // after an extension update. Restrict the delivery-result query to this
      // version so an older listener cannot answer on behalf of the current
      // one-time operation with its own empty map.
      if (message.version !== EXTENSION_VERSION || message.buildId !== EXTENSION_BUILD_ID) return false;
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      if (message.deliveryAttemptId !== undefined && !isUuid(message.deliveryAttemptId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The delivery attempt id was invalid." }); return false; }
      const operation = dispatchOperations.get(message.requestId);
      if (!operation) {
        respond(sendResponse, { ok: false, code: "dispatch_operation_not_found", reason: "The one-time ChatGPT delivery operation is no longer present in this tab." });
        return false;
      }
      respond(sendResponse, operation.result || { ok: true, deliveryPending: true });
      return false;
    }
    if (message?.type === "CHECK_DISPATCH_SENT") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      const result = adapter.verifyExistingDispatchMessage(message.instruction, message.boundConversationUrl, message.boundProjectName, message.boundProjectUrl, message.turnAnchor, message.userTurnFingerprint, message.userTurnMessageId);
      respond(sendResponse, result);
      return false;
    }
    if (message?.type === "CHECK_DISPATCH_RESPONSE") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      void adapter.checkExistingProfessionalBackgroundResponse(message.instruction, message.timeoutMs, message.boundConversationUrl, message.boundProjectName, message.boundProjectUrl, message.turnAnchor, message.userTurnFingerprint, message.userTurnMessageId)
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "response_check_failed", reason: safeReason(error instanceof Error ? error.message : error) }));
      return true;
    }
    if (message?.type === "CHECK_EXISTING_DISPATCH_RESPONSE") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      void adapter.checkExistingDispatchResponse(message.instruction, message.timeoutMs, message.boundConversationUrl, message.boundProjectName, message.boundProjectUrl, message.turnAnchor, message.userTurnFingerprint, message.userTurnMessageId)
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "response_check_failed", reason: safeReason(error instanceof Error ? error.message : error) }));
      return true;
    }
    if (message?.type === "WAIT_FOR_DISPATCH_RESPONSE") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      void adapter.waitForAssistantResponse(message.baseline, message.timeoutMs, message.workflowKey, message.expectStructuredProfile === true)
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "response_capture_failed", reason: safeReason(error instanceof Error ? error.message : error) }));
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(runtimeMessageListener);

  // New delivery path: a port acknowledgement is independent of the
  // callback/return-true runtime-message channel that ChatGPT's SPA can close
  // while it is mounting. The background disconnects after this immediate
  // acknowledgement; the adapter operation continues in this content script
  // and is read later through GET_DISPATCH_DELIVERY.
  runtimeConnectListener = (port) => {
    if (port.name !== `jobhunt-start-dispatch-v2-${EXTENSION_VERSION}` && port.name !== `jobhunt-start-dispatch-v1-${EXTENSION_VERSION}`) return;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as RuntimeMessage;
      if (message?.type !== "START_DISPATCH") return;
      try { port.postMessage(startDispatchOperation(message)); } catch { /* The background will stop safely if the port closed. */ }
    });
  };
  chrome.runtime.onConnect.addListener(runtimeConnectListener);

  function notifyContentReady() {
    safeRuntimeSend({ type: "CHATGPT_CONTENT_READY", url: window.location.href, extensionVersion: EXTENSION_VERSION, extensionBuildId: EXTENSION_BUILD_ID, contentInstanceId });
  }

  function notifyContentHeartbeat() {
    safeRuntimeSend({ type: "CHATGPT_CONTENT_HEARTBEAT", url: window.location.href, extensionVersion: EXTENSION_VERSION, extensionBuildId: EXTENSION_BUILD_ID, contentInstanceId });
  }

  notifyContentReady();
  // A bound ChatGPT tab is the recovery path when the JobHuntAI page was
  // opened before the extension or its content script was reloaded. The
  // background filters these heartbeats to bound conversations only, so this
  // wakes a queued dispatch without waiting for the 30-second alarm.
  heartbeatTimer = window.setInterval(notifyContentHeartbeat, CHATGPT_CONTENT_HEARTBEAT_INTERVAL_MS);
  beforeUnloadListener = () => controller.dispose();
  window.addEventListener("beforeunload", beforeUnloadListener, { once: true });
})();
