"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";
import { dispatchStateLabel, readBridgeApiJson } from "@/lib/chatgpt-bridge/client";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";

type Mode = "pending" | "selected" | "outdated";
type Pending = { requestId: string; mode: Mode; jobIds: string[]; retryBatchId?: string };
type MemoryItem = { id: string; chunk_id: string; job_id: string; listing_url: string; state: string; error_message?: string | null; analysis_id?: string | null };
type MemoryBatch = {
  id: string; request_id: string; mode: Mode; state: string; requested_count: number;
  counts?: { total?: number; completed?: number; assessed?: number; insufficient_memory?: number; needs_user?: number; queued?: number; running?: number };
  chunks?: Array<{ id: string; state: string; job_ids?: string[]; dispatch_id?: string | null; captured_response?: string | null; error_message?: string | null }>;
  items?: MemoryItem[];
};

const STORAGE = "jobhunt.job-fit-memory-v4.latest";
const PENDING = "jobhunt.job-fit-memory-v4.pending";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function active(value: MemoryBatch | null) { return Boolean(value && ["queued", "processing"].includes(value.state)); }
function message(body: unknown, fallback: string) { return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback; }
function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function Spinner() { return <span className="chatgptActivitySpinner" aria-hidden="true" />; }

export function JobFitMemoryControls({ pendingIds, outdatedIds, selectedIds, maxSelected = 100 }: {
  pendingIds: string[]; outdatedIds: string[]; selectedIds: string[]; maxSelected?: number;
}) {
  const router = useRouter();
  const operation = useChatGptOperation();
  const [batch, setBatch] = useState<MemoryBatch | null>(null);
  const [dispatch, setDispatch] = useState<Record<string, any> | null>(null);
  const [safeRetryBatchId, setSafeRetryBatchId] = useState<string | null>(null);
  const [safeFreshRetryBatchId, setSafeFreshRetryBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const monitorLock = useRef(false);
  const lastHinted = useRef<string | null>(null);
  const previousBatchState = useRef<{ id: string; state: string } | null>(null);
  const waiting = isWaitingForChatGpt({ state: typeof dispatch?.state === "string" ? dispatch.state : undefined, raw: dispatch || undefined });
  const activeBatch = active(batch);
  const counts = batch?.counts || {};
  const batchNeedsStatusCheck = Boolean(batch?.state === "partial" && (
    Number(counts.queued || 0) > 0 || Number(counts.running || 0) > 0 || Number(counts.needs_user || 0) > 0
    || batch.chunks?.some((chunk) => chunk.state === "needs_user")
  ));
  const safeRetryChunk = batch?.chunks?.find((chunk) => chunk.state === "needs_user"
    && typeof chunk.dispatch_id === "string" && UUID.test(chunk.dispatch_id));
  const safeRetryCandidate = Boolean(safeRetryChunk);
  const capturedResponseRetryChunk = batch?.chunks?.find((chunk) => chunk.state === "completed"
    && typeof chunk.dispatch_id === "string" && typeof chunk.captured_response === "string"
    && batch.items?.some((item) => item.chunk_id === chunk.id && ["invalid_response", "missing_result"].includes(item.state)));

  const saveResponse = useCallback(async (response: Response, fallback: string) => {
    const body = await readBridgeApiJson<Record<string, any>>(response);
    if (!response.ok || body.ok === false) throw new Error(message(body, fallback));
    if (body.batch) setBatch(body.batch as MemoryBatch);
    if (body.progressOwnedElsewhere !== true) setDispatch(body.dispatch && typeof body.dispatch === "object" ? body.dispatch : null);
    setSafeRetryBatchId(null);
    setSafeFreshRetryBatchId(null);
    if (body.bridge_hint && typeof body.bridge_hint === "object") {
      const dispatchId = String(body.dispatch?.id || body.dispatchId || "");
      if (dispatchId && lastHinted.current !== dispatchId) {
        notifyBridgeHint(body.bridge_hint);
        lastHinted.current = dispatchId;
      }
      void operation.refresh().catch(() => undefined);
    }
    return body;
  }, [operation]);

  const advance = useCallback(async (batchId: string, reprocessCapturedChunkId?: string) => {
    const response = await fetch("/api/jobs/analysis/memory/advance", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, ...(reprocessCapturedChunkId ? { reprocessCapturedChunkId } : {}) }), cache: "no-store",
    });
    return saveResponse(response, "Unable to read Memory-based analysis progress.");
  }, [saveResponse]);

  const loadBatch = useCallback(async (batchId?: string) => {
    const url = batchId ? `/api/jobs/analysis/memory?batchId=${encodeURIComponent(batchId)}` : "/api/jobs/analysis/memory";
    const response = await fetch(url, { cache: "no-store" });
    const body = await readBridgeApiJson<Record<string, any>>(response);
    if (!response.ok || body.ok === false) throw new Error(message(body, "Unable to restore Memory-based analysis progress."));
    const value = body.batch as MemoryBatch | null;
    const safeDispatch = body.dispatch && typeof body.dispatch === "object" ? body.dispatch as Record<string, any> : null;
    const safeFreshRetry = body.safe_fresh_retry === true;
    setBatch(value);
    setDispatch(safeDispatch);
    const exactBatchId = typeof value?.id === "string" && (!batchId || value.id === batchId) ? value.id : null;
    setSafeRetryBatchId(exactBatchId && safeDispatch && UUID.test(String(safeDispatch.id || ""))
      && safeDispatch.retry_allowed === true && ["user_required", "failed", "expired"].includes(String(safeDispatch.state))
      ? exactBatchId : null);
    setSafeFreshRetryBatchId(exactBatchId && safeFreshRetry ? exactBatchId : null);
    return { batch: value, dispatch: safeDispatch, safeFreshRetry };
  }, []);

  const start = useCallback(async (mode: Mode, ids: string[]) => {
    if (busy || activeBatch || operation.blocked || !ids.length || ids.length > maxSelected) return;
    setBusy(true); setError(null); setStatus("Saving the URL-only Memory analysis request…");
    const pending: Pending = { requestId: uuid(), mode, jobIds: [...ids] };
    try { window.localStorage.setItem(PENDING, JSON.stringify(pending)); } catch { /* Server-side batch idempotency still protects retries. */ }
    try {
      const response = await fetch("/api/jobs/analysis/memory", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending), cache: "no-store",
      });
      const result = await saveResponse(response, "Unable to start Memory-based job analysis.");
      if (result.batchId) {
        try { window.localStorage.setItem(STORAGE, String(result.batchId)); window.localStorage.removeItem(PENDING); } catch { /* Durable progress remains in the database. */ }
      }
      setStatus(result.state === "waiting_for_bridge" ? "Waiting for ChatGPT's exact response to this URL-only request…" : "Memory-only analysis is saved and progressing.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start Memory-based job analysis.");
      setStatus("The same request can be safely resumed; no duplicate prompt was sent.");
    } finally { setBusy(false); }
  }, [activeBatch, busy, maxSelected, operation.blocked, router, saveResponse]);

  const resumePending = useCallback(async (value: Pending) => {
    const response = await fetch("/api/jobs/analysis/memory", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), cache: "no-store",
    });
    const result = await saveResponse(response, "Unable to resume the saved Memory-only analysis request.");
    if (result.batchId) {
      try { window.localStorage.setItem(STORAGE, String(result.batchId)); window.localStorage.removeItem(PENDING); } catch { /* Database state remains durable. */ }
    }
    return result;
  }, [saveResponse]);

  const retrySafeDelivery = useCallback(async () => {
    const requestId = String(dispatch?.id || "");
    if (busy || operation.blocked || !batch || safeRetryBatchId !== batch.id || !UUID.test(requestId)
      || dispatch?.retry_allowed !== true || !["user_required", "failed", "expired"].includes(String(dispatch.state))) return;
    setBusy(true); setError(null); setStatus("The Bridge confirmed Send was not attempted; safely retrying the same saved request…");
    try {
      const response = await fetch("/api/chatgpt-bridge/dispatch/retry", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }), cache: "no-store",
      });
      await saveResponse(response, "Unable to retry this unsent Website Bridge request safely.");
      await advance(batch.id);
      setStatus("Retrying the same URL-only request. No message was resent after a confirmed Send.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to retry the unsent Website Bridge request safely.");
    } finally { setBusy(false); }
  }, [advance, batch, busy, dispatch, operation.blocked, router, safeRetryBatchId, saveResponse]);

  const retryUnsentGroupWithNewDispatch = useCallback(async () => {
    const chunk = safeRetryChunk;
    if (busy || operation.blocked || !batch || safeFreshRetryBatchId !== batch.id
      || !chunk || !Array.isArray(chunk.job_ids) || !chunk.job_ids.length) return;
    const pending: Pending = {
      requestId: uuid(), mode: "selected", jobIds: [...chunk.job_ids], retryBatchId: batch.id,
    };
    setBusy(true); setError(null);
    setStatus("Creating a new saved request for this group; the server confirmed the previous request never reached Send…");
    try { window.localStorage.setItem(PENDING, JSON.stringify(pending)); } catch { /* The server still binds the retry to its source batch. */ }
    try {
      const response = await fetch("/api/jobs/analysis/memory", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending), cache: "no-store",
      });
      const result = await saveResponse(response, "Unable to safely restart this unsent Memory-only group.");
      if (result.batchId) {
        try { window.localStorage.setItem(STORAGE, String(result.batchId)); window.localStorage.removeItem(PENDING); } catch { /* Durable server state remains recoverable. */ }
      }
      setStatus("A new URL-only request is running through the generic Website Bridge. The prior unsent record was retained.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to safely restart this unsent Memory-only group.");
    } finally { setBusy(false); }
  }, [batch, busy, operation.blocked, router, safeFreshRetryBatchId, safeRetryChunk, saveResponse]);

  const refreshSafeRetryStatus = useCallback(async () => {
    if (busy || !batch) return;
    setBusy(true); setError(null); setStatus("Checking the saved Bridge delivery with the server. This check does not send a message…");
    try {
      const latest = await loadBatch(batch.id);
      const dispatchId = String(latest.dispatch?.id || "");
      const retryAuthorized = Boolean(latest.dispatch?.retry_allowed === true && UUID.test(dispatchId)
        && ["user_required", "failed", "expired"].includes(String(latest.dispatch.state)));
      setBatch(latest.batch);
      setDispatch(retryAuthorized ? latest.dispatch : null);
      setSafeRetryBatchId(retryAuthorized ? batch.id : null);
      setSafeFreshRetryBatchId(!retryAuthorized && latest.safeFreshRetry ? batch.id : null);
      setStatus(retryAuthorized
        ? "The server confirmed this exact saved request is safe to retry."
        : latest.safeFreshRetry
          ? "The server confirmed this group never reached Send. One new request can be created for the exact saved jobs; no captured or sent result will be replayed."
          : "The server did not authorize a retry. Checking status did not send or recreate the saved request.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh the saved Bridge delivery status.");
    } finally { setBusy(false); }
  }, [batch, busy, loadBatch]);

  const reprocessCapturedResponse = useCallback(async () => {
    if (busy || !batch || !capturedResponseRetryChunk) return;
    setBusy(true); setError(null);
    setStatus("Reprocessing the saved, provenance-verified response locally. No ChatGPT message will be sent.");
    try {
      const outcome = await advance(batch.id, capturedResponseRetryChunk.id);
      const unresolved = outcome.batch?.items?.filter((item: MemoryItem) => item.chunk_id === capturedResponseRetryChunk.id
        && ["invalid_response", "missing_result"].includes(item.state)) || [];
      if (outcome.captured_response_reprocessed !== true || unresolved.length) {
        setStatus("The saved response was checked locally; no ChatGPT message was sent.");
        setError(unresolved[0]?.error_message || outcome.captured_response_reprocess_error
          || "The captured response still needs review. The original message was not resent.");
        router.refresh();
        return;
      }
      setStatus("The saved response was reprocessed without sending another ChatGPT message.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reprocess the saved response.");
    } finally { setBusy(false); }
  }, [advance, batch, busy, capturedResponseRetryChunk, router]);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const pending = window.localStorage.getItem(PENDING);
        if (pending) {
          const value = JSON.parse(pending) as Pending;
          if (value && UUID.test(value.requestId) && ["pending", "selected", "outdated"].includes(value.mode)
            && Array.isArray(value.jobIds) && value.jobIds.every((id) => typeof id === "string" && UUID.test(id))
            && (value.retryBatchId === undefined || UUID.test(value.retryBatchId))) {
            setStatus("Resuming the existing saved request (no new ChatGPT message is created by a refresh).");
            const result = await resumePending(value);
            if (!cancelled && result.batch) setBatch(result.batch as MemoryBatch);
          } else window.localStorage.removeItem(PENDING);
        }
        if (!cancelled) {
          const stored = window.localStorage.getItem(STORAGE);
          const { batch: restored } = await loadBatch(stored && UUID.test(stored) ? stored : undefined);
          if (!cancelled && restored && active(restored)) setStatus("Restored saved Memory-only analysis progress.");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to restore Memory-only analysis.");
      } finally { if (!cancelled) setRestoring(false); }
    }
    void restore();
    return () => { cancelled = true; };
  }, [loadBatch, resumePending]);

  useEffect(() => {
    if (!batch || !active(batch)) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (monitorLock.current) return;
      monitorLock.current = true;
      try { await advance(batch.id); }
      catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to advance Memory-only analysis."); }
      finally { monitorLock.current = false; }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2200);
    };
    void poll();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [advance, batch?.id, batch?.state]);

  useEffect(() => {
    const previous = previousBatchState.current;
    previousBatchState.current = batch ? { id: batch.id, state: batch.state } : null;
    if (!batch || previous?.id !== batch.id || !["queued", "processing"].includes(previous.state)
      || ["queued", "processing"].includes(batch.state)) return;

    // Progress is polled in this client component, but the job rows are
    // server-rendered props. Refresh them once the durable batch is terminal
    // so fit scores and stale/pending actions match the just-saved analyses.
    router.refresh();
  }, [batch?.id, batch?.state, router]);

  const total = Number(counts.total || batch?.requested_count || 0);
  const done = Number(counts.completed || 0);
  const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  const waitingLabel = dispatch?.state ? dispatchStateLabel(String(dispatch.state), dispatch) : "waiting for its response";
  const initiateDisabled = restoring || busy || activeBatch || safeRetryCandidate || batchNeedsStatusCheck || operation.blocked;
  const safeRetryAvailable = Boolean(batch && safeRetryBatchId === batch.id && dispatch && UUID.test(String(dispatch.id || ""))
    && dispatch.retry_allowed === true && ["user_required", "failed", "expired"].includes(String(dispatch.state)));
  const safeFreshRetryAvailable = Boolean(batch && safeFreshRetryBatchId === batch.id && safeRetryCandidate);
  const safeRetryStatusNeedsRefresh = Boolean((safeRetryCandidate || batchNeedsStatusCheck)
    && !safeRetryAvailable && !safeFreshRetryAvailable);

  return <div className="jobAnalysisBatch" aria-label="Memory-only job fit analysis">
    <div className="jobAnalysisBatchActions">
      <span className="jobAnalysisBatchLabel">Memory-based fit</span>
      <button className="secondaryButton" type="button" disabled={initiateDisabled || pendingIds.length === 0} onClick={() => void start("pending", pendingIds.slice(0, maxSelected))}>
        {busy ? "Preparing…" : `Analyse pending${pendingIds.length ? ` (${Math.min(pendingIds.length, maxSelected)})` : ""}`}
      </button>
      <button className="secondaryButton" type="button" disabled={initiateDisabled || outdatedIds.length === 0} onClick={() => void start("outdated", outdatedIds.slice(0, maxSelected))}>
        {`Refresh outdated${outdatedIds.length ? ` (${Math.min(outdatedIds.length, maxSelected)})` : ""}`}
      </button>
      <button className="secondaryButton" type="button" disabled={initiateDisabled || selectedIds.length === 0 || selectedIds.length > maxSelected} onClick={() => void start("selected", selectedIds)}>
        {`Analyse selected${selectedIds.length ? ` (${selectedIds.length})` : ""}`}
      </button>
      {safeRetryStatusNeedsRefresh ? <button className="secondaryButton" type="button" disabled={busy} onClick={() => void refreshSafeRetryStatus()}>
        {busy ? "Checking…" : "Check safe retry status"}
      </button> : null}
      {safeRetryAvailable ? <button className="secondaryButton" type="button" disabled={busy || operation.blocked} onClick={() => void retrySafeDelivery()}>
        {busy ? "Retrying…" : "Retry safe Bridge delivery"}
      </button> : null}
      {safeFreshRetryAvailable ? <button className="secondaryButton" type="button" disabled={busy || operation.blocked} onClick={() => void retryUnsentGroupWithNewDispatch()}>
        {busy ? "Preparing safe retry…" : "Retry this confirmed-unsent group"}
      </button> : null}
      {capturedResponseRetryChunk ? <button className="secondaryButton" type="button" disabled={busy} onClick={() => void reprocessCapturedResponse()}>
        {busy ? "Reprocessing saved response…" : "Reprocess captured response"}
      </button> : null}
      {activeBatch ? <button className="secondaryButton" type="button" disabled={busy} onClick={() => void advance(batch!.id).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to refresh progress."))}>Refresh progress</button> : null}
    </div>
    {selectedIds.length > maxSelected ? <p className="jobAnalysisHint" role="status">Select up to {maxSelected} jobs per batch. Pending and outdated actions process the next {maxSelected} jobs at a time.</p> : null}
    {batch ? <div className="jobAnalysisProgress" role="status" aria-live="polite">
      <div className="jobAnalysisProgressHeading"><strong>{activeBatch ? "Analysing saved listing URLs" : batch.state === "completed" ? "Memory-based analysis complete" : "Memory-based analysis finished with items to review"}</strong><span>{done} of {total} complete</span></div>
      <progress max={total || 1} value={done} aria-label={`Memory-based analysis progress (${percent} percent)`} />
      {waiting || status ? <span>{waiting ? <><Spinner /> ChatGPT is working · {waitingLabel}</> : status}</span> : null}
      {safeRetryStatusNeedsRefresh ? <span>This saved analysis is incomplete. Check its server-confirmed delivery state before starting another request; checking does not send or recreate it.</span> : null}
      {safeRetryAvailable ? <span>The Bridge confirms this saved request was not sent. Retry safely without creating a new analysis request.</span> : null}
      {safeFreshRetryAvailable ? <span>The Bridge confirms that no Send was attempted and no response was captured. A fresh request will use only the same saved job URLs and retain this failed delivery record.</span> : null}
      {Number(counts.insufficient_memory || 0) > 0 ? <span>{counts.insufficient_memory} result{counts.insufficient_memory === 1 ? "" : "s"} need more information in ChatGPT Memory; no fit score was guessed.</span> : null}
      {Number(counts.needs_user || 0) > 0 ? <span>{counts.needs_user} job{Number(counts.needs_user) === 1 ? " needs" : "s need"} review. Any captured response remains saved; original messages are not resent.</span> : null}
      {batch.items?.map((item) => {
        const chunk = batch.chunks?.find((candidate) => candidate.job_ids?.includes(item.job_id));
        const itemStatus = chunk?.state === "needs_user"
          ? `Bridge delivery needs attention${chunk.error_message ? `: ${chunk.error_message}` : ""}`
          : item.state === "assessed" ? "Memory assessment saved"
            : item.state === "insufficient_memory" ? "ChatGPT Memory was insufficient; no score was fabricated"
              : item.error_message || item.state.replaceAll("_", " ");
        return <div className="jobAnalysisIssue" key={item.id}>
        <span>{itemStatus}</span>
        <a className="textLink" href={`/jobs/${item.job_id}`}>Open job</a>
      </div>;
      })}
    </div> : null}
    {error ? <p className="errorNotice" role="alert">{error}</p> : null}
  </div>;
}
