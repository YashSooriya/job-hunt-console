"use client";

import { useCallback, useEffect, useState } from "react";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import { readBridgeApiJson } from "@/lib/chatgpt-bridge/client";
import { bridgeConnectionLabel, bridgeConnectionState, type BridgeStatusSummary } from "@/lib/chatgpt-bridge/lifecycle";
import { useLocalBridgeStatus } from "@/lib/chatgpt-bridge/local-status";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";

type Device = {
  id: string;
  display_name: string;
  platform: string;
  extension_version?: string | null;
  bound_conversation_url?: string | null;
  bound_project_name?: string | null;
  bound_project_verified?: boolean;
  conversations?: Conversation[];
  automatic_send_enabled?: boolean;
  preferred?: boolean;
  last_seen_at?: string | null;
  online?: boolean;
};

type Conversation = {
  id: string;
  workflow_key: string;
  display_name: string;
  conversation_url: string;
  project_name?: string;
  project_verified?: boolean;
  bound_at?: string | null;
  last_used_at?: string | null;
  last_dispatch_at?: string | null;
  active?: boolean;
};

type Status = { ok?: boolean; error?: string; devices?: Device[]; memory?: { memory_enabled_user_confirmed?: boolean; use_previous_knowledge?: boolean }; bridge?: BridgeStatusSummary };

function dateLabel(value?: string | null) {
  if (!value) return "Not seen yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en-GB");
}

function hasConversation(device: Device, workflowKey: string) {
  return (device.conversations || []).some((conversation) => conversation.workflow_key === workflowKey && conversation.project_verified !== false);
}

export function ChatGptBridgeSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; bridgeUrl: string | null } | null>(null);
  const [diagnostic, setDiagnostic] = useState<{ id: string; state?: string; response?: string } | null>(null);
  const diagnosticStatus = useDispatchStatus(diagnostic?.id || null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const localBridge = useLocalBridgeStatus();
  const chatgptOperation = useChatGptOperation();
  const diagnosticWaiting = isWaitingForChatGpt({ state: diagnosticStatus.state || undefined, raw: diagnosticStatus.dispatch?.raw });

  const refresh = useCallback(async () => {
    const response = await fetch("/api/chatgpt-bridge/status", { cache: "no-store" });
    const body = await readBridgeApiJson<Status>(response);
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
      const body = await readBridgeApiJson<{ ok?: boolean; pairing_code?: string; expires_at?: string; bridge_url?: string | null; error?: string }>(response);
      if (!response.ok || !body.ok || typeof body.pairing_code !== "string" || typeof body.expires_at !== "string") throw new Error(body.error || "Unable to create a pairing code.");
      setPairing({ code: body.pairing_code, expiresAt: body.expires_at, bridgeUrl: body.bridge_url || null });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create a pairing code."); }
    finally { setBusy(false); }
  }

  async function revoke(deviceId: string) {
    if (!window.confirm("Revoke this ChatGPT bridge? This removes every bound workflow conversation and resets the bridge so the chats must be set up again. The Project and conversations will remain in ChatGPT; only JobHuntAI's bindings and device access are removed.")) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId }) });
      const body = await readBridgeApiJson<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to revoke the bridge device.");
      // Reset only the browser credential that was just revoked. A previous
      // unscoped message cleared a newly paired device when an older server
      // row was revoked from this page.
      window.postMessage({ type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 2, deviceId }, window.location.origin);
      setPairing(null);
      setDiagnostic(null);
      void localBridge.refresh();
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to revoke the bridge device."); }
    finally { setBusy(false); }
  }

  async function runDiagnostic() {
    const operationToken = chatgptOperation.beginLocalOperation("Send harmless diagnostic");
    if (!operationToken) { setError(chatgptOperation.message || "Another ChatGPT task is already active."); return; }
    setBusy(true); setError(null); setDiagnostic(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/test", { method: "POST" });
      const body = await readBridgeApiJson<{ ok?: boolean; dispatch?: { id?: string }; bridge_hint?: unknown; error?: string }>(response);
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to queue the diagnostic.");
      setDiagnostic(typeof body.dispatch?.id === "string" ? { id: body.dispatch.id, state: "queued" } : null);
      if (body.bridge_hint) notifyBridgeHint(body.bridge_hint);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to queue the diagnostic."); }
    finally { setBusy(false); chatgptOperation.finishLocalOperation(operationToken); }
  }

  const devices = status?.devices || [];
  const selectedDevice = devices.find((device) => device.preferred) || devices[0] || null;
  const connectionState = bridgeConnectionState(status?.bridge || null, localBridge.status);
  return <section className="card settingsCard bridgeSettingsCard" id="chatgpt-bridge">
    <div className="cardHeader"><div><div className="eyebrow">Plus browser bridge</div><h2>ChatGPT website dispatch</h2><p>One-click actions open the correct workflow conversation and send a plain-language task through the visible ChatGPT website. This is website automation, not an OpenAI API integration.</p></div><span className={`badge ${devices.length ? "review" : "muted"}`}>{devices.length ? `${devices.length} device${devices.length === 1 ? "" : "s"}` : "Not paired"}</span></div>
    <div className="notice settingsNotice bridgeIntro"><strong>Streamlined setup</strong><p>The extension creates or reuses the exact “JobHuntAI” Project, then creates and binds only the missing workflow chats automatically. Each workflow has its own conversation, and rebinding one workflow rotates only that chat. Automatic Send is enabled automatically after pairing. Memory remains controlled by ChatGPT; JobHuntAI stores the workflow state and dispatch record.</p></div>
    {devices.length ? <div className="bridgeDeviceList">{devices.map((device) => { const conversations = device.conversations || []; return <article className="bridgeDevice" key={device.id}>
      <div className="bridgeDeviceHeader">
        <div className="bridgeDeviceIdentity"><span>{device.display_name} · {device.platform}</span><strong>{conversations.length ? `${conversations.length} workflow conversation${conversations.length === 1 ? "" : "s"} bound` : "No workflow conversations bound"}</strong><small>Last heartbeat: {dateLabel(device.last_seen_at)} · {device.extension_version || "version unknown"}</small></div>
        <div className="bridgeDeviceActions"><div className="badges"><span className={`badge ${device.online ? "review" : "action"}`}>{device.online ? "Online" : "Offline"}</span><span className={`badge ${device.automatic_send_enabled ? "review" : "action"}`}>{device.automatic_send_enabled ? "Automatic Send on" : "Automatic Send enabling"}</span></div><button className="secondaryButton" disabled={busy} onClick={() => void revoke(device.id)}>Revoke</button></div>
      </div>
      {conversations.length ? <div className="bridgeConversationList"><div className="bridgeConversationHeading"><strong>Workflow conversations</strong><span>{conversations.length} connected</span></div><div className="bridgeConversationGrid">{conversations.map((conversation) => <a className="bridgeConversation" key={conversation.id} href={conversation.conversation_url} target="_blank" rel="noreferrer"><span>{conversation.display_name}</span><small>{conversation.workflow_key} · open chat ↗</small></a>)}</div></div> : null}
    </article>; })}</div> : <p className="emptyState bridgeEmptyState">No ChatGPT bridge is paired. Existing employer-form helper devices are separate and are not reused.</p>}
    <div className="buttonRow settingsActions bridgeActions"><button className="primaryButton" disabled={busy} onClick={() => void createPairingCode()}>Pair ChatGPT bridge</button><button className="secondaryButton" disabled={busy || chatgptOperation.blocked || !devices.some((device) => hasConversation(device, "bridge.diagnostic"))} onClick={() => void runDiagnostic()}>{diagnosticWaiting ? <><span className="chatgptActivitySpinner" aria-hidden="true" /> Waiting for ChatGPT…</> : "Send harmless diagnostic"}</button></div>
    {pairing ? <div className="notice actionNotice settingsNotice bridgePairing"><strong>Enter this one-time code in the extension</strong><pre className="commandBlock">{pairing.code}</pre><p>Expires {dateLabel(pairing.expiresAt)}. Bridge endpoint: <code>{pairing.bridgeUrl || "configured Supabase Edge Function"}</code>. The device credential is stored only in <code>chrome.storage.local</code> and can be revoked here.</p></div> : null}
    <div className="chatgptStatusList bridgeStatusList"><div><span>ChatGPT login</span><strong>Verified by the paired Website Bridge</strong></div><div><span>Browser bridge</span><strong>{bridgeConnectionLabel(connectionState)}{selectedDevice && localBridge.status.deviceId && selectedDevice.id.toLowerCase() !== localBridge.status.deviceId.toLowerCase() ? " · local device differs from selected server device" : ""}</strong></div><div><span>Workflow conversations</span><strong>{devices.some((device) => (device.conversations || []).length > 0) ? "Bound and server-recorded" : "Run automatic setup to create the Project and workflow chats"}</strong></div><div><span>Memory</span><strong>{status?.memory?.memory_enabled_user_confirmed ? "User confirmed enabled" : "Please enable and confirm in ChatGPT Settings → Personalization"}</strong></div><div><span>Result path</span><strong>Website Bridge response capture with exact-turn provenance</strong></div></div>
    {diagnostic ? <div className="syncMessage">Diagnostic {diagnostic.id} · {diagnosticStatus.state || diagnostic.state || "queued"}{diagnosticStatus.response || diagnostic.response ? <pre className="commandBlock">{diagnosticStatus.response || diagnostic.response}</pre> : diagnosticWaiting ? <span><span className="chatgptActivitySpinner" aria-hidden="true" /> Waiting for ChatGPT’s response.</span> : <span> Waiting for the Website Bridge.</span>}{diagnosticStatus.error ? <span> {diagnosticStatus.error} Retrying…</span> : null}</div> : null}
    {error ? <p className="formError">{error}</p> : null}
  </section>;
}
