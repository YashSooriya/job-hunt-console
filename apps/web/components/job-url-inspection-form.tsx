"use client";

import { FormEvent, useEffect, useState } from "react";
import { inspectionStatusLabel, type JobUrlInspectionStatus } from "@/lib/job-url-inspection";
import { readApiResponse } from "@/lib/onboarding/client-api";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import { dispatchStateLabel } from "@/lib/chatgpt-bridge/dispatch-state";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";

const MAX_BULK_URLS = 10;
const STORAGE_KEY = "jobhunt:last-job-url-import-batch:v1";
const PENDING_STORAGE_KEY = "jobhunt:pending-job-url-import:v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Inspection = {
  id: string;
  source_url: string;
  original_source_url?: string | null;
  status: JobUrlInspectionStatus;
  error_json?: { message?: string } | null;
  job_id?: string | null;
  batch_position?: number | null;
  reconciliation_error?: string | null;
  captured_result_retry_allowed?: boolean;
  initial_fit_status?: string | null;
  initial_fit_error?: string | null;
};
type DispatchSummary = {
  id: string;
  state?: string;
  progress?: Record<string, unknown>;
  retry_allowed?: boolean;
  captured_result_retry_allowed?: boolean;
  manual_review_required?: boolean;
};
type BatchItem = { inspection: Inspection; dispatch?: DispatchSummary | null; error?: string };

function safeReadBatchId() {
  try { return window.localStorage.getItem(STORAGE_KEY) || ""; }
  catch { return ""; }
}

function safeReadPendingBatch() {
  try {
    const value = JSON.parse(window.localStorage.getItem(PENDING_STORAGE_KEY) || "null");
    if (value && typeof value === "object" && UUID_RE.test(value.batchId)
      && Array.isArray(value.sourceUrls) && value.sourceUrls.length >= 1 && value.sourceUrls.length <= MAX_BULK_URLS
      && value.sourceUrls.every((item: unknown) => typeof item === "string")) return value as { batchId: string; sourceUrls: string[] };
  } catch { /* A fresh request id is safer than trusting malformed browser storage. */ }
  return null;
}

export function JobUrlInspectionForm({ initialSourceUrl = "" }: { initialSourceUrl?: string }) {
  const [urlFields, setUrlFields] = useState(() => [{ id: "job-url-field-1", value: initialSourceUrl }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [pendingBatch, setPendingBatch] = useState<{ batchId: string; sourceUrls: string[] } | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [persistenceRetryNeeded, setPersistenceRetryNeeded] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const chatgptOperation = useChatGptOperation();

  useEffect(() => {
    const pending = safeReadPendingBatch();
    if (pending) {
      setPendingBatch(pending);
      setUrlFields(pending.sourceUrls.map((value, index) => ({ id: `job-url-field-${index + 1}`, value })));
      setBatchId(pending.batchId);
      try { window.localStorage.setItem(STORAGE_KEY, pending.batchId); } catch { /* Server-side recovery still uses the id on next submit. */ }
      return;
    }
    const initial = new URLSearchParams(window.location.search).get("sourceUrl");
    if (initial) setUrlFields((current) => current[0]?.value ? current : [{ ...current[0], value: initial }, ...current.slice(1)]);
    const stored = safeReadBatchId();
    if (stored) setBatchId(stored);
  }, []);

  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    let timer: number | undefined;
    let persistenceAttempts = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/inspect?batchId=${encodeURIComponent(batchId)}`, { cache: "no-store" });
        const result = await readApiResponse(response, "Unable to read import batch status");
        if (cancelled) return;
        const next = Array.isArray(result.items) ? result.items as BatchItem[] : [];
        setItems(next);
        const active = next.some((item) => ["queued", "processing"].includes(item.inspection?.status)
          || (item.inspection?.status === "completed" && item.inspection.initial_fit_status === "pending"));
        const savingCapturedResult = next.some((item) => (item.inspection?.status === "processing" || item.inspection?.initial_fit_status === "pending") && item.inspection.reconciliation_error);
        if (savingCapturedResult) {
          persistenceAttempts += 1;
          if (persistenceAttempts >= 6) {
            setPersistenceRetryNeeded(true);
            return;
          }
          timer = window.setTimeout(() => void poll(), Math.min(2500 * 2 ** (persistenceAttempts - 1), 15000));
        } else if (active) {
          setPersistenceRetryNeeded(false);
          timer = window.setTimeout(() => void poll(), 2200);
        } else {
          setPersistenceRetryNeeded(false);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Unable to read import status.");
        timer = window.setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [batchId, retryGeneration]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const sourceUrls = urlFields.map((field) => field.value.trim()).filter(Boolean);
    if (!sourceUrls.length) { setError("Enter at least one public job listing URL."); return; }
    if (sourceUrls.length !== urlFields.length) { setError("Complete every job URL field or remove the empty field before submitting."); return; }
    if (sourceUrls.length > MAX_BULK_URLS) { setError(`Import up to ${MAX_BULK_URLS} URLs at a time.`); return; }

    const previous = safeReadPendingBatch();
    const retryingSavedBatch = Boolean(previous && JSON.stringify(previous.sourceUrls) === JSON.stringify(sourceUrls));
    // A retry with the exact durable batch identity does not create a second
    // Bridge operation. Let the owner-scoped route reconcile or link that
    // same dispatch even when its queued state currently holds the global
    // operation lock. New/changed batches still take the normal client lock;
    // the server independently enforces the lock before creating a dispatch.
    const operationToken = retryingSavedBatch ? null : chatgptOperation.beginLocalOperation(
      sourceUrls.length > 1 ? `Inspect ${sourceUrls.length} job listings` : "Inspect job listing",
    );
    if (!retryingSavedBatch && !operationToken) { setError(chatgptOperation.message || "Another ChatGPT task is already active."); return; }
    const batchId = retryingSavedBatch && previous ? previous.batchId : crypto.randomUUID();
    const submittedBatch = { batchId, sourceUrls };
    setPendingBatch(submittedBatch);
    try { window.localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ batchId, sourceUrls })); } catch { /* The server still protects the exact submitted id when storage is available. */ }
    setBusy(true);
    setItems([]);
    setPersistenceRetryNeeded(false);
    try {
      const response = await fetch("/api/jobs/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrls, batchId }),
      });
      const diagnostic = await response.clone().json().catch(() => null);
      if (diagnostic?.batchId === batchId && diagnostic?.ok !== true) {
        setBatchId(batchId);
        try { window.localStorage.setItem(STORAGE_KEY, batchId); } catch { /* The pending identity remains available for retry. */ }
      } else if (!response.ok && response.status < 500) {
        try { window.localStorage.removeItem(PENDING_STORAGE_KEY); } catch { /* Ignore unavailable browser storage. */ }
        setPendingBatch(null);
      }
      const result = await readApiResponse(response, "Unable to start the listing import");
      if (typeof result.batchId !== "string") throw new Error("The import service did not return a batch id.");
      setBatchId(result.batchId);
      try { window.localStorage.setItem(STORAGE_KEY, result.batchId); } catch { /* batch rows remain server-persistent */ }
      try { window.localStorage.removeItem(PENDING_STORAGE_KEY); } catch { /* The accepted batch id remains stored above. */ }
      setPendingBatch(null);
      setDuplicateCount(Number(result.duplicateCount || 0));
      setItems(Array.isArray(result.items) ? result.items as BatchItem[] : []);
      notifyBridgeHint(result.bridge_hint || result.bridge_hints?.[0]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the listing import.");
    } finally { setBusy(false); if (operationToken) chatgptOperation.finishLocalOperation(operationToken); }
  }

  async function retryDispatch(requestId: string) {
    const retryAllowed = items.some((item) => item.dispatch?.id === requestId && item.dispatch.retry_allowed);
    if (!retryAllowed) return;
    const operationToken = chatgptOperation.beginLocalOperation("Retry job-listing delivery");
    if (!operationToken) { setError(chatgptOperation.message || "Another ChatGPT task is already active."); return; }
    setError(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/dispatch/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const result = await readApiResponse(response, "Unable to retry the bridge delivery");
      notifyBridgeHint(result.bridge_hint);
      setItems((current) => current.map((candidate) => candidate.dispatch?.id === requestId
        ? { ...candidate, inspection: { ...candidate.inspection, status: "queued", error_json: null } }
        : candidate));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to retry the bridge delivery.");
    } finally {
      chatgptOperation.finishLocalOperation(operationToken);
    }
  }

  function retryCapturedPersistence() {
    setPersistenceRetryNeeded(false);
    setRetryGeneration((current) => current + 1);
  }

  const enteredCount = urlFields.filter((field) => field.value.trim()).length;
  const completedCount = items.filter((item) => item.inspection.status === "completed").length;
  const activeCount = items.filter((item) => ["queued", "processing"].includes(item.inspection.status)
    || (item.inspection.status === "completed" && item.inspection.initial_fit_status === "pending")).length;
  const retryableDispatchId = items.find((item) => item.dispatch?.retry_allowed)?.dispatch?.id;
  const currentSourceUrls = urlFields.map((field) => field.value.trim()).filter(Boolean);
  const retryingExactSavedBatch = Boolean(pendingBatch
    && currentSourceUrls.length === urlFields.length
    && JSON.stringify(pendingBatch.sourceUrls) === JSON.stringify(currentSourceUrls));
  const fitStatusLabel = (status?: string | null) => ({
    pending: "Waiting for the same-response fit result to save",
    assessed: "Memory fit assessed",
    insufficient_memory: "Insufficient Memory; score remains unknown",
    incomplete: "Fit is incomplete; score withheld",
    listing_unavailable: "Fit could not verify this listing",
    wrong_listing: "Fit result did not match this listing",
    invalid_response: "Fit response needs attention",
    missing_result: "Fit result was omitted",
    needs_user: "Fit needs your attention",
  } as Record<string, string>)[status || ""] || "Initial fit status unavailable";

  return <div className="urlInspectionBody">
    <form className="urlInspectionForm urlInspectionBulkForm" onSubmit={(event) => void submit(event)}>
      <div className="urlInspectionFields">
        {urlFields.map((field, index) => <div className="urlInspectionField" key={field.id}>
          <label htmlFor={field.id}>
            <span>Job listing URL {index + 1} *</span>
            <input className="input" id={field.id} name={`sourceUrl-${index + 1}`} type="url" required maxLength={2000} value={field.value}
              placeholder="https://company.example/careers/role" autoComplete="url"
              onChange={(event) => setUrlFields((current) => current.map((candidate) => candidate.id === field.id ? { ...candidate, value: event.target.value } : candidate))} />
          </label>
          {urlFields.length > 1 ? <button className="textButton urlInspectionRemove" type="button" aria-label={`Remove job listing URL ${index + 1}`}
            onClick={() => setUrlFields((current) => current.filter((candidate) => candidate.id !== field.id))}>Remove</button> : null}
        </div>)}
        <div className="urlInspectionFormControls">
          <button className="secondaryButton" disabled={busy || chatgptOperation.blocked || urlFields.length >= MAX_BULK_URLS} type="button"
            onClick={() => setUrlFields((current) => [...current, { id: `job-url-field-${crypto.randomUUID()}`, value: "" }])}>
            Add another job URL{urlFields.length >= MAX_BULK_URLS ? " (limit reached)" : ""}
          </button>
          <small>{enteredCount} of {MAX_BULK_URLS} job URLs · All listed URLs will be processed together.</small>
        </div>
      </div>
      <div className="urlInspectionSubmit">
        <button className="primaryButton" disabled={busy || (chatgptOperation.blocked && !retryingExactSavedBatch) || enteredCount === 0 || enteredCount !== urlFields.length || enteredCount > MAX_BULK_URLS} type="submit">
          {busy ? "Queueing batch…" : enteredCount > 1 ? `Inspect ${enteredCount} listings with ChatGPT` : "Inspect with ChatGPT"}
        </button>
      </div>
    </form>
    <p className="formHint">One Website Bridge request returns both listing details and the initial Memory fit. Only public listings are inspected.</p>

    {duplicateCount > 0 ? <div className="notice urlImportNotice">{duplicateCount} duplicate URL{duplicateCount === 1 ? " was" : "s were"} removed from this batch.</div> : null}
    {batchId && items.length ? <section className="urlImportBatch" aria-label="Import batch results">
      <div className="urlImportBatchHeader"><div><strong>Import progress</strong><span>{items.length} listing{items.length === 1 ? "" : "s"} · one ChatGPT request for extraction and fit</span></div><div className="urlImportBatchActions"><span>{completedCount} imported{activeCount ? ` · ${activeCount} still working` : ""}</span>{retryableDispatchId ? <button className="secondaryButton" type="button" disabled={chatgptOperation.blocked} onClick={() => void retryDispatch(retryableDispatchId)}>Retry batch delivery</button> : null}{persistenceRetryNeeded ? <button className="secondaryButton" type="button" onClick={retryCapturedPersistence}>Retry saving captured results</button> : null}</div></div>
      <ol className="urlImportItems">
        {items.map((item, index) => {
          const inspection = item.inspection;
          const dispatchLabel = item.dispatch?.state ? dispatchStateLabel(item.dispatch.state, item.dispatch as Record<string, unknown>) : null;
          const waitingForChatGpt = isWaitingForChatGpt({ state: item.dispatch?.state, raw: item.dispatch ? { progress: item.dispatch.progress } : undefined });
          const isFailed = inspection.status === "failed" || inspection.status === "user_required";
          return <li className="urlImportItem" key={inspection.id}>
            <div className="urlImportItemHeading">
              <strong>Listing {inspection.batch_position || index + 1}</strong>
              <span className={`badge ${inspection.status === "completed" ? "review" : isFailed ? "danger" : "action"}`}>{inspectionStatusLabel(inspection.status)}</span>
            </div>
            <a className="urlImportSource" href={inspection.source_url} target="_blank" rel="noreferrer">{inspection.source_url}</a>
            {inspection.status === "completed" && inspection.job_id ? <a className="urlImportResult" href={`/jobs/${inspection.job_id}`}>Open imported job in the pool →</a> : null}
            {inspection.status === "completed" ? <small className="formHint initialFitStatus">Initial fit: {fitStatusLabel(inspection.initial_fit_status)}</small> : null}
            {inspection.initial_fit_error ? <small className="urlImportError">{inspection.initial_fit_error}</small> : null}
            {activeCount > 0 && ["queued", "processing"].includes(inspection.status) ? <small className="formHint">{waitingForChatGpt ? <><span className="chatgptActivitySpinner" aria-hidden="true" /> ChatGPT is reading this listing.</> : inspection.status === "processing" ? "Saving the captured result." : inspection.reconciliation_error || "Queued for processing."}{dispatchLabel ? ` ${dispatchLabel}.` : ""}</small> : null}
            {isFailed ? <small className="urlImportError">{inspection.error_json?.message || item.error || "This listing could not be imported safely."}</small> : null}
            {item.dispatch?.captured_result_retry_allowed ? <button className="secondaryButton" type="button" onClick={retryCapturedPersistence}>Retry saving captured result (no resend)</button> : null}
            {isFailed ? <div className="buttonRow"><a className="secondaryButton" href={`/jobs/add?method=manual&sourceUrl=${encodeURIComponent(inspection.source_url)}#manual`}>Add manually</a></div> : null}
          </li>;
        })}
      </ol>
    </section> : null}
    {error ? <div className="formError">{error}</div> : null}
  </div>;
}
