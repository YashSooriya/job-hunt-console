"use client";

import { useEffect, useState } from "react";
import { readBridgeApiJson } from "@/lib/chatgpt-bridge/client";

export function DiagnosticsJobSearchCooldownToggle() {
  const [disabled, setDisabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/diagnostics/job-search-cooldown", { cache: "no-store" })
      .then((response) => readBridgeApiJson<{ ok?: boolean; disabled?: boolean; error?: string }>(response).then((body) => {
        if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to read diagnostic settings.");
        if (!cancelled) {
          setDisabled(body.disabled === true);
          setLoaded(true);
        }
      }))
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to read diagnostic settings.");
      });
    return () => { cancelled = true; };
  }, []);

  async function update(next: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/diagnostics/job-search-cooldown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: next }),
      });
      const body = await readBridgeApiJson<{ ok?: boolean; disabled?: boolean; error?: string }>(response);
      if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to update diagnostic settings.");
      setDisabled(body.disabled === true);
      setMessage(body.disabled === true ? "Cooldown disabled for diagnostic testing." : "One-hour cooldown restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update diagnostic settings.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="card diagnosticCooldownCard">
    <div className="cardHeader">
      <div>
        <div className="eyebrow">Diagnostic controls</div>
        <h2>Manual-search cooldown</h2>
        <p>Use this only while testing consecutive Website Bridge sends. It applies to your account and does not change the normal one-hour policy for other users.</p>
      </div>
      <span className="badge muted">Testing only</span>
    </div>
    <div className="diagnosticCooldownBody">
      <label className="checkLabel">
        <input type="checkbox" checked={disabled} disabled={!loaded || busy} onChange={(event) => void update(event.target.checked)} />
        Disable the one-hour “Search jobs now” cooldown
      </label>
      <p className="formHelp">Restore the checkbox after testing so manual searches remain limited to once per hour.</p>
      {message ? <p className="notice">{message}</p> : null}
      {error ? <p className="formError">{error}</p> : null}
    </div>
  </section>;
}
