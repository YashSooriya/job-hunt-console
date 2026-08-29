import { ChatGptUiAdapter, type AdapterFailure, type AdapterSuccess } from "./ui-adapter";
import { CHATGPT_PROJECT_NAME, EXTENSION_VERSION, isUuid, safeReason, type DispatchTiming, type RuntimeMessage } from "../shared/protocol";

const CHATGPT_CONTENT_HEARTBEAT_INTERVAL_MS = 1000;

function respond(sendResponse: (value?: unknown) => void, value: unknown) {
  sendResponse(value);
}

const pageGlobal = globalThis as typeof globalThis & { __jobHuntChatGptBridgeContentLoaded?: boolean | string };
if (pageGlobal.__jobHuntChatGptBridgeContentLoaded !== EXTENSION_VERSION) {
  pageGlobal.__jobHuntChatGptBridgeContentLoaded = EXTENSION_VERSION;
  const adapter = new ChatGptUiAdapter();
  type AdapterResult = AdapterSuccess | AdapterFailure;
  type DispatchOperation = {
    signature: string;
    result: AdapterResult | null;
  };
  const dispatchOperations = new Map<string, DispatchOperation>();

  type DispatchStartMessage = Extract<RuntimeMessage, { type: "START_DISPATCH" | "EXECUTE_DISPATCH" }>;

  function dispatchSignature(message: DispatchStartMessage) {
    return [message.workflowKey, message.boundConversationUrl, message.boundProjectUrl || "", message.instruction].join("\u0000");
  }

  function elapsedSinceDispatch(dispatchStartedAtMs: number | undefined, timestamp: number) {
    return typeof dispatchStartedAtMs === "number" && Number.isFinite(dispatchStartedAtMs)
      ? Math.max(0, timestamp - dispatchStartedAtMs)
      : undefined;
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
    void chrome.runtime.sendMessage({ type: "DISPATCH_RESULT_READY", requestId, dispatchStartedAtMs, result: finalResult }).catch(() => undefined);
    // Keep a finished result long enough for a worker retry to query the same
    // one-time operation, but never let old request ids accumulate in a tab.
    window.setTimeout(() => {
      if (dispatchOperations.get(requestId) === operation) dispatchOperations.delete(requestId);
    }, 120000);
  }

  function startDispatchOperation(message: DispatchStartMessage): AdapterResult | { ok: true; deliveryPending: true } {
    if (!isUuid(message.requestId)) return { ok: false, code: "request_invalid", reason: "The dispatch id was invalid.", userRequired: true };
    const signature = dispatchSignature(message);
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
    const operation: DispatchOperation = { signature, result: null };
    dispatchOperations.set(message.requestId, operation);
    const contentReceivedAt = Date.now();
    const adapterStartedAt = Date.now();
    void adapter.executeDispatch({ requestId: message.requestId, workflowKey: message.workflowKey, instruction: message.instruction, boundConversationUrl: message.boundConversationUrl, boundProjectName: message.boundProjectName, boundProjectUrl: message.boundProjectUrl })
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

  chrome.runtime.onMessage.addListener((raw: unknown, _sender: unknown, sendResponse) => {
    const message = raw as RuntimeMessage;
    if (message?.type === "CHATGPT_CONTENT_READY") return false;
    if (message?.type === "PING_CHATGPT_CONTENT") { respond(sendResponse, { ok: true, version: EXTENSION_VERSION, url: window.location.href }); return false; }
    if (message?.type === "PING_CHATGPT_CONTENT_VERSIONED") { respond(sendResponse, { ok: true, version: EXTENSION_VERSION, url: window.location.href }); return false; }
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
    if (message?.type === "CHECK_DISPATCH_SENT") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      const result = adapter.verifyExistingDispatchMessage(message.instruction, message.boundConversationUrl, message.boundProjectName, message.boundProjectUrl);
      respond(sendResponse, result);
      return false;
    }
    if (message?.type === "CHECK_DISPATCH_RESPONSE") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      void adapter.checkExistingProfessionalBackgroundResponse(message.instruction, message.timeoutMs, message.boundConversationUrl, message.boundProjectName, message.boundProjectUrl)
        .then((result) => respond(sendResponse, result))
        .catch((error) => respond(sendResponse, { ok: false, code: "response_check_failed", reason: safeReason(error instanceof Error ? error.message : error) }));
      return true;
    }
    if (message?.type === "CHECK_EXISTING_DISPATCH_RESPONSE") {
      if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
      void adapter.checkExistingDispatchResponse(message.instruction, message.timeoutMs, message.boundConversationUrl, message.boundProjectName, message.boundProjectUrl)
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
  });

  // New delivery path: a port acknowledgement is independent of the
  // callback/return-true runtime-message channel that ChatGPT's SPA can close
  // while it is mounting. The background disconnects after this immediate
  // acknowledgement; the adapter operation continues in this content script
  // and is read later through GET_DISPATCH_DELIVERY.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== `jobhunt-start-dispatch-v1-${EXTENSION_VERSION}`) return;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as RuntimeMessage;
      if (message?.type !== "START_DISPATCH") return;
      try { port.postMessage(startDispatchOperation(message)); } catch { /* The background will stop safely if the port closed. */ }
    });
  });

  function notifyContentReady() {
    void chrome.runtime.sendMessage({ type: "CHATGPT_CONTENT_READY", url: window.location.href, extensionVersion: EXTENSION_VERSION }).catch(() => undefined);
  }

  function notifyContentHeartbeat() {
    void chrome.runtime.sendMessage({ type: "CHATGPT_CONTENT_HEARTBEAT", url: window.location.href, extensionVersion: EXTENSION_VERSION }).catch(() => undefined);
  }

  notifyContentReady();
  // A bound ChatGPT tab is the recovery path when the JobHuntAI page was
  // opened before the extension or its content script was reloaded. The
  // background filters these heartbeats to bound conversations only, so this
  // wakes a queued dispatch without waiting for the 30-second alarm.
  const heartbeatTimer = window.setInterval(notifyContentHeartbeat, CHATGPT_CONTENT_HEARTBEAT_INTERVAL_MS);
  window.addEventListener("beforeunload", () => window.clearInterval(heartbeatTimer), { once: true });
}
