"use client";

import { useEffect, useState } from "react";
import { readBridgeApiJson } from "@/lib/chatgpt-bridge/client";

export function DiagnosticsChatGptActionLockToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/diagnostics/chatgpt-action-lock", { cache: "no-store" })
      .then((response) => readBridgeApiJson<{ ok?: boolean; enabled?: boolean; error?: string }>(response).then((body) => {
        if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to read the ChatGPT action-lock setting.");
        if (!cancelled) {
          setEnabled(body.enabled === true);
          setLoaded(true);
        }
      }))
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to read the ChatGPT action-lock setting.");
        }
      });
    return () => { cancelled = true; };
  }, []);

  async function update(next: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/diagnostics/chatgpt-action-lock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await readBridgeApiJson<{ ok?: boolean; enabled?: boolean; error?: string }>(response);
      if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to update the ChatGPT action-lock setting.");
      setEnabled(body.enabled === true);
      window.dispatchEvent(new Event("jobhunt:chatgpt-operation-setting-changed"));
      setMessage(body.enabled === true
        ? "Diagnostics override is on. Additional ChatGPT actions can start while another is active; their work may interleave."
        : "The site-wide ChatGPT action lock is restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update the ChatGPT action-lock setting.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="card diagnosticCooldownCard">
    <div className="cardHeader">
      <div>
        <div className="eyebrow">Diagnostic controls</div>
        <h2>Site-wide ChatGPT action lock</h2>
        <p>Bypass the normal one-action-at-a-time rule for your account while diagnosing the Website Bridge. Concurrent tasks can overlap in ChatGPT, so leave this off during normal use.</p>
      </div>
      <span className={`badge ${enabled ? "action" : "muted"}`}>{enabled ? "Override on" : "Testing only"}</span>
    </div>
    <div className="diagnosticCooldownBody">
      <label className="checkLabel">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded || busy}
          onChange={(event) => void update(event.target.checked)}
        />
        Allow ChatGPT actions while another action is active
      </label>
      <p className="formHelp">The default is off. Restoring the lock is prevented while any ChatGPT action is still active. All actions continue through the existing Website Bridge dispatch and response-capture flow.</p>
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </div>
  </section>;
}
