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

type Inspection = {
  id: string;
  source_url: string;
  status: JobUrlInspectionStatus;
  error_json?: { message?: string } | null;
  job_id?: string | null;
  batch_position?: number | null;
  reconciliation_error?: string | null;
  captured_result_retry_allowed?: boolean;
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

export function JobUrlInspectionForm({ initialSourceUrl = "" }: { initialSourceUrl?: string }) {
  const [urlFields, setUrlFields] = useState(() => [{ id: "job-url-field-1", value: initialSourceUrl }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [persistenceRetryNeeded, setPersistenceRetryNeeded] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const chatgptOperation = useChatGptOperation();

  useEffect(() => {
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
        const active = next.some((item) => ["queued", "processing"].includes(item.inspection?.status));
        const savingCapturedResult = next.some((item) => item.inspection?.status === "processing" && item.inspection.reconciliation_error);
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

    const operationToken = chatgptOperation.beginLocalOperation(sourceUrls.length > 1 ? `Inspect ${sourceUrls.length} job listings` : "Inspect job listing");
    if (!operationToken) { setError(chatgptOperation.message || "Another ChatGPT task is already active."); return; }
    setBusy(true);
    setItems([]);
    setPersistenceRetryNeeded(false);
    try {
      const response = await fetch("/api/jobs/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrls }),
      });
      const result = await readApiResponse(response, "Unable to start the listing import");
      if (typeof result.batchId !== "string") throw new Error("The import service did not return a batch id.");
      setBatchId(result.batchId);
      try { window.localStorage.setItem(STORAGE_KEY, result.batchId); } catch { /* batch rows remain server-persistent */ }
      setDuplicateCount(Number(result.duplicateCount || 0));
      setItems(Array.isArray(result.items) ? result.items as BatchItem[] : []);
      notifyBridgeHint(result.bridge_hint || result.bridge_hints?.[0]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the listing import.");
    } finally { setBusy(false); chatgptOperation.finishLocalOperation(operationToken); }
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
  const activeCount = items.filter((item) => ["queued", "processing"].includes(item.inspection.status)).length;
  const retryableDispatchId = items.find((item) => item.dispatch?.retry_allowed)?.dispatch?.id;

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
        <button className="primaryButton" disabled={busy || chatgptOperation.blocked || enteredCount === 0 || enteredCount !== urlFields.length || enteredCount > MAX_BULK_URLS} type="submit">
          {busy ? "Queueing batch…" : enteredCount > 1 ? `Inspect ${enteredCount} listings with ChatGPT` : "Inspect with ChatGPT"}
        </button>
      </div>
    </form>
    <p className="formHint">Only public listings can be inspected. You can review each result before using it.</p>

    {duplicateCount > 0 ? <div className="notice urlImportNotice">{duplicateCount} duplicate URL{duplicateCount === 1 ? " was" : "s were"} removed from this batch.</div> : null}
    {batchId && items.length ? <section className="urlImportBatch" aria-label="Import batch results">
      <div className="urlImportBatchHeader"><div><strong>Import progress</strong><span>{items.length} listing{items.length === 1 ? "" : "s"} · one ChatGPT request</span></div><div className="urlImportBatchActions"><span>{completedCount} imported{activeCount ? ` · ${activeCount} still working` : ""}</span>{retryableDispatchId ? <button className="secondaryButton" type="button" disabled={chatgptOperation.blocked} onClick={() => void retryDispatch(retryableDispatchId)}>Retry batch delivery</button> : null}{persistenceRetryNeeded ? <button className="secondaryButton" type="button" onClick={retryCapturedPersistence}>Retry saving captured results</button> : null}</div></div>
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
