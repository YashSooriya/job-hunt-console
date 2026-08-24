import { ChatGptUiAdapter } from "./ui-adapter";
import { EXTENSION_VERSION, isUuid, safeReason, type RuntimeMessage } from "../shared/protocol";

const adapter = new ChatGptUiAdapter();

function respond(sendResponse: (value?: unknown) => void, value: unknown) {
  sendResponse(value);
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender: unknown, sendResponse) => {
  const message = raw as RuntimeMessage;
  if (message?.type === "CHATGPT_CONTENT_READY") return false;
  if (message?.type === "PING_CHATGPT_CONTENT") { respond(sendResponse, { ok: true, version: EXTENSION_VERSION }); return false; }
  if (message?.type === "BIND_CURRENT_CONVERSATION") {
    const result = adapter.bindCurrentConversation("Job Hunt");
    respond(sendResponse, result);
    return true;
  }
  if (message?.type === "EXECUTE_DISPATCH") {
    if (!isUuid(message.requestId)) { respond(sendResponse, { ok: false, code: "request_invalid", reason: "The dispatch id was invalid." }); return false; }
    void adapter.executeDispatch({ requestId: message.requestId, instruction: message.instruction, boundConversationUrl: message.boundConversationUrl, boundProjectName: message.boundProjectName })
      .then((result) => respond(sendResponse, result))
      .catch((error) => respond(sendResponse, { ok: false, code: "adapter_failed", reason: safeReason(error instanceof Error ? error.message : error) }));
    return true;
  }
  return false;
});

void chrome.runtime.sendMessage({ type: "CHATGPT_CONTENT_READY", url: window.location.href, extensionVersion: EXTENSION_VERSION });
