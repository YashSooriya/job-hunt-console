"use client";

import { useCallback, useEffect, useState } from "react";

type Device = {
  id: string;
  display_name: string;
  platform: string;
  extension_version?: string | null;
  bound_conversation_url?: string | null;
  bound_project_name?: string | null;
  bound_project_verified?: boolean;
  automatic_send_enabled?: boolean;
  preferred?: boolean;
  last_seen_at?: string | null;
  online?: boolean;
};

type Status = { devices?: Device[]; memory?: { memory_enabled_user_confirmed?: boolean; use_previous_knowledge?: boolean } };

function dateLabel(value?: string | null) {
  if (!value) return "Not seen yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en-GB");
}

export function ChatGptBridgeSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; bridgeUrl: string | null } | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/chatgpt-bridge/status", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || "ChatGPT bridge status unavailable.");
    setStatus(body);
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "ChatGPT bridge status unavailable."));
    const timer = window.setInterval(() => { refresh().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function createPairingCode() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/pairing", { method: "POST" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to create a pairing code.");
      setPairing({ code: body.pairing_code, expiresAt: body.expires_at, bridgeUrl: body.bridge_url || null });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create a pairing code."); }
    finally { setBusy(false); }
  }

  async function revoke(deviceId: string) {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to revoke the bridge device.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to revoke the bridge device."); }
    finally { setBusy(false); }
  }

  async function runDiagnostic() {
    setBusy(true); setError(null); setDiagnostic(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/test", { method: "POST" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to queue the diagnostic.");
      setDiagnostic(String(body.dispatch?.id || "Diagnostic queued. The extension will deliver it when ready."));
      if (body.bridge_hint) window.postMessage(body.bridge_hint, window.location.origin);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to queue the diagnostic."); }
    finally { setBusy(false); }
  }

  const devices = status?.devices || [];
  return <section className="card" id="chatgpt-bridge">
    <div className="cardHeader"><div><div className="eyebrow">Plus browser bridge</div><h2>ChatGPT website dispatch</h2><p>One-click Job Hunt actions can open the bound ChatGPT Project conversation and send a short opaque dispatch command. This is visible website automation, not an OpenAI API integration.</p></div><span className={`badge ${devices.length ? "review" : "muted"}`}>{devices.length ? `${devices.length} device${devices.length === 1 ? "" : "s"}` : "Not paired"}</span></div>
    <div className="notice"><strong>One-time setup</strong><p>Create the “Job Hunt” Project and a dedicated conversation in ChatGPT. In the extension, bind the currently visible conversation only after the Project name is verified. Memory remains controlled by ChatGPT; Job Hunt only records your reminder.</p></div>
    {devices.length ? <div className="factsList">{devices.map((device) => <div className="factRow" key={device.id}><div><span>{device.display_name} · {device.platform}</span><strong>{device.bound_project_verified ? "Job Hunt conversation bound" : "Conversation not bound"}</strong><small>Last heartbeat: {dateLabel(device.last_seen_at)} · {device.extension_version || "version unknown"}</small></div><div className="badges"><span className={`badge ${device.online ? "review" : "action"}`}>{device.online ? "Online" : "Offline"}</span><span className={`badge ${device.automatic_send_enabled ? "review" : "muted"}`}>{device.automatic_send_enabled ? "Automatic Send on" : "Automatic Send off"}</span><button className="secondaryButton" disabled={busy} onClick={() => void revoke(device.id)}>Revoke</button></div></div>)}</div> : <p className="emptyState">No ChatGPT bridge is paired. Existing employer-form helper devices are separate and are not reused.</p>}
    <div className="buttonRow"><button className="primaryButton" disabled={busy} onClick={() => void createPairingCode()}>Pair ChatGPT bridge</button><button className="secondaryButton" disabled={busy || !devices.some((device) => device.bound_project_verified)} onClick={() => void runDiagnostic()}>Send harmless diagnostic</button></div>
    {pairing ? <div className="notice actionNotice"><strong>Enter this one-time code in the extension</strong><pre className="commandBlock">{pairing.code}</pre><p>Expires {dateLabel(pairing.expiresAt)}. Bridge endpoint: <code>{pairing.bridgeUrl || "configured Supabase Edge Function"}</code>. The device credential is stored only in <code>chrome.storage.local</code> and can be revoked here.</p></div> : null}
    <div className="chatgptStatusList"><div><span>ChatGPT login</span><strong>Verified in the ChatGPT tab during binding</strong></div><div><span>Project / conversation</span><strong>{devices.some((device) => device.bound_project_verified) ? "Bound and server-recorded" : "User action required"}</strong></div><div><span>Memory</span><strong>{status?.memory?.memory_enabled_user_confirmed ? "User confirmed enabled" : "Please enable and confirm in ChatGPT Settings → Personalization"}</strong></div><div><span>Result path</span><strong>Authenticated Job Hunt MCP tools; no ChatGPT response scraping</strong></div></div>
    {diagnostic ? <p className="syncMessage">Diagnostic dispatch {diagnostic} queued. Watch its state here or in the ChatGPT conversation.</p> : null}
    {error ? <p className="formError">{error}</p> : null}
  </section>;
}
