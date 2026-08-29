"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { dispatchStateLabel } from "@/lib/chatgpt-bridge/client";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import styles from "./diagnostics-message-form.module.css";

const MAX_MESSAGE_CHARS = 6000;
const TERMINAL_STATES = new Set(["completed", "failed", "user_required", "expired", "cancelled"]);
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

function readDispatchStatus(value: unknown, id: string): DispatchStatus {
  const dispatch = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    id,
    state: typeof dispatch.state === "string" ? dispatch.state : undefined,
    response: typeof dispatch.bridge_response === "string" ? dispatch.bridge_response : undefined,
  };
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

export function DiagnosticsMessageForm() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<DispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retryKey = useRef<{ message: string; key: string } | null>(null);

  useEffect(() => {
    if (!status?.id) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/chatgpt-bridge/dispatch?id=${encodeURIComponent(status.id)}`, { cache: "no-store" });
        const body = await response.json() as { ok?: boolean; dispatch?: unknown; error?: string };
        if (!response.ok || !body.ok) throw new Error(body.error || "Unable to read the diagnostic dispatch status.");
        if (cancelled) return;
        const next = readDispatchStatus(body.dispatch, status.id);
        setStatus(next);
        if (!TERMINAL_STATES.has(next.state || "")) timer = window.setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 3000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [status?.id]);

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

  const stateLabel = status ? dispatchStateLabel(status.state || "queued") : null;
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
        <button className="primaryButton" type="submit" disabled={busy || !message.trim() || Boolean(status && !TERMINAL_STATES.has(status.state || ""))}>{busy ? "Sending…" : "Send to ChatGPT"}</button>
      </div>
    </form>

    {status ? <div className={`syncMessage ${styles.status}`}>
      <strong>Dispatch {status.id}</strong>
      <span>{stateLabel || "Waiting for bridge status"}</span>
      {status.response ? <pre className={`commandBlock ${styles.response}`}>{status.response}</pre> : <span>The Website Bridge will report the ChatGPT response here.</span>}
    </div> : null}
    {error ? <p className="formError">{error}</p> : null}
  </section>;
}
