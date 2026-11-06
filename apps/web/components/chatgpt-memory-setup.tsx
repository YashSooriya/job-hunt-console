"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifyBridgeHints } from "@/lib/chatgpt-bridge/notify";
import { readApiResponse } from "@/lib/onboarding/client-api";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";

type MemoryState = {
  confirmed: boolean;
  decision: "undecided" | "allowed" | "declined" | string;
  memorySyncEnabled: boolean;
  reminderRequired: boolean;
  importStatus: "not_requested" | "queued" | "in_progress" | "completed" | "failed" | "user_required" | string;
  importDispatchId?: string | null;
  importError?: string | null;
  importQuestions?: string[];
  updateStatus?: "not_requested" | "queued" | "in_progress" | "completed" | "failed" | "user_required" | string;
  updateDispatchIds?: string[];
  updateRequestedAt?: string | null;
  updateCompletedAt?: string | null;
  updateError?: string | null;
  updateRetryAllowed?: boolean;
  updateManualReviewRequired?: boolean;
  responseCheckAvailable?: boolean;
  manualReviewRequired?: boolean;
  bridge?: {
    paired: boolean;
    online: boolean;
    automaticSendEnabled: boolean;
    extensionVersion: string | null;
    extensionBuildId: string | null;
    backgroundFocusPolicyV2: boolean;
    resultCompletionV3: boolean;
    responseProvenanceV3: boolean;
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

type MemoryAction = "allow" | "decline" | "reset" | "check_completed_response";

const activeImportStatuses = new Set(["queued", "in_progress"]);
const activeUpdateStatuses = new Set(["queued", "in_progress"]);

export function ChatGptMemorySetup({
  memory: externalMemory = null,
  sourceDocuments = [],
  savedLinkedinUrl = "",
  linkedinUrl = "",
  additionalInformation = "",
  savedAdditionalInformation = "",
  hasUnsavedSourceChanges = false,
  onProfileChanged,
  onMemoryChanged,
  onMemoryAllowed,
}: {
  memory?: MemoryState | null;
  sourceDocuments?: SourceDocumentSummary[];
  savedLinkedinUrl?: string;
  linkedinUrl?: string;
  additionalInformation?: string;
  savedAdditionalInformation?: string;
  hasUnsavedSourceChanges?: boolean;
  onProfileChanged?: () => void;
  onMemoryChanged?: (memory: MemoryState, action?: MemoryAction) => void;
  onMemoryAllowed?: () => Promise<boolean> | boolean;
}) {
  const [memory, setMemory] = useState<MemoryState | null>(externalMemory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const chatgptOperation = useChatGptOperation();
  const onMemoryChangedRef = useRef(onMemoryChanged);
  const onProfileChangedRef = useRef(onProfileChanged);
  const savedSources = sourceDocuments.filter((source) => Boolean(source?.id));
  const savedLinkedin = savedLinkedinUrl.trim();
  const pendingLinkedin = linkedinUrl.trim();
  const linkedinChanged = pendingLinkedin !== savedLinkedin;
  const additionalInformationChanged = additionalInformation.trim() !== savedAdditionalInformation.trim();
  const pendingAdditionalInformation = additionalInformationChanged
    ? additionalInformation.trim()
    : "";
  const sourceChangeLabel = linkedinChanged
    ? (pendingLinkedin ? "The edited LinkedIn URL" : "The removed LinkedIn URL")
    : additionalInformationChanged
      ? (pendingAdditionalInformation ? "The additional information" : "The removed additional information")
      : "The selected document";

  useEffect(() => {
    if (externalMemory) setMemory(externalMemory);
  }, [externalMemory]);

  // Keep the latest parent callbacks available to the stable refresh
  // function without making its identity change on every parent render.
  useEffect(() => {
    onMemoryChangedRef.current = onMemoryChanged;
  }, [onMemoryChanged]);

  useEffect(() => {
    onProfileChangedRef.current = onProfileChanged;
  }, [onProfileChanged]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/onboarding/memory", { cache: "no-store" });
    const data = await readApiResponse(response, "ChatGPT Memory status is unavailable");
    const next = data.memory as MemoryState;
    setMemory(next);
    onMemoryChangedRef.current?.(next);
    if (next.importStatus === "completed") onProfileChangedRef.current?.();
    // A bridge timeout can leave a queued notice in the component even after
    // the server has safely stopped the request. Do not tell the user that a
    // request is still queued when the next action is review or a read-only
    // response check.
    if (next.importStatus === "user_required" || next.importStatus === "failed") setMessage(null);
    return next;
  }, []);

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
    if (!memory || !activeUpdateStatuses.has(String(memory.updateStatus || ""))) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await refresh();
        if (!cancelled && activeUpdateStatuses.has(String(next.updateStatus || ""))) timer = window.setTimeout(() => void poll(), 1800);
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 4000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [memory?.updateStatus, refresh]);

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

  async function choose(action: MemoryAction) {
    const operationToken = action === "check_completed_response"
      ? chatgptOperation.beginLocalOperation("Check completed ChatGPT response")
      : null;
    if (action === "check_completed_response" && !operationToken) {
      setError(chatgptOperation.message || "Another ChatGPT task is already active.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/onboarding/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await readApiResponse(response, "Unable to save the ChatGPT Memory choice");
      if (action === "check_completed_response") notifyBridgeHints(data.bridge_hints || data.bridge_hint);
      const nextMemory = data.memory as MemoryState;
      setMemory(nextMemory);
      onMemoryChangedRef.current?.(nextMemory, action);
      const buildResult = action === "allow" ? await onMemoryAllowed?.() : undefined;
      setMessage(action === "check_completed_response"
          ? "Checking the bound ChatGPT conversation for an already completed professional-profile.json response. No new ChatGPT message will be sent."
          : action === "allow"
            ? buildResult === false
              ? "ChatGPT Memory is allowed, but the staged sources changed after Save. Press Save sources and build profile again for the current bundle."
              : "ChatGPT Memory is allowed. The saved build will continue if you pressed Save before choosing Memory; otherwise press Save sources and build profile when you are ready."
          : action === "decline"
            ? "ChatGPT Memory will not be used. You can still build a complete profile from your details, CVs, LinkedIn and other information."
            : null);
      if (action === "reset") onProfileChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the ChatGPT Memory choice.");
    } finally {
      setBusy(false);
      if (operationToken) chatgptOperation.finishLocalOperation(operationToken);
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
    ? "No ChatGPT message has been sent: the Website Bridge status cannot be checked right now. Keep the latest extension open and try again."
    : !memory.bridge.paired
      ? "The request is queued, but no ChatGPT Website Bridge is paired yet. Pair the extension; Automatic Send is enabled automatically."
        : !memory.bridge.hasProfessionalBackgroundConversation
          ? "The Professional background workflow chat is not set up on this bridge. Update or reload the latest extension and choose Set up missing workflow chats. Automatic Send is enabled automatically."
        : !memory.bridge.online
          ? "No ChatGPT message has been sent: the paired Website Bridge is offline. Keep ChatGPT open with the latest extension and try again."
        : !memory.bridge.backgroundFocusPolicyV2
          ? "The paired Website Bridge needs its latest background-focus safety update. Reload or update the extension before building the profile."
          : !memory.bridge.resultCompletionV3 || !memory.bridge.responseProvenanceV3
            ? "No ChatGPT message has been sent: the Website Bridge and its free-tier backend need to be updated together."
          : !memory.bridge.automaticSendEnabled
            ? "The workflow chat is ready while Automatic Send is being enabled. Keep the extension open for a moment and try again."
            : "The Website Bridge is ready. Keep ChatGPT open while the source Memory updates and profile import are processed.";

  return <section id="chatgpt-memory" className="card memorySetupCard" aria-labelledby="memory-setup-title">
    <div className="cardHeader"><div><div className="eyebrow">Step 2 · Optional</div><h2 id="memory-setup-title">Use ChatGPT Memory?</h2><p>ChatGPT can use what it already knows about your professional background.</p></div><span className={`badge ${allowed ? "review" : undecided ? "action" : "muted"}`}>{allowed ? "On" : undecided ? "Choose" : "Off"}</span></div>
    {undecided ? <>
      <div className="memoryStagedPanel" aria-label="Staged ChatGPT Memory source bundle">
        <div className="memoryStagedHeader"><strong>Ready to send</strong><span className="badge muted">{savedSources.length + (savedLinkedin ? 1 : 0) + (savedAdditionalInformation.trim() ? 1 : 0)} source{savedSources.length + (savedLinkedin ? 1 : 0) + (savedAdditionalInformation.trim() ? 1 : 0) === 1 ? "" : "s"}</span></div>
        {savedSources.length || savedLinkedin || savedAdditionalInformation.trim() ? <ul>
          {savedSources.map((source) => <li key={source.id}><strong>{source.original_name || "Saved professional document"}</strong><span>{source.source_type ? String(source.source_type).replaceAll("_", " ") : "document"}{source.extraction_format ? ` · ${source.extraction_format}` : ""}{source.extraction_status ? ` · ${String(source.extraction_status).replaceAll("_", " ")}` : ""}</span></li>)}
          {savedLinkedin ? <li><strong>LinkedIn profile</strong><span>{savedLinkedin}</span></li> : null}
          {savedAdditionalInformation.trim() ? <li><strong>Additional Information</strong><pre className="memoryStagedText">{savedAdditionalInformation}</pre></li> : null}
        </ul> : <p className="memoryStagedEmpty">No saved sources. ChatGPT will use only its existing Memory.</p>}
        {hasUnsavedSourceChanges ? <div className="memoryStagedWarning"><strong>Unsaved change in Step 1</strong><span>{sourceChangeLabel} is not included yet.</span></div> : null}
      </div>
      <div className="buttonRow memorySetupActions"><button className="primaryButton" type="button" disabled={busy || chatgptOperation.blocked} onClick={() => void choose("allow")}>{busy ? "Saving choice…" : "Yes, use ChatGPT Memory"}</button><button className="secondaryButton" type="button" disabled={busy || chatgptOperation.blocked} onClick={() => void choose("decline")}>No, I’ll fill it in myself</button></div>
    </> : allowed ? <>
      <div className="buttonRow memorySetupActions">
        {importing ? <div className="memorySetupProgress"><span className="formHint">ChatGPT is updating Memory and creating your structured onboarding profile…</span><p>{bridgeMessage} <a href="/settings#chatgpt-bridge" className="textLink">Open Website Bridge settings</a>.</p></div>
          : completed ? <span className="formHint">Profile import complete. Review and edit the fields below.</span>
            : responseCheckAvailable ? <div className="memorySyncActions"><span className="formHint">ChatGPT may have finished after the bridge timed out.</span><button className="primaryButton" type="button" disabled={busy || chatgptOperation.blocked} onClick={() => void choose("check_completed_response")}>{busy ? "Checking…" : "Check existing response"}</button></div>
          : manualReviewRequired ? <div className="memorySyncActions"><span className="formHint">Automatic recovery is unavailable because this request has no safe exact-turn anchor. Review the bound Professional background chat before starting another request.</span><a href="/settings#chatgpt-bridge" className="textLink">Open Website Bridge settings</a></div>
          : <span className="formHint">Memory is on. Use Step 1 to build or update your profile.</span>}
        <button className="textLink" type="button" disabled={busy} onClick={() => void choose("reset")}>Change choice</button>
      </div>
    </> : <>
      <p className="memorySetupCopy">Memory is off. Your profile will use only the sources you add here.</p>
      <div className="buttonRow memorySetupActions"><button className="textLink" type="button" disabled={busy} onClick={() => void choose("reset")}>Change choice</button></div>
    </>}
    {message ? <div className="notice">{message}</div> : null}
    {memory.importError ? <div className="formError">{memory.importError}</div> : null}
    {Array.isArray(memory.importQuestions) && memory.importQuestions.length ? <div className="memoryStagedWarning" aria-live="polite">
      <strong>Review these questions and conflicts</strong>
      <ul>{memory.importQuestions.map((question, index) => <li key={String(index) + question}>{question}</li>)}</ul>
      <span>Compare them with your profile below and correct or complete the relevant fields before confirming your information.</span>
    </div> : null}
    {error ? <div className="formError">{error}</div> : null}
  </section>;
}
