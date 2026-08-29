import { JOBHUNT_PAGE_PORT_NAME, parsePageMessage, type DispatchHint, type ExtensionToPageMessage } from "../shared/protocol";

function pageMessage(message: ExtensionToPageMessage) {
  window.postMessage(message, window.location.origin);
}

let pagePort: ChromePort | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectPagePort() {
  if (pagePort) return;
  try {
    const port = chrome.runtime.connect({ name: JOBHUNT_PAGE_PORT_NAME });
    pagePort = port;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as ExtensionToPageMessage;
      if (message?.type === "JOBHUNT_DISPATCH_ACCEPTED" || message?.type === "JOBHUNT_DISPATCH_REJECTED") pageMessage(message);
    });
    port.onDisconnect.addListener(() => {
      if (pagePort === port) pagePort = null;
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connectPagePort(); }, 250);
    });
  } catch {
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connectPagePort(); }, 250);
  }
}

function sendDispatchHint(hint: DispatchHint) {
  connectPagePort();
  try {
    if (pagePort) {
      pagePort.postMessage({ type: "PAGE_DISPATCH_HINT", hint });
      return;
    }
  } catch {
    pagePort = null;
  }
  // Keep the one-shot runtime message as a compatibility fallback for a
  // worker that is restarting while the port is reconnecting.
  void chrome.runtime.sendMessage({ type: "PAGE_DISPATCH_HINT", hint })
    .then((response: any) => {
      if (response?.accepted) pageMessage({ type: "JOBHUNT_DISPATCH_ACCEPTED", version: 1, request_id: hint.request_id, nonce: hint.nonce });
      else pageMessage({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: hint.request_id, nonce: hint.nonce, reason: response?.reason || "The extension could not accept the dispatch hint." });
    })
    .catch(() => pageMessage({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: hint.request_id, nonce: hint.nonce, reason: "The extension service worker is unavailable." }));
}

connectPagePort();

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = parsePageMessage(event.data);
  if (!message) return;
  if (message.type === "JOBHUNT_BRIDGE_PROBE") {
    pageMessage({ type: "JOBHUNT_BRIDGE_READY", version: 1 });
    return;
  }
  if (message.type === "JOBHUNT_BRIDGE_RESET_LOCAL") {
    void chrome.runtime.sendMessage({ type: "RESET_LOCAL_PAIRING" })
      .then(() => undefined)
      .catch(() => undefined);
    return;
  }
  const hint = message as DispatchHint;
  sendDispatchHint(hint);
});

pageMessage({ type: "JOBHUNT_BRIDGE_READY", version: 1 });
