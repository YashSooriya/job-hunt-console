"use client";

import { useEffect, useState } from "react";
import { readBridgeApiJson } from "@/lib/chatgpt-bridge/client";

export function DiagnosticsTestingModeToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/diagnostics/testing-mode", { cache: "no-store" })
      .then((response) => readBridgeApiJson<{ ok?: boolean; enabled?: boolean; error?: string }>(response).then((body) => {
        if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to read ChatGPT testing mode.");
        if (!cancelled) {
          setEnabled(body.enabled === true);
          setLoaded(true);
        }
      }))
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to read ChatGPT testing mode.");
          setLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, []);

  async function update(next: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/diagnostics/testing-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await readBridgeApiJson<{ ok?: boolean; enabled?: boolean; error?: string }>(response);
      if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to update ChatGPT testing mode.");
      setEnabled(body.enabled === true);
      setMessage(body.enabled === true
        ? "Testing mode is on. New ChatGPT messages will start with a test-only instruction not to change Memory."
        : "Testing mode is off. New ChatGPT messages will use their normal instructions.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update ChatGPT testing mode.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="card diagnosticCooldownCard">
    <div className="cardHeader">
      <div>
        <div className="eyebrow">Diagnostic controls</div>
        <h2>ChatGPT testing mode</h2>
        <p>Prefixes each new Website Bridge message with a clear test-only request not to add, save, or update anything in ChatGPT Memory. This is an instruction to ChatGPT, not a technical guarantee; app data such as imported jobs can still be saved.</p>
      </div>
      <span className={`badge ${enabled ? "success" : "muted"}`}>{enabled ? "Enabled" : "Optional"}</span>
    </div>
    <div className="diagnosticCooldownBody">
      <label className="checkLabel">
        <input type="checkbox" checked={enabled} disabled={!loaded || busy} onChange={(event) => void update(event.target.checked)} />
        Prefix new ChatGPT messages with the test-only Memory warning
      </label>
      <p className="formHelp">The setting applies to your account across the Jobs page and other Website Bridge actions. It does not change how captured responses are retried for upload.</p>
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </div>
  </section>;
}
