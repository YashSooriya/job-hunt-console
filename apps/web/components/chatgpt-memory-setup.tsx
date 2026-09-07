"use client";

import { useCallback, useEffect, useState } from "react";
import { notifyBridgeHints } from "@/lib/chatgpt-bridge/notify";

type MemoryState = {
  confirmed: boolean;
  decision: "undecided" | "allowed" | "declined" | string;
  memorySyncEnabled: boolean;
  reminderRequired: boolean;
  importStatus: "not_requested" | "queued" | "in_progress" | "completed" | "failed" | "user_required" | string;
  importDispatchId?: string | null;
  importError?: string | null;
  responseCheckAvailable?: boolean;
  manualReviewRequired?: boolean;
  bridge?: {
    paired: boolean;
    online: boolean;
    automaticSendEnabled: boolean;
    extensionVersion: string | null;
    hasProfessionalBackgroundConversation: boolean;
    workflowConversationCount: number;
  } | null;
};

type SourceDocumentSummary = {
  id: string;
  original_name?: string | null;
  source_type?: string | null;
  extraction_format?: string | null;
  extraction_status?: string | null;
};

const activeImportStatuses = new Set(["queued", "in_progress"]);

export function ChatGptMemorySetup({
  sourceDocuments = [],
  savedLinkedinUrl = "",
  linkedinUrl = "",
  additionalInformation = "",
  hasUnsavedSourceChanges = false,
  onSaveSources,
  onProfileChanged,
  onMemoryChanged,
}: {
  sourceDocuments?: SourceDocumentSummary[];
  savedLinkedinUrl?: string;
  linkedinUrl?: string;
  additionalInformation?: string;
  hasUnsavedSourceChanges?: boolean;
  onSaveSources?: () => Promise<boolean>;
  onProfileChanged?: () => void;
  onMemoryChanged?: (memory: MemoryState) => void;
}) {
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const savedSources = sourceDocuments.filter((source) => Boolean(source?.id));
  const savedLinkedin = savedLinkedinUrl.trim();
  const pendingLinkedin = linkedinUrl.trim();
  const pendingAdditionalInformation = additionalInformation.trim();

  const refresh = useCallback(async () => {
    const response = await fetch("/api/onboarding/memory", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "ChatGPT Memory setup is unavailable.");
    const next = data.memory as MemoryState;
    setMemory(next);
    onMemoryChanged?.(next);
    if (next.importStatus === "completed") onProfileChanged?.();
    // A bridge timeout can leave a queued notice in the component even after
    // the server has safely stopped the request. Do not tell the user that a
    // request is still queued when the next action is review or a read-only
    // response check.
    if (next.importStatus === "user_required" || next.importStatus === "failed") setMessage(null);
    return next;
  }, [onMemoryChanged, onProfileChanged]);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "ChatGPT Memory setup is unavailable."));
  }, [refresh]);

  useEffect(() => {
    if (!memory || !activeImportStatuses.has(memory.importStatus)) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await refresh();
        if (!cancelled && activeImportStatuses.has(next.importStatus)) timer = window.setTimeout(() => void poll(), 2500);
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 4000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1800);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [memory?.importStatus, refresh]);

  useEffect(() => {
    const requestId = memory?.importDispatchId;
    if (!requestId || typeof window === "undefined") return;
    const onBridgeMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const payload = event.data as { type?: string; request_id?: string; reason?: string } | null;
      if (!payload || payload.request_id !== requestId) return;
      if (payload.type === "JOBHUNT_DISPATCH_ACCEPTED") {
        setMessage(`Website Bridge accepted request ${requestId} and is delivering it to the bound ChatGPT conversation. The staged bundle will be processed there; this page will update when the JSON is returned.`);
      } else if (payload.type === "JOBHUNT_DISPATCH_REJECTED") {
        setError(payload.reason || "The Website Bridge did not accept the ChatGPT Memory request.");
      }
    };
    window.addEventListener("message", onBridgeMessage);
    return () => window.removeEventListener("message", onBridgeMessage);
  }, [memory?.importDispatchId]);

  async function choose(action: "allow_and_import" | "decline" | "reset" | "check_completed_response") {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (action === "allow_and_import" && hasUnsavedSourceChanges) {
        if (!onSaveSources) throw new Error("Save the selected sources before using ChatGPT Memory.");
        setMessage("Saving the selected sources before queueing the ChatGPT Memory request…");
        const saved = await onSaveSources();
        if (!saved) return;
      }
      const response = await fetch("/api/onboarding/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to save the ChatGPT Memory choice.");
      notifyBridgeHints(data.bridge_hints || data.bridge_hint);
      const nextMemory = data.memory as MemoryState;
      setMemory(nextMemory);
      onMemoryChanged?.(nextMemory);
      const requestStillActive = activeImportStatuses.has(nextMemory.importStatus);
      const dispatches = Array.isArray(data.dispatches)
        ? data.dispatches.filter((dispatch: any) => typeof dispatch?.id === "string")
        : data.dispatch?.id ? [data.dispatch] : [];
      if (action === "allow_and_import" && requestStillActive) {
        // The POST response can be missing the bridge readiness snapshot when
        // the extension is waking. Refresh once so the user sees the actual
        // paired/online state immediately instead of a misleading idle card.
        const refreshed = await refresh().catch(() => nextMemory);
        const currentRequestId = typeof refreshed.importDispatchId === "string"
          ? refreshed.importDispatchId
          : typeof nextMemory.importDispatchId === "string" ? nextMemory.importDispatchId : "";
        if (activeImportStatuses.has(refreshed.importStatus)) {
          const requestLabel = currentRequestId ? `Request ${currentRequestId} is` : "The request is";
          setMessage(`${requestLabel} queued with ${dispatches.length || 1} Website Bridge message${(dispatches.length || 1) === 1 ? "" : "s"}. ChatGPT will read exactly the staged bundle shown below, update its Memory, then create and return professional-profile.json for the editable fields.`);
        } else if (refreshed.importStatus === "user_required" || refreshed.importStatus === "failed") {
          setMessage(refreshed.importError || "The Website Bridge stopped the request and needs your attention. Review the bound ChatGPT conversation before retrying.");
        }
      } else setMessage(action === "check_completed_response"
          ? "Checking the bound ChatGPT conversation for an already completed professional-profile.json response. No new ChatGPT message will be sent."
          : action === "decline"
            ? "ChatGPT Memory will not be used. You can still build a complete profile from your details, CVs, LinkedIn and other information."
            : null);
      if (action === "reset") onProfileChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the ChatGPT Memory choice.");
    } finally {
      setBusy(false);
    }
  }

  if (!memory) return null;

  const undecided = memory.decision === "undecided";
  const allowed = memory.decision === "allowed" || memory.confirmed;
  const importing = activeImportStatuses.has(memory.importStatus);
  const completed = memory.importStatus === "completed";
  const responseCheckAvailable = memory.responseCheckAvailable === true;
  const manualReviewRequired = memory.manualReviewRequired === true;
  const bridgeMessage = !memory.bridge
    ? "The request is queued, but the Website Bridge status cannot be checked right now."
    : !memory.bridge.paired
      ? "The request is queued, but no ChatGPT Website Bridge is paired yet. Pair the extension; Automatic Send is enabled automatically."
      : !memory.bridge.hasProfessionalBackgroundConversation
        ? "The Professional background workflow chat is not set up on this bridge. Update or reload the latest extension and choose Set up missing workflow chats. Automatic Send is enabled automatically."
        : !memory.bridge.online
          ? "The workflow chat is ready, but the paired bridge is offline. Keep ChatGPT open with the extension enabled."
          : !memory.bridge.automaticSendEnabled
            ? "The workflow chat is ready while Automatic Send is being enabled. Keep the extension open for a moment and try again."
            : "The Website Bridge is ready. Keep ChatGPT open while the source Memory updates and profile import are processed.";

  return <section className="card memorySetupCard" aria-labelledby="memory-setup-title">
    <div className="cardHeader"><div><div className="eyebrow">Step 2 · Optional</div><h2 id="memory-setup-title">Use your ChatGPT Memory?</h2><p>Allow ChatGPT to fill the exact JobHuntAI onboarding fields with the professional information it already remembers.</p></div><span className={`badge ${allowed ? "review" : undecided ? "action" : "muted"}`}>{allowed ? "Allowed" : undecided ? "Not chosen" : "Not using"}</span></div>
    {undecided ? <>
      <p className="memorySetupCopy">ChatGPT will return only the fields used on this page, including your contact details, work authorisation, employment, education, skills, projects, publications, certifications and job-search preferences. Only the saved bundle shown below is staged for this request. ChatGPT will update its Memory, create and download professional-profile.json, and return the same JSON for automatic import. You will check and edit the actual fields below before sending any additions or corrections back to Memory.</p>
      <div className="memoryStagedPanel" aria-label="Staged ChatGPT Memory source bundle">
        <div className="memoryStagedHeader"><strong>What will be staged for ChatGPT</strong><span className="badge muted">{savedSources.length + (savedLinkedin ? 1 : 0)} saved source{savedSources.length + (savedLinkedin ? 1 : 0) === 1 ? "" : "s"}</span></div>
        {savedSources.length || savedLinkedin ? <ul>
          {savedSources.map((source) => <li key={source.id}><strong>{source.original_name || "Saved professional document"}</strong><span>{source.source_type ? String(source.source_type).replaceAll("_", " ") : "document"}{source.extraction_format ? ` · ${source.extraction_format}` : ""}{source.extraction_status ? ` · ${String(source.extraction_status).replaceAll("_", " ")}` : ""}</span></li>)}
          {savedLinkedin ? <li><strong>LinkedIn profile</strong><span>{savedLinkedin}</span></li> : null}
        </ul> : <p className="memoryStagedEmpty">No saved CV, document or LinkedIn URL. ChatGPT will use only the professional information already in its Memory.</p>}
        {hasUnsavedSourceChanges ? <div className="memoryStagedWarning"><strong>Pending source changes will be saved first.</strong><span>{pendingLinkedin && pendingLinkedin !== savedLinkedin ? "The edited LinkedIn URL" : pendingAdditionalInformation ? "The additional information" : "The selected document"} will be saved to this onboarding profile when you press Yes, then the complete saved bundle will be queued for ChatGPT.</span></div> : <p className="memoryStagedFootnote">Pressing Yes queues one Website Bridge request for exactly these saved sources. It does not send any other page data.</p>}
      </div>
      <div className="buttonRow memorySetupActions"><button className="primaryButton" type="button" disabled={busy} onClick={() => void choose("allow_and_import")}>{busy ? "Starting…" : hasUnsavedSourceChanges ? "Save sources and use ChatGPT Memory" : "Yes, use ChatGPT Memory"}</button><button className="secondaryButton" type="button" disabled={busy} onClick={() => void choose("decline")}>No, I’ll fill it in myself</button></div>
    </> : allowed ? <>
      <p className="memorySetupCopy">ChatGPT Memory access is allowed. Add or update your CVs, LinkedIn URL and additional information in the source section above, then choose <strong>Save sources and build profile</strong>. One Website Bridge request will give ChatGPT the complete saved source bundle, update its Memory, and create/download professional-profile.json for automatic import. Imported values will be placed directly into the editable fields; empty fields are highlighted, and saving a correction or addition marks it for the single combined Memory update later.</p>
      <div className="buttonRow memorySetupActions">
        {importing ? <div className="memorySetupProgress"><span className="formHint">ChatGPT is updating Memory and creating your structured onboarding profile…</span><p>{bridgeMessage} <a href="/settings#chatgpt-bridge" className="textLink">Open Website Bridge settings</a>.</p></div>
          : completed ? <span className="formHint">Profile import complete. Review and edit the fields below.</span>
            : responseCheckAvailable ? <div className="memorySyncActions"><span className="formHint">ChatGPT may have finished after the bridge timed out.</span><button className="primaryButton" type="button" disabled={busy} onClick={() => void choose("check_completed_response")}>{busy ? "Checking…" : "Check existing response"}</button></div>
          : manualReviewRequired ? <div className="memorySyncActions"><span className="formHint">Automatic recovery is unavailable because this request has no safe exact-turn anchor. Review the bound Professional background chat before starting another request.</span><a href="/settings#chatgpt-bridge" className="textLink">Open Website Bridge settings</a></div>
          : <button className="primaryButton" type="button" disabled={busy} onClick={() => void choose("allow_and_import")}>{busy ? "Starting…" : hasUnsavedSourceChanges ? "Save sources and get profile" : "Get profile from ChatGPT again"}</button>}
        <button className="textLink" type="button" disabled={busy} onClick={() => void choose("reset")}>Change choice</button>
      </div>
    </> : <>
      <p className="memorySetupCopy">ChatGPT Memory is not being used. You can still build a complete JobHuntAI profile from the information you provide here.</p>
      <div className="buttonRow memorySetupActions"><button className="secondaryButton" type="button" disabled={busy} onClick={() => void choose("allow_and_import")}>{busy ? "Starting…" : "Allow and get profile from ChatGPT"}</button></div>
    </>}
    {message ? <div className="notice">{message}</div> : null}
    {memory.importError ? <div className="formError">{memory.importError}</div> : null}
    {error ? <div className="formError">{error}</div> : null}
  </section>;
}
