import { parsePageMessage, type DispatchHint, type ExtensionToPageMessage } from "../shared/protocol";

function pageMessage(message: ExtensionToPageMessage) {
  window.postMessage(message, window.location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = parsePageMessage(event.data);
  if (!message) return;
  if (message.type === "JOBHUNT_BRIDGE_PROBE") {
    pageMessage({ type: "JOBHUNT_BRIDGE_READY", version: 1 });
    return;
  }
  const hint = message as DispatchHint;
  void chrome.runtime.sendMessage({ type: "PAGE_DISPATCH_HINT", hint })
    .then((response: any) => {
      if (response?.accepted) pageMessage({ type: "JOBHUNT_DISPATCH_ACCEPTED", version: 1, request_id: hint.request_id, nonce: hint.nonce });
      else pageMessage({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: hint.request_id, nonce: hint.nonce, reason: response?.reason || "The extension could not accept the dispatch hint." });
    })
    .catch(() => pageMessage({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: hint.request_id, nonce: hint.nonce, reason: "The extension service worker is unavailable." }));
});

pageMessage({ type: "JOBHUNT_BRIDGE_READY", version: 1 });
