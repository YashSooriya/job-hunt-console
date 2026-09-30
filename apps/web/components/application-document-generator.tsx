"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createChatGptDispatch, dispatchStateLabel, readBridgeApiJson } from "@/lib/chatgpt-bridge/client";
import { CHATGPT_TESTING_MODE_PREFIX } from "@/lib/chatgpt/testing-mode";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";
import { DOCUMENT_TEMPLATES, isDocumentTemplateId } from "@/lib/document/templates";

type GeneratedItem = {
  id: string;
  kind: "cv" | "cover_letter";
  state: string;
  version_id?: string | null;
  version_number?: number | null;
  plaintext?: string | null;
  quality_report?: Record<string, unknown>;
  drive_state?: string;
  drive_folder_id?: string | null;
  error_message?: string | null;
};

type Generation = {
  id: string;
  application_id: string;
  state: string;
  template_id?: string;
  current_kind?: string | null;
  current_chunk: number;
  dispatch_id?: string | null;
  step?: { kind: "cv" | "cover_letter"; phase: "context" | "final"; ordinal: number; total: number; text: string };
  error_message?: string | null;
  testing_mode?: boolean;
  items: GeneratedItem[];
};

type Dispatch = Record<string, any>;

function secureUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const values = crypto.getRandomValues(new Uint8Array(16));
  values[6] = (values[6] & 0x0f) | 0x40;
  values[8] = (values[8] & 0x3f) | 0x80;
  const hex = [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function errorMessage(value: any, fallback: string) {
  return value && typeof value.error === "string" ? value.error : fallback;
}

function Spinner() {
  return <span className="chatgptActivitySpinner" aria-hidden="true" />;
}

export function ApplicationDocumentGenerator({
  applicationId,
  company,
  role,
  defaultTemplateId,
  initialRequestId = null,
  canGenerate,
}: {
  applicationId: string;
  company: string;
  role: string;
  defaultTemplateId: string;
  initialRequestId?: string | null;
  canGenerate: boolean;
}) {
  const router = useRouter();
  const chatgpt = useChatGptOperation();
  const [templateId, setTemplateId] = useState(isDocumentTemplateId(defaultTemplateId) ? defaultTemplateId : DOCUMENT_TEMPLATES[0].id);
  const [kinds, setKinds] = useState<Array<"cv" | "cover_letter">>(["cv"]);
  const [requestId, setRequestId] = useState<string | null>(initialRequestId);
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [activeDispatch, setActiveDispatch] = useState<Dispatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [safeRetryDispatch, setSafeRetryDispatch] = useState<string | null>(null);
  const [savingRetry, setSavingRetry] = useState(false);
  const runner = useRef(false);
  const requestKey = useRef<string | null>(null);

  const readGeneration = useCallback(async (id: string): Promise<Generation> => {
    const response = await fetch("/api/document-generations/" + encodeURIComponent(id), { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data.request) throw new Error(errorMessage(data, "Unable to read document-generation progress."));
    return data.request as Generation;
  }, []);

  const advance = useCallback(async (id: string, chunkIndex: number, dispatchId: string) => {
    const response = await fetch("/api/document-generations/" + encodeURIComponent(id) + "/advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chunkIndex, dispatchId }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw new Error(errorMessage(data, "Unable to save the captured ChatGPT result."));
    return data.result as Record<string, any>;
  }, []);

  const pollDispatch = useCallback(async (dispatchId: string, onChange: (dispatch: Dispatch) => void) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 25 * 60 * 1000) {
      const response = await fetch("/api/chatgpt-bridge/dispatch?id=" + encodeURIComponent(dispatchId), { cache: "no-store" });
      const data = await readBridgeApiJson(response);
      if (!response.ok || data.ok !== true || !data.dispatch) throw new Error(errorMessage(data, "Unable to read Website Bridge progress."));
      const dispatch = data.dispatch as Dispatch;
      onChange(dispatch);
      if (["completed", "failed", "expired", "cancelled", "user_required"].includes(String(dispatch.state))) return dispatch;
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    throw new Error("The Bridge is still working. You can return here later; the saved request will resume without sending the same message again.");
  }, []);

  const run = useCallback(async (id: string) => {
    if (runner.current) return;
    runner.current = true;
    setBusy(true);
    setError(null);
    setMessage("Preparing your document request…");
    setSafeRetryDispatch(null);
    setSavingRetry(false);
    try {
      let guard = 0;
      while (guard++ < 200) {
        const current = await readGeneration(id);
        setGeneration(current);
        setRequestId(current.id);
        if (["ready", "partial", "needs_user", "failed", "cancelled"].includes(current.state)) {
          setMessage(current.state === "ready" ? "Your documents are ready to review." : current.state === "partial" ? "One document is ready; another needs attention." : "");
          if (current.state === "ready" || current.state === "partial") router.refresh();
          return;
        }

        let dispatchId = current.dispatch_id || "";
        let chunkIndex = current.current_chunk;
        if (!dispatchId) {
          const step = current.step;
          if (!step?.text || !["cv", "cover_letter"].includes(step.kind)) {
            throw new Error("The next document step is not available. Refresh the page to resume safely.");
          }
          const instruction = current.testing_mode && !step.text.startsWith(CHATGPT_TESTING_MODE_PREFIX)
            ? CHATGPT_TESTING_MODE_PREFIX + "\n\n" + step.text
            : step.text;
          const actionType = step.kind === "cv" ? "documents.cv.create" : "documents.cover_letter.create";
          const queued = await createChatGptDispatch({
            actionType,
            subjectRefs: { application_ids: [applicationId] },
            displayTitle: step.phase === "final" ? (step.kind === "cv" ? "Create tailored CV" : "Create tailored cover letter") : "Prepare " + (step.kind === "cv" ? "CV" : "cover letter") + " context",
            websiteInstruction: instruction,
            idempotencyKey: "docgen-" + current.id + ":" + current.current_chunk,
            origin: "user_click",
          });
          dispatchId = typeof queued.dispatch?.id === "string" ? queued.dispatch.id : "";
          if (!dispatchId) throw new Error("The Website Bridge did not return a dispatch id. Retry to resume this saved step.");
          setMessage(step.phase === "context" ? "Setting up your document from the supplied instructions and verified profile…" : "ChatGPT is drafting your " + (step.kind === "cv" ? "CV" : "cover letter") + "…");
          setActiveDispatch(queued.dispatch || null);
          await advance(current.id, current.current_chunk, dispatchId);
        } else {
          setMessage("Waiting for the exact ChatGPT response for this document step…");
        }

        const finished = await pollDispatch(dispatchId, setActiveDispatch);
        if (finished.state === "failed" || finished.state === "expired" || finished.state === "cancelled" || finished.state === "user_required") {
          await advance(id, chunkIndex, dispatchId);
          const latest = await readGeneration(id);
          setGeneration(latest);
          if (finished.retry_allowed === true && finished.send_attempted_at == null && finished.sent_at == null) setSafeRetryDispatch(dispatchId);
          setMessage(latest.error_message || "The Website Bridge needs attention. The request is saved and the original ChatGPT message was not resent.");
          return;
        }
        setMessage("Capturing this exact assistant turn and saving the next step…");
        const saved = await advance(id, chunkIndex, dispatchId);
        if (saved.waiting) {
          setMessage("Waiting for ChatGPT’s response…");
          continue;
        }
        setActiveDispatch(null);
        const updated = await readGeneration(id);
        setGeneration(updated);
        if (updated.state === "ready") {
          setMessage("Your documents are ready to review.");
          router.refresh();
          return;
        }
        if (updated.state === "needs_user" || updated.state === "failed") {
          setMessage(updated.error_message || "This draft needs your attention.");
          return;
        }
        setMessage("Continuing with the next document step…");
      }
      throw new Error("This document request has more setup steps than expected. It is saved and can be resumed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Document generation stopped unexpectedly.");
      setMessage("");
      try {
        const latest = await readGeneration(id);
        setGeneration(latest);
        setSavingRetry(!["needs_user", "failed", "cancelled", "ready", "partial"].includes(latest.state));
      } catch { setSavingRetry(false); }
    } finally {
      runner.current = false;
      setBusy(false);
    }
  }, [advance, applicationId, pollDispatch, readGeneration, router]);

  useEffect(() => {
    if (!initialRequestId) return;
    void readGeneration(initialRequestId).then((value) => {
      setGeneration(value);
      if (isDocumentTemplateId(value.template_id)) setTemplateId(value.template_id);
      if (!["ready", "partial", "needs_user", "failed", "cancelled"].includes(value.state)) void run(initialRequestId);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to resume document generation."));
  }, [initialRequestId, readGeneration, run]);

  async function startGeneration() {
    if (!canGenerate || busy || chatgpt.blocked || !kinds.length) return;
    setError(null);
    setMessage("Freezing the selected job, profile evidence and theme…");
    setBusy(true);
    const idempotency = requestKey.current || secureUuid();
    requestKey.current = idempotency;
    try {
      const response = await fetch("/api/applications/" + encodeURIComponent(applicationId) + "/documents/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestKey: idempotency, kinds, templateId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || typeof data.requestId !== "string") {
        if (response.status >= 400 && response.status < 500) requestKey.current = null;
        throw new Error(errorMessage(data, "Unable to begin custom document generation."));
      }
      requestKey.current = null;
      setRequestId(data.requestId);
      setMessage("Your profile and vacancy are frozen. Starting the Website Bridge setup…");
      setBusy(false);
      await run(data.requestId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to begin document generation.");
      setMessage("");
      setBusy(false);
    }
  }

  async function retrySafeDelivery() {
    if (!safeRetryDispatch || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/dispatch/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: safeRetryDispatch }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data.bridge_hint) throw new Error(errorMessage(data, "The Bridge did not allow a safe retry."));
      notifyBridgeHint(data.bridge_hint);
      setSafeRetryDispatch(null);
      if (requestId) await run(requestId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to retry safe Bridge delivery."); }
    finally { setBusy(false); }
  }

  async function retrySavingCapturedResult() {
    if (!requestId || busy) return;
    setError(null);
    await run(requestId);
  }

  async function copyLetter(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("Cover letter copied to the clipboard.");
    } catch { setError("Clipboard access was blocked. Select the cover-letter text and copy it manually."); }
  }

  async function retryDrive(itemId: string) {
    setError(null); setBusy(true);
    try {
      const response = await fetch("/api/application-documents/" + encodeURIComponent(itemId) + "/drive", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(errorMessage(data, "Could not save these documents to Google Drive."));
      setMessage("Documents saved in the application’s Google Drive folder.");
      if (requestId) setGeneration(await readGeneration(requestId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save these documents to Google Drive."); }
    finally { setBusy(false); }
  }

  function toggleKind(kind: "cv" | "cover_letter") {
    setKinds((current) => current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind]);
  }

  const currentItem = generation?.items?.find((item) => item.state === "writing" || item.state === "preparing_context" || item.state === "validating" || item.state === "rendering");
  const waitingOnAssistant = busy && isWaitingForChatGpt({ state: String(activeDispatch?.state || ""), raw: activeDispatch || undefined });
  const selectedTheme = DOCUMENT_TEMPLATES.find((item) => item.id === (generation?.template_id || templateId)) || DOCUMENT_TEMPLATES[0];

  return <section className="card applicationDocumentGenerator" aria-labelledby="application-documents-heading">
    <div className="cardHeader">
      <div><div className="eyebrow">Application materials</div><h2 id="application-documents-heading">Create documents for this job</h2><p>Only starts after you chose to apply. ChatGPT drafts from the frozen listing and verified profile; nothing is submitted for you.</p></div>
      <a className="textLink" href="/documents">Choose a visual theme</a>
    </div>
    {!canGenerate ? <div className="notice">Custom CVs and cover letters are available after you choose to apply to this job.</div> : <>
      <div className="documentRequestChoices">
        <label><input type="checkbox" checked={kinds.includes("cv")} onChange={() => toggleKind("cv")} disabled={busy} /><span><strong>Tailored CV</strong><small>Two-page, evidence-backed PDF and editable Word file.</small></span></label>
        <label><input type="checkbox" checked={kinds.includes("cover_letter")} onChange={() => toggleKind("cover_letter")} disabled={busy} /><span><strong>Cover letter</strong><small>Reviewable PDF, Word file and copyable plain text.</small></span></label>
      </div>
      <div className="documentGenerationControls">
        <label htmlFor={"document-theme-" + applicationId}>Theme</label>
        <select id={"document-theme-" + applicationId} value={templateId} onChange={(event) => setTemplateId(event.target.value)} disabled={busy}>
          {DOCUMENT_TEMPLATES.map((theme) => <option value={theme.id} key={theme.id}>{theme.name}</option>)}
        </select>
        <span className="documentThemeSummary">{selectedTheme.description}</span>
        <button className="primaryButton" type="button" onClick={() => void startGeneration()} disabled={busy || chatgpt.blocked || !kinds.length}>
          {waitingOnAssistant ? <><Spinner /> Waiting for ChatGPT…</> : busy ? "Preparing…" : "Generate selected documents"}
        </button>
      </div>
    </>}

    {busy ? <div className="documentGenerationProgress" role="status" aria-live="polite">
      {waitingOnAssistant ? <Spinner /> : null}
      <span>{message || "Working on your document…"}</span>
      {generation?.step ? <small>Step {generation.step.ordinal} of {generation.step.total} · {generation.step.phase === "context" ? "setting up" : "drafting"} {generation.step.kind === "cv" ? "the CV" : "the cover letter"}</small> : null}
      {activeDispatch?.state ? <small>Bridge: {dispatchStateLabel(String(activeDispatch.state), activeDispatch)}</small> : null}
    </div> : null}
    {message && !busy ? <p className="formHint" role="status">{message}</p> : null}
    {error ? <div className="formError" role="alert">{error}</div> : null}
    {safeRetryDispatch ? <button className="secondaryButton" type="button" disabled={busy || chatgpt.blocked} onClick={() => void retrySafeDelivery()}>Retry safe Bridge delivery</button> : null}
    {savingRetry && requestId && generation?.state !== "needs_user" ? <button className="secondaryButton" type="button" disabled={busy || chatgpt.blocked} onClick={() => void retrySavingCapturedResult()}>Retry saving captured response</button> : null}
    {generation?.error_message && generation.state === "needs_user" ? <div className="notice">{generation.error_message} <a className="textLink" href="/settings">Open Website Bridge settings</a>. After rotating the indicated workflow chat, start a new draft below; the complete instructions and saved job/profile snapshot will be prepared again.</div> : null}

    {generation?.items?.length ? <div className="generatedApplicationDocuments">
      {generation.items.map((item) => {
        const ready = item.state === "ready" && item.version_id;
        const label = item.kind === "cv" ? "Tailored CV" : "Cover letter";
        return <article className="generatedDocumentCard" key={item.id}>
          <div className="generatedDocumentHeading"><div><h3>{label}</h3><p>{ready ? "Version " + (item.version_number || "1") + " · " + selectedTheme.name + " · ready for your review" : item.error_message || item.state.replaceAll("_", " ")}</p></div><span className={"badge " + (ready ? "review" : "muted")}>{ready ? "Needs your review" : item.state.replaceAll("_", " ")}</span></div>
          {ready ? <div className="generatedDocumentActions">
            <a className="secondaryButton" href={"/api/application-documents/" + item.id + "/download?format=pdf"} target="_blank" rel="noreferrer">Open PDF</a>
            <a className="secondaryButton" href={"/api/application-documents/" + item.id + "/download?format=docx"}>Download Word</a>
            {item.kind === "cover_letter" && item.plaintext ? <button className="secondaryButton" type="button" onClick={() => void copyLetter(item.plaintext || "")}>Copy cover letter</button> : null}
            {item.drive_state === "ready" && item.drive_folder_id ? <a className="textLink" href={"https://drive.google.com/drive/folders/" + encodeURIComponent(item.drive_folder_id)} target="_blank" rel="noreferrer">Open Google Drive folder</a> : <div className="documentDriveStatus"><small>Drive: {item.drive_state === "needs_reconnect" ? "Reconnect Google in Settings to publish." : item.drive_state === "not_configured" ? "Connect Google in Settings to save a copy." : item.drive_state || "upload pending"}</small>{item.drive_state === "needs_reconnect" || item.drive_state === "not_configured" ? <a className="textLink" href="/settings">Open Google settings</a> : null}<button className="textLink" type="button" disabled={busy} onClick={() => void retryDrive(item.id)}>Save to Drive</button></div>}
          </div> : null}
          {ready && item.kind === "cover_letter" && item.plaintext ? <details className="coverLetterPlaintext"><summary>Plain-text cover letter</summary><textarea readOnly value={item.plaintext} aria-label="Cover letter text for copying" /><button className="textLink" type="button" onClick={() => void copyLetter(item.plaintext || "")}>Copy text</button></details> : null}
          {ready ? <iframe className="generatedDocumentPreview" title={label + " PDF preview"} src={"/api/application-documents/" + item.id + "/download?format=pdf"} /> : null}
        </article>;
      })}
    </div> : null}
    {currentItem ? <span className="srOnly">Current document: {currentItem.kind.replaceAll("_", " ")}.</span> : null}
  </section>;
}
