import { EXTENSION_BUILD_ID, JOBHUNT_PAGE_PORT_NAME, parsePageMessage, type DispatchHint, type ExtensionToPageMessage } from "../shared/protocol";
import { createRuntimeMessageHelper, runtimeMessageFailureKind, runtimeRetryDelayMs, type RuntimeMessageHelper } from "../shared/runtime-messaging";

const PAGE_PORT_RECONNECT_MAX_ATTEMPTS = 6;
const PAGE_PORT_RECONNECT_BASE_DELAY_MS = 250;
const PAGE_PORT_RECONNECT_MAX_DELAY_MS = 4000;
const PAGE_PORT_STABILITY_WINDOW_MS = 2000;
const MAX_PENDING_PAGE_HINTS = 32;

type PageBridgeController = {
  buildId: string;
  instanceId: string;
  isLive: () => boolean;
  probeRuntime: () => Promise<boolean>;
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
  __jobHuntPageBridgeController?: PageBridgeController | boolean | string;
};
const existingController = pageGlobal.__jobHuntPageBridgeController;

async function existingControllerIsLive(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const controller = value as Partial<PageBridgeController>;
  if (controller.buildId !== EXTENSION_BUILD_ID || typeof controller.instanceId !== "string" || typeof controller.isLive !== "function" || typeof controller.probeRuntime !== "function") return false;
  if (!controller.isLive()) return false;
  try { return await controller.probeRuntime(); } catch { return false; }
}

void (async () => {
  if (await existingControllerIsLive(existingController)) return;
  if (existingController && typeof existingController === "object" && typeof (existingController as Partial<PageBridgeController>).dispose === "function") {
    try { (existingController as PageBridgeController).dispose(); } catch { /* A recycled context may already be invalid. */ }
  }

  let disposed = false;
  let pagePort: ChromePort | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let portStabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let portMessageListener: ((raw: unknown) => void) | null = null;
  let portDisconnectListener: (() => void) | null = null;
  let windowMessageListener: ((event: MessageEvent) => void) | null = null;
  let runtimeMessenger: RuntimeMessageHelper | null = null;
  type PendingHint = { hint: DispatchHint; sentPort: ChromePort | null; fallbackInFlight: boolean };
  const pendingHints = new Map<string, PendingHint>();
  const contentInstanceId = createContentInstanceId();

  function pageMessage(message: ExtensionToPageMessage) {
    if (disposed) return;
    window.postMessage(message, window.location.origin);
  }

  function safeRuntimeSend(message: unknown) {
    if (disposed || !runtimeMessenger) return;
    void runtimeMessenger.send(message)
      .then((result) => {
        // Temporary worker failures are retried by the helper. Context
        // invalidation is terminal for this document and disposes the bridge.
        if (!result.ok && result.kind === "context_invalidated") controller.dispose();
      })
      .catch(() => undefined);
  }

  const controller: PageBridgeController = {
    buildId: EXTENSION_BUILD_ID,
    instanceId: contentInstanceId,
    isLive: () => !disposed && pagePort !== null,
    probeRuntime: async () => {
      if (disposed || !runtimeMessenger) return false;
      const result = await runtimeMessenger.send<{ ok?: boolean; extensionBuildId?: string }>({ type: "PING_EXTENSION" }, { retry: false });
      return result.ok === true && result.value?.ok === true && result.value.extensionBuildId === EXTENSION_BUILD_ID;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      runtimeMessenger?.dispose();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (portStabilityTimer !== null) clearTimeout(portStabilityTimer);
      portStabilityTimer = null;
      if (pagePort && portMessageListener) {
        try { pagePort.onMessage.removeListener(portMessageListener); } catch { /* The runtime may already be gone. */ }
      }
      if (pagePort && portDisconnectListener) {
        try { pagePort.onDisconnect.removeListener(portDisconnectListener); } catch { /* The runtime may already be gone. */ }
      }
      if (pagePort) {
        try { pagePort.disconnect(); } catch { /* The runtime may already be gone. */ }
      }
      pagePort = null;
      portMessageListener = null;
      portDisconnectListener = null;
      pendingHints.clear();
      if (windowMessageListener) window.removeEventListener("message", windowMessageListener);
      if (pageGlobal.__jobHuntPageBridgeController === controller) delete pageGlobal.__jobHuntPageBridgeController;
    },
  };
  pageGlobal.__jobHuntPageBridgeController = controller;

  runtimeMessenger = createRuntimeMessageHelper({
    sendMessage: (message) => {
      if (!chrome.runtime.id) throw new Error("Extension context invalidated.");
      return chrome.runtime.sendMessage(message);
    },
    onContextInvalidated: () => controller.dispose(),
    maxAttempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 4000,
  });

  function clearPortStabilityTimer() {
    if (portStabilityTimer !== null) clearTimeout(portStabilityTimer);
    portStabilityTimer = null;
  }

  function schedulePortReconnect() {
    if (disposed || pagePort || reconnectTimer || reconnectAttempts >= PAGE_PORT_RECONNECT_MAX_ATTEMPTS) return;
    const attempt = reconnectAttempts + 1;
    reconnectAttempts = attempt;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectPagePort();
    }, runtimeRetryDelayMs(attempt, PAGE_PORT_RECONNECT_BASE_DELAY_MS, PAGE_PORT_RECONNECT_MAX_DELAY_MS));
  }

  function detachPagePort(port: ChromePort) {
    if (pagePort !== port) return;
    if (portMessageListener) {
      try { port.onMessage.removeListener(portMessageListener); } catch { /* The runtime may already be gone. */ }
    }
    if (portDisconnectListener) {
      try { port.onDisconnect.removeListener(portDisconnectListener); } catch { /* The runtime may already be gone. */ }
    }
    pagePort = null;
    portMessageListener = null;
    portDisconnectListener = null;
    clearPortStabilityTimer();
    for (const pending of pendingHints.values()) if (pending.sentPort === port) pending.sentPort = null;
    schedulePortReconnect();
  }

  function completePendingHint(message: Extract<ExtensionToPageMessage, { type: "JOBHUNT_DISPATCH_ACCEPTED" | "JOBHUNT_DISPATCH_REJECTED" }>) {
    pendingHints.delete(message.request_id);
    pageMessage(message);
  }

  function flushPendingHints() {
    if (disposed) return;
    connectPagePort();
    const port = pagePort;
    for (const pending of pendingHints.values()) {
      if (pending.fallbackInFlight) continue;
      if (port && pending.sentPort !== port) {
        try {
          port.postMessage({ type: "PAGE_DISPATCH_HINT", hint: pending.hint });
          pending.sentPort = port;
          continue;
        } catch {
          detachPagePort(port);
        }
      }
      if (pagePort || pending.sentPort) continue;
      // Keep the one-shot runtime message as a compatibility fallback for a
      // worker that is restarting while the port is reconnecting. The helper
      // retries temporary worker failures with bounded exponential backoff.
      pending.fallbackInFlight = true;
      const fallback = runtimeMessenger?.send<{ accepted?: boolean; reason?: string }>({ type: "PAGE_DISPATCH_HINT", hint: pending.hint });
      if (!fallback) {
        pending.fallbackInFlight = false;
        completePendingHint({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: pending.hint.request_id, nonce: pending.hint.nonce, reason: "The extension service worker is unavailable." });
        continue;
      }
      void fallback.then((result) => {
        const current = pendingHints.get(pending.hint.request_id);
        if (!current) return;
        current.fallbackInFlight = false;
        if (!result.ok) {
          if (result.kind === "context_invalidated") controller.dispose();
          else completePendingHint({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: pending.hint.request_id, nonce: pending.hint.nonce, reason: "The extension service worker is unavailable." });
          return;
        }
        const response = result.value;
        if (response?.accepted) completePendingHint({ type: "JOBHUNT_DISPATCH_ACCEPTED", version: 1, request_id: pending.hint.request_id, nonce: pending.hint.nonce });
        else completePendingHint({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: pending.hint.request_id, nonce: pending.hint.nonce, reason: response?.reason || "The extension could not accept the dispatch hint." });
      }).catch(() => {
        const current = pendingHints.get(pending.hint.request_id);
        if (current) {
          current.fallbackInFlight = false;
          completePendingHint({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: pending.hint.request_id, nonce: pending.hint.nonce, reason: "The extension service worker is unavailable." });
        }
      });
    }
  }

  function connectPagePort() {
    if (disposed || pagePort) return;
    try {
      const port = chrome.runtime.connect({ name: JOBHUNT_PAGE_PORT_NAME });
      pagePort = port;
      portMessageListener = (raw: unknown) => {
        const message = raw as ExtensionToPageMessage;
        if (message?.type === "JOBHUNT_DISPATCH_ACCEPTED" || message?.type === "JOBHUNT_DISPATCH_REJECTED") completePendingHint(message);
        else if (message?.type === "JOBHUNT_DISPATCH_UPDATED") pageMessage(message);
      };
      portDisconnectListener = () => {
        if (pagePort !== port) return;
        detachPagePort(port);
      };
      port.onMessage.addListener(portMessageListener);
      port.onDisconnect.addListener(portDisconnectListener);
      clearPortStabilityTimer();
      portStabilityTimer = setTimeout(() => {
        if (pagePort === port) reconnectAttempts = 0;
        portStabilityTimer = null;
      }, PAGE_PORT_STABILITY_WINDOW_MS);
      flushPendingHints();
    } catch (error) {
      pagePort = null;
      if (runtimeMessageFailureKind(error) === "context_invalidated") {
        controller.dispose();
        return;
      }
      schedulePortReconnect();
    }
  }

  function sendDispatchHint(hint: DispatchHint) {
    if (disposed) return;
    if (!pendingHints.has(hint.request_id)) {
      if (pendingHints.size >= MAX_PENDING_PAGE_HINTS) {
        const oldest = pendingHints.keys().next().value;
        if (typeof oldest === "string") {
          const dropped = pendingHints.get(oldest);
          pendingHints.delete(oldest);
          if (dropped) pageMessage({ type: "JOBHUNT_DISPATCH_REJECTED", version: 1, request_id: dropped.hint.request_id, nonce: dropped.hint.nonce, reason: "The extension bridge queue is full; retry the dispatch." });
        }
      }
      pendingHints.set(hint.request_id, { hint, sentPort: null, fallbackInFlight: false });
    }
    flushPendingHints();
  }

  connectPagePort();

  windowMessageListener = (event) => {
    if (event.source !== window || event.origin !== window.location.origin || disposed) return;
    const message = parsePageMessage(event.data);
    if (!message) return;
    if (message.type === "JOBHUNT_BRIDGE_PROBE") {
      pageMessage({ type: "JOBHUNT_BRIDGE_READY", version: 1, extensionBuildId: EXTENSION_BUILD_ID, contentInstanceId });
      return;
    }
    if (message.type === "JOBHUNT_BRIDGE_RESET_LOCAL") {
      safeRuntimeSend({ type: "RESET_LOCAL_PAIRING" });
      return;
    }
    const hint = message as DispatchHint;
    sendDispatchHint(hint);
  };
  window.addEventListener("message", windowMessageListener);

  pageMessage({ type: "JOBHUNT_BRIDGE_READY", version: 1, extensionBuildId: EXTENSION_BUILD_ID, contentInstanceId });
})();
