import { ChatGptUiAdapter, type AdapterFailure, type AdapterSuccess } from "./ui-adapter";
import { CHATGPT_PROJECT_NAME, EXTENSION_VERSION, isUuid, safeReason, type RuntimeMessage } from "../shared/protocol";

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

  function retainDispatchResult(requestId: string, operation: DispatchOperation, result: AdapterResult) {
    operation.result = result;
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
    void adapter.executeDispatch({ requestId: message.requestId, workflowKey: message.workflowKey, instruction: message.instruction, boundConversationUrl: message.boundConversationUrl, boundProjectName: message.boundProjectName, boundProjectUrl: message.boundProjectUrl })
      .then((result) => retainDispatchResult(message.requestId, operation, result))
      .catch((error) => retainDispatchResult(message.requestId, operation, { ok: false, code: "adapter_failed", reason: safeReason(error instanceof Error ? error.message : error), userRequired: true }));
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
    if (port.name !== "jobhunt-start-dispatch-v1") return;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as RuntimeMessage;
      if (message?.type !== "START_DISPATCH") return;
      try { port.postMessage(startDispatchOperation(message)); } catch { /* The background will stop safely if the port closed. */ }
    });
  });

  void chrome.runtime.sendMessage({ type: "CHATGPT_CONTENT_READY", url: window.location.href, extensionVersion: EXTENSION_VERSION });
}
