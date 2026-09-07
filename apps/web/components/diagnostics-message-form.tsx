"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { dispatchStateLabel } from "@/lib/chatgpt-bridge/client";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import { effectiveDispatchState, isDispatchActive } from "@/lib/chatgpt-bridge/dispatch-state";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { bridgeBuildState, dispatchDiagnostics, lifecycleEntries, lifecycleStatus, type BridgeStatusSummary } from "@/lib/chatgpt-bridge/lifecycle";
import styles from "./diagnostics-message-form.module.css";

const MAX_MESSAGE_CHARS = 6000;
const BLOCKED_PROTOCOL_TERMS = /(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)/i;

type DispatchStatus = {
  id: string;
  state?: string;
  response?: string;
};

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function idempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `bridge.diagnostic.message:${crypto.randomUUID()}`;
  }
  return `bridge.diagnostic.message:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function hasBoundDiagnosticConversation(body: unknown) {
  const value = body && typeof body === "object" ? body as { devices?: unknown } : {};
  return Array.isArray(value.devices) && value.devices.some((device) => {
    if (!device || typeof device !== "object") return false;
    const conversations = (device as { conversations?: unknown }).conversations;
    return Array.isArray(conversations) && conversations.some((conversation) => {
      if (!conversation || typeof conversation !== "object") return false;
      const item = conversation as { workflow_key?: unknown; project_verified?: unknown };
      return item.workflow_key === "bridge.diagnostic" && item.project_verified !== false;
    });
  });
}

const LIFECYCLE_LABELS: Record<string, string> = {
  browser_hint_emitted_at: "Browser hint emitted",
  extension_hint_received_at: "Extension hint received",
  server_claimed_at: "Server claim recorded",
  bound_tab_selected_at: "Bound ChatGPT tab selected",
  content_script_ready_at: "ChatGPT page bridge ready",
  composer_ready_at: "Composer ready",
  send_boundary_recorded_at: "Send boundary recorded",
  user_turn_verified_at: "User turn verified",
  response_detected_at: "Response detected",
  response_uploaded_at: "Response uploaded",
};

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString();
}

export function DiagnosticsMessageForm() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<DispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatusSummary | null>(null);
  const retryKey = useRef<{ message: string; key: string } | null>(null);
  const liveStatus = useDispatchStatus(status?.id || null);

  useEffect(() => {
    let cancelled = false;
    async function refreshBridgeStatus() {
      try {
        const response = await fetch("/api/chatgpt-bridge/status", { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { bridge?: BridgeStatusSummary };
        if (!cancelled && response.ok && body.bridge) setBridgeStatus(body.bridge);
      } catch {
        // The dispatch poller carries the actionable transport error. Keep the
        // version badge quiet if the separate status read is temporarily down.
      }
    }
    void refreshBridgeStatus();
    const timer = window.setInterval(() => { void refreshBridgeStatus(); }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    setError(null);

    if (!trimmed) {
      setError("Enter a diagnostic message first.");
      return;
    }
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      setError(`Keep the diagnostic message to ${MAX_MESSAGE_CHARS.toLocaleString()} characters or fewer.`);
      return;
    }
    if (BLOCKED_PROTOCOL_TERMS.test(trimmed)) {
      setError("Use ordinary plain-language text. Internal bridge protocol terms are blocked from this diagnostic channel.");
      return;
    }

    setBusy(true);
    setStatus(null);
    const key = retryKey.current?.message === trimmed ? retryKey.current.key : idempotencyKey();
    retryKey.current = { message: trimmed, key };
    try {
      const bridgeStatusResponse = await fetch("/api/chatgpt-bridge/status", { cache: "no-store" });
      const bridgeStatus = await bridgeStatusResponse.json() as { ok?: boolean; error?: string; devices?: unknown };
      if (!bridgeStatusResponse.ok || !bridgeStatus.ok) throw new Error(bridgeStatus.error || "ChatGPT bridge status unavailable.");
      if (!hasBoundDiagnosticConversation(bridgeStatus)) {
        throw new Error("Pair the ChatGPT bridge and bind the Bridge diagnostic conversation in Settings before sending a message.");
      }

      const response = await fetch("/api/chatgpt-bridge/diagnostic-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed, idempotencyKey: key }),
      });
      const result = await response.json() as { ok?: boolean; dispatch?: Record<string, unknown>; bridge_hint?: unknown; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to send the diagnostic message.");
      notifyBridgeHint(result.bridge_hint);
      const dispatch = result.dispatch;
      if (!dispatch || typeof dispatch.id !== "string") throw new Error("The diagnostic was accepted without a dispatch id.");
      setStatus({ id: dispatch.id, state: typeof dispatch.state === "string" ? dispatch.state : "queued" });
      setMessage("");
      retryKey.current = null;
    } catch (cause) {
      setError(errorMessage(cause, "Unable to send the diagnostic message."));
    } finally {
      setBusy(false);
    }
  }

  async function retryDispatch() {
    const currentDiagnostics = dispatchDiagnostics(liveStatus.dispatch?.raw || (status ? { id: status.id, state: liveStatus.state || status.state } : {}));
    if (!status || !currentDiagnostics.retryAllowed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/dispatch/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: status.id }),
      });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; dispatch?: Record<string, unknown>; bridge_hint?: unknown; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to retry the dispatch safely.");
      setStatus({ id: status.id, state: typeof result.dispatch?.state === "string" ? result.dispatch.state : "queued" });
      if (result.bridge_hint) notifyBridgeHint(result.bridge_hint);
      await liveStatus.refresh();
    } catch (cause) {
      setError(errorMessage(cause, "Unable to retry the dispatch safely."));
    } finally {
      setBusy(false);
    }
  }

  const currentDispatchState = status ? effectiveDispatchState(liveStatus.state, status.state) : null;
  const stateLabel = currentDispatchState ? dispatchStateLabel(currentDispatchState, liveStatus.dispatch?.raw) : null;
  const diagnostics = dispatchDiagnostics(liveStatus.dispatch?.raw || (status ? { id: status.id, state: currentDispatchState || status.state } : {}));
  const visibleLifecycleStatus = liveStatus.error ? "Bridge transport failed; retrying status" : lifecycleStatus(diagnostics, bridgeStatus);
  const buildState = bridgeBuildState(bridgeStatus);
  return <section className={`card ${styles.panel}`}>
    <div className="cardHeader">
      <div>
        <div className="eyebrow">Bridge diagnostic</div>
        <h1>Send a message to ChatGPT</h1>
        <p className={styles.intro}>Submit plain-language text through the Website Bridge to the bound diagnostic conversation. The bridge opens the authenticated ChatGPT chat, sends the message once, and captures the response here.</p>
      </div>
    </div>

    <form className={styles.form} onSubmit={submit}>
      <label className={styles.label} htmlFor="diagnostic-message">Diagnostic message</label>
      <textarea
        id="diagnostic-message"
        className={`textarea ${styles.textarea}`}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        maxLength={MAX_MESSAGE_CHARS}
        placeholder="Type a harmless message to send to the Bridge diagnostic chat…"
        disabled={busy}
        required
      />
      <div className={styles.actions}>
        <span className={styles.count}>{message.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()} characters</span>
        <button className="primaryButton" type="submit" disabled={busy || !message.trim() || Boolean(status && isDispatchActive(currentDispatchState))}>{busy ? "Sending…" : "Send to ChatGPT"}</button>
      </div>
    </form>

    <div className={styles.bridgeSummary} aria-live="polite">
      <div><span className={styles.summaryLabel}>Extension</span><strong>{bridgeStatus?.extensionVersion || "Not paired"}</strong></div>
      <div><span className={styles.summaryLabel}>Build</span><strong>{bridgeStatus?.extensionBuildId || "Unavailable"}</strong></div>
      <div><span className={styles.summaryLabel}>Connection</span><strong>{buildState === "current" && bridgeStatus?.online ? "Online" : buildState === "outdated" ? "Outdated" : "Waiting for extension"}</strong></div>
    </div>

    {status ? <div className={`syncMessage ${styles.status}`}>
      <strong>Dispatch {status.id}</strong>
      <span>{visibleLifecycleStatus || stateLabel || "Waiting for bridge status"}</span>
      {diagnostics.phase ? <span className={styles.phase}>Recovery phase: {diagnostics.phase}</span> : null}
      {lifecycleEntries(diagnostics.lifecycle).length > 0 ? <ol className={styles.timeline}>
        {lifecycleEntries(diagnostics.lifecycle).map((entry) => <li key={entry.key}><span>{LIFECYCLE_LABELS[entry.key] || entry.key}</span><time dateTime={entry.value}>{formatTimestamp(entry.value)}</time></li>)}
      </ol> : null}
      {liveStatus.response || status.response ? <pre className={`commandBlock ${styles.response}`}>{liveStatus.response || status.response}</pre> : <span>The Website Bridge will report the ChatGPT response here.</span>}
      {liveStatus.error ? <span>{liveStatus.error} Retrying…</span> : null}
      {diagnostics.retryAllowed ? <div className={styles.retryRow}><span>The server confirms Send was never attempted.</span><button className="secondaryButton" type="button" disabled={busy} onClick={() => void retryDispatch()}>Retry safely</button></div> : null}
    </div> : null}
    {error ? <p className="formError">{error}</p> : null}
  </section>;
}
