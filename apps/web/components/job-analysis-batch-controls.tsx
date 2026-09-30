"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";
import { dispatchStateLabel, readBridgeApiJson } from "@/lib/chatgpt-bridge/client";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";

type AnalysisMode = "pending" | "selected" | "outdated" | "retry";
type QueueRequest = { mode: AnalysisMode; requestId: string; jobIds: string[] };
type TaskSummary = {
  id: string; job_id: string; state: string; current_step_index: number;
  active_dispatch_id?: string | null; response_check_attempt_count?: number; error_message?: string | null;
};
type AnalysisBatch = {
  batch_id: string;
  mode: AnalysisMode;
  state: "queued" | "processing" | "completed" | "partial" | string;
  requested_count: number;
  counts?: { total?: number; completed?: number; queued?: number; running?: number; failed?: number; needs_user?: number };
  tasks?: TaskSummary[];
  issues?: Array<{
    task_id: string; job_id: string; state: string; message?: string | null;
    dispatch_id?: string | null; response_check_attempt_count?: number;
  }>;
};
type Dispatch = Record<string, any>;

const STORAGE_KEY = "jobhunt.job-fit-v3.latest-batch";
const REQUEST_STORAGE_KEY = "jobhunt.job-fit-v3.pending-request";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const END_STATES = new Set(["completed", "failed", "expired", "cancelled", "user_required"]);
function active(state: string | undefined) { return state === "queued" || state === "processing"; }
function requestUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function messageOf(value: unknown, fallback: string) { return value && typeof value === "object" && "error" in value && typeof (value as { error: unknown }).error === "string" ? (value as { error: string }).error : fallback; }
function clearStored() { try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Persistent progress remains in the database. */ } }
function clearStoredRequest() { try { window.localStorage.removeItem(REQUEST_STORAGE_KEY); } catch { /* The request can be recovered from its ref during this page session. */ } }
function readStoredRequest(): QueueRequest | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(REQUEST_STORAGE_KEY) || "null");
    if (!value || typeof value !== "object" || !UUID.test(String(value.requestId || "")) || !["pending", "selected", "outdated", "retry"].includes(value.mode) || !Array.isArray(value.jobIds)) {
      clearStoredRequest(); return null;
    }
    const jobIds = value.jobIds.filter((id: unknown): id is string => typeof id === "string" && UUID.test(id));
    if (jobIds.length !== value.jobIds.length || (value.mode !== "retry" && (jobIds.length < 1 || jobIds.length > 100)) || (value.mode === "retry" && jobIds.length !== 0)) {
      clearStoredRequest(); return null;
    }
    return { mode: value.mode, requestId: value.requestId, jobIds };
  } catch { clearStoredRequest(); return null; }
}
function storeRequest(value: QueueRequest) { try { window.localStorage.setItem(REQUEST_STORAGE_KEY, JSON.stringify(value)); } catch { /* Server idempotency still protects this page session. */ } }
function Spinner() { return <span className="chatgptActivitySpinner" aria-hidden="true" />; }

/** The page reports durable progress only; a server scheduler owns all sends and response capture. */
export function JobAnalysisBatchControls({
  pendingIds,
  outdatedIds,
  selectedIds,
  maxSelected = 100,
}: {
  pendingIds: string[];
  outdatedIds: string[];
  selectedIds: string[];
  maxSelected?: number;
}) {
  const router = useRouter();
  const chatgpt = useChatGptOperation();
  const [batch, setBatch] = useState<AnalysisBatch | null>(null);
  const [retryableCount, setRetryableCount] = useState(0);
  const [queueing, setQueueing] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const monitorLock = useRef(false);
  const requestPayload = useRef<QueueRequest | null>(null);
  const lastHintedDispatchId = useRef<string | null>(null);

  const readBatch = useCallback(async (batchId: string) => {
    const response = await fetch(`/api/jobs/analysis/v3?batchId=${encodeURIComponent(batchId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (response.status === 404) { clearStored(); setBatch(null); return null; }
    if (!response.ok || !data?.ok || !data.batch) throw new Error(messageOf(data, "Unable to read fit-analysis progress."));
    const next = data.batch as AnalysisBatch;
    setBatch(next);
    return next;
  }, []);

  const readTask = useCallback(async (taskId: string) => {
    const response = await fetch(`/api/jobs/analysis/v3?taskId=${encodeURIComponent(taskId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data.task) throw new Error(messageOf(data, "Unable to read the saved fit-analysis step."));
    return data.task as Record<string, any>;
  }, []);

  const advance = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/jobs/analysis/v3/advance", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw new Error(messageOf(data, "Unable to safely recover the saved fit step."));
    return data as Record<string, any>;
  }, []);

  const resolveBatch = useCallback(async (pending: QueueRequest) => {
    let response = await fetch(`/api/jobs/analysis/v3?requestId=${encodeURIComponent(pending.requestId)}`, { cache: "no-store" });
    let data = await response.json().catch(() => null);
    if (response.status === 404) {
      response = await fetch("/api/jobs/analysis/v3", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pending),
      });
      data = await response.json().catch(() => null);
    }
    if (!response.ok || !data?.ok || !UUID.test(String(data.batch?.id || data.batch?.batch_id || data.batch_id || ""))) {
      const requestError = new Error(messageOf(data, "Unable to queue fit analysis.")) as Error & { status?: number };
      requestError.status = response.status;
      throw requestError;
    }
    return {
      id: String(data.batch?.id || data.batch?.batch_id || data.batch_id),
      state: data.batch?.state || "queued",
      requestedCount: Number(data.batch?.requested_count ?? data.batch?.requestedCount) || pending.jobIds.length,
    };
  }, []);

  const readRetryableCount = useCallback(async () => {
    const response = await fetch("/api/jobs/analysis/v3?summary=1", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !Number.isSafeInteger(data.retryableCount)) throw new Error(messageOf(data, "Unable to read failed fit-analysis tasks."));
    setRetryableCount(data.retryableCount);
  }, []);

  const retryPreDeliveryStep = useCallback(async (taskId: string, dispatchId: string) => {
    const result = await advance({ action: "retry_pre_delivery", taskId, dispatchId });
    if (result.state !== "waiting_for_bridge" || !result.bridge_hint) {
      throw new Error("The exact unsent fit step was not safely requeued. No earlier ChatGPT message was resent.");
    }
    notifyBridgeHint(result.bridge_hint);
    setDispatch({ id: dispatchId, state: "queued" });
    void chatgpt.refresh().catch(() => undefined);
    return result;
  }, [advance, chatgpt.refresh]);

  const refreshProgress = useCallback(async (batchId: string) => {
    if (monitorLock.current) return;
    monitorLock.current = true;
    try {
      const current = await readBatch(batchId);
      if (!current) return;
      const activeTask = current.tasks?.find((task) => task.state === "waiting_for_bridge");
      if (activeTask) {
        const task = await readTask(activeTask.id);
        if (UUID.test(String(task.active_dispatch_id || ""))) {
          const response = await fetch(`/api/chatgpt-bridge/dispatch?id=${encodeURIComponent(task.active_dispatch_id)}`, { cache: "no-store" });
          const data = await readBridgeApiJson(response);
          if (!response.ok || data.ok !== true || !data.dispatch) throw new Error(messageOf(data, "Unable to read Website Bridge progress."));
          const exactDispatch = data.dispatch as Dispatch;
          setDispatch(exactDispatch);
          // The scheduler may create later generic Bridge steps after the
          // original page request has returned. This is only a wake-up hint;
          // the extension still claims and validates the persisted dispatch.
          if (exactDispatch.state === "queued" && lastHintedDispatchId.current !== task.active_dispatch_id) {
            lastHintedDispatchId.current = task.active_dispatch_id;
            notifyBridgeHint({
              version: 1,
              type: "JOBHUNT_DISPATCH_HINT",
              request_id: task.active_dispatch_id,
              correlation_id: typeof exactDispatch.correlation_id === "string" ? exactDispatch.correlation_id : task.active_dispatch_id,
              nonce: requestUuid(),
            });
          }
          setStatus(isWaitingForChatGpt({ state: String(exactDispatch.state), raw: exactDispatch })
            ? task.response_check_attempt_count === 1
              ? "The Bridge is checking the exact existing ChatGPT turn. The original fit message will not be resent."
              : "The background fit assessment is waiting for ChatGPT’s exact response."
            : exactDispatch.state === "completed"
              ? "ChatGPT responded; the background worker is validating and saving the captured result."
              : "The background worker is checking the saved Bridge request.");
        } else {
          setDispatch(null);
          setStatus("The fit step is queued for the background worker.");
        }
      } else if (current.tasks?.some((task) => task.state === "saving")) {
        setDispatch(null);
        setStatus("The captured assessment is being saved; the original message will not be resent.");
      } else if (active(current.state)) {
        setDispatch(null);
        setStatus("Fit analysis is queued. Progress is saved and continues if you leave this page.");
      } else {
        setDispatch(null);
        setStatus(current.state === "partial" ? "Completed steps are saved. Review items that need attention below." : "All selected jobs have current fit results.");
        void readRetryableCount().catch(() => undefined);
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read saved fit-analysis progress.");
    } finally {
      monitorLock.current = false;
    }
  }, [readBatch, readRetryableCount, readTask, router]);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored && UUID.test(stored)) {
          const restored = await readBatch(stored);
          if (!cancelled && restored && active(restored.state)) setStatus("Restored the saved fit-analysis progress.");
        } else {
          if (stored) clearStored();
          const pending = readStoredRequest();
          if (pending) {
            requestPayload.current = pending;
            setQueueing(true); setStatus("Recovering the saved fit-analysis request…");
            const restored = await resolveBatch(pending);
            if (!cancelled) {
              try { window.localStorage.setItem(STORAGE_KEY, restored.id); clearStoredRequest(); requestPayload.current = null; } catch { /* The database remains the durable copy. */ }
              setBatch({ batch_id: restored.id, mode: pending.mode, state: restored.state, requested_count: restored.requestedCount });
              setStatus("The saved fit analysis will continue in the background.");
            }
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to restore fit-analysis progress.");
      } finally { if (!cancelled) { setRestoring(false); setQueueing(false); } }
    }
    void restore();
    void readRetryableCount().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to read failed fit-analysis tasks."); });
    return () => { cancelled = true; };
  }, [readBatch, readRetryableCount, resolveBatch]);

  useEffect(() => {
    const batchId = batch?.batch_id;
    if (!batchId || !active(batch.state)) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refreshProgress(batchId);
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [batch?.batch_id, batch?.state, refreshProgress]);

  async function start(mode: AnalysisMode) {
    const ids = mode === "pending" ? pendingIds : mode === "outdated" ? outdatedIds : mode === "selected" ? selectedIds : [];
    if (queueing || busy || chatgpt.blocked || (mode !== "retry" && (!ids.length || ids.length > maxSelected))) return;
    setQueueing(true); setError(null); setStatus("Freezing the current verified profile and saved job listings…");
    const pending = requestPayload.current || { mode, requestId: requestUuid(), jobIds: [...ids] };
    requestPayload.current = pending;
    storeRequest(pending);
    clearStored();
    try {
      const queued = await resolveBatch(pending);
      try { window.localStorage.setItem(STORAGE_KEY, queued.id); clearStoredRequest(); requestPayload.current = null; } catch { /* The database remains the durable copy. */ }
      setBatch({ batch_id: queued.id, mode: pending.mode, state: queued.state, requested_count: queued.requestedCount || ids.length });
      setStatus("Fit analysis is saved and will continue in the background, one job at a time.");
    } catch (cause) {
      if (cause && typeof cause === "object" && "status" in cause && Number((cause as { status?: unknown }).status) >= 400 && Number((cause as { status?: unknown }).status) < 500) {
        requestPayload.current = null; clearStoredRequest();
      }
      setError(cause instanceof Error ? cause.message : "Unable to queue fit analysis."); setStatus("");
    } finally { setQueueing(false); }
  }

  async function resumeSafeUnsentSteps(batchId: string) {
    if (busy || queueing || chatgpt.blocked) return;
    setBusy(true); setError(null); setStatus("Checking which unfinished fit steps are confirmed not to have been sent…");
    try {
      const current = await readBatch(batchId);
      const needsUser = (current?.tasks || []).filter((task) => task.state === "needs_user");
      if (!needsUser.length) throw new Error("There are no saved fit steps waiting for safe pre-send recovery.");
      let safeCandidate: { taskId: string; dispatchId: string } | null = null;
      for (const candidate of needsUser) {
        const task = await readTask(candidate.id);
        const dispatchId = typeof task.active_dispatch_id === "string" ? task.active_dispatch_id : "";
        if (!UUID.test(dispatchId)) continue;
        const checked = await advance({ action: "check_pre_delivery", taskId: task.id, dispatchId });
        if (checked.safe === true) { safeCandidate = { taskId: task.id, dispatchId }; break; }
      }
      if (!safeCandidate) throw new Error("No unfinished step is currently confirmed safe to retry before Send. Any sent message remains untouched.");
      await retryPreDeliveryStep(safeCandidate.taskId, safeCandidate.dispatchId);
      setStatus("The confirmed-unsent step is requeued. The background worker will resume from its saved progress.");
      await readBatch(batchId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to resume the confirmed-unsent fit step.");
      setStatus("");
    } finally { setBusy(false); }
  }

  async function checkSavedResponse(taskId: string, dispatchId: string) {
    if (busy || queueing || chatgpt.blocked) return;
    setBusy(true); setError(null); setStatus("Requesting a read-only check of the exact existing ChatGPT turn…");
    try {
      const result = await advance({ action: "check_response", taskId, dispatchId });
      if (result.state !== "waiting_for_bridge" || !result.bridge_hint || !UUID.test(String(result.dispatchId || ""))) {
        throw new Error("The exact saved response was not queued for read-only recovery. The original message was not resent.");
      }
      notifyBridgeHint(result.bridge_hint);
      lastHintedDispatchId.current = String(result.dispatchId);
      setDispatch({ id: result.dispatchId, state: "queued", progress: { response_check_only: true } });
      setStatus("The Website Bridge will inspect only the exact existing turn; it will not send the fit message again.");
      void chatgpt.refresh().catch(() => undefined);
      if (batch?.batch_id) await readBatch(batch.batch_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to check the exact saved ChatGPT response.");
      setStatus("");
    } finally { setBusy(false); }
  }

  const counts = batch?.counts || {};
  const total = Number(counts.total ?? batch?.requested_count ?? 0);
  const done = Number(counts.completed || 0) + Number(counts.failed || 0) + Number(counts.needs_user || 0);
  const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  const waiting = isWaitingForChatGpt({ state: typeof dispatch?.state === "string" ? dispatch.state : undefined, raw: dispatch || undefined });
  const waitingLabel = dispatch?.state ? dispatchStateLabel(String(dispatch.state), dispatch) : "";

  return <div className="jobAnalysisBatch" aria-label="Job fit analysis">
    <div className="jobAnalysisBatchActions">
      <span className="jobAnalysisBatchLabel">Fit analysis</span>
      <button className="secondaryButton" type="button" disabled={restoring || queueing || busy || active(batch?.state) || chatgpt.blocked || pendingIds.length < 1} onClick={() => void start("pending")}>
        {queueing ? "Preparing…" : `Analyse pending${pendingIds.length ? ` (${pendingIds.length})` : ""}`}
      </button>
      <button className="secondaryButton" type="button" disabled={restoring || queueing || busy || active(batch?.state) || chatgpt.blocked || outdatedIds.length < 1} onClick={() => void start("outdated")}>
        Refresh outdated{outdatedIds.length ? ` (${outdatedIds.length})` : ""}
      </button>
      <button className="secondaryButton" type="button" disabled={restoring || queueing || busy || active(batch?.state) || chatgpt.blocked || !selectedIds.length || selectedIds.length > maxSelected} onClick={() => void start("selected")}>
        Analyse selected{selectedIds.length ? ` (${selectedIds.length})` : ""}
      </button>
      <button className="secondaryButton" type="button" disabled={restoring || queueing || busy || active(batch?.state) || chatgpt.blocked || retryableCount < 1} onClick={() => void start("retry")}>
        Retry failed{retryableCount ? ` (${retryableCount})` : ""}
      </button>
      {batch?.state === "partial" && Number(counts.needs_user || 0) > 0 ? <button className="secondaryButton" type="button" disabled={restoring || queueing || busy || chatgpt.blocked} onClick={() => void resumeSafeUnsentSteps(batch.batch_id)}>
        {busy ? "Checking…" : `Find safe unsent step (${Number(counts.needs_user || 0)} to review)`}
      </button> : null}
      {active(batch?.state) ? <button className="secondaryButton" type="button" disabled={restoring || queueing || busy} onClick={() => batch && void refreshProgress(batch.batch_id)}>Refresh progress</button> : null}
    </div>
    {selectedIds.length > maxSelected ? <p className="jobAnalysisHint" role="status">Select up to {maxSelected} jobs per batch.</p> : null}
    {batch ? <div className="jobAnalysisProgress" role="status" aria-live="polite">
      <div className="jobAnalysisProgressHeading"><strong>{batch.state === "queued" ? "Queued for fit analysis" : active(batch.state) ? "Analysing your saved listings" : batch.state === "partial" ? "Analysis finished with items to review" : "Fit analysis complete"}</strong><span>{done} of {total} complete{active(batch.state) ? ` · ${Number(counts.queued || 0) + Number(counts.running || 0)} remaining` : ""}</span></div>
      <progress max={total || 1} value={done} aria-label={`Job analysis progress (${percent} percent)`} />
      {status ? <span>{waiting ? <><Spinner /> ChatGPT is working · {waitingLabel || "waiting for its response"}</> : status}</span> : null}
      {Number(counts.failed || 0) > 0 ? <span>{counts.failed} task{Number(counts.failed) === 1 ? " needs" : "s need"} attention. Saved ChatGPT responses are retried for publication without resending their messages.</span> : null}
      {Number(counts.needs_user || 0) > 0 ? <span>{counts.needs_user} assessment{Number(counts.needs_user) === 1 ? " needs" : "s need"} more information or review.</span> : null}
      {batch.issues?.slice(0, 5).map((issue) => <div className="jobAnalysisIssue" key={`${issue.task_id}:${issue.state}`}>
        <span>{issue.message || (issue.state === "failed" ? "Temporary failure; use Retry failed." : "This assessment needs an update.")}</span>
        <a className="textLink" href={`/jobs/${issue.job_id}`}>Open job</a>
        {issue.state === "needs_user" && issue.dispatch_id && Number(issue.response_check_attempt_count || 0) === 0
          ? <button className="secondaryButton" type="button" disabled={busy || queueing || chatgpt.blocked} onClick={() => void checkSavedResponse(issue.task_id, issue.dispatch_id as string)}>Check saved response (no resend)</button>
          : issue.state === "needs_user" && Number(issue.response_check_attempt_count || 0) > 0
            ? <span>This step has already had its one read-only response check. Refresh the fit analysis to start a new attempt.</span>
            : null}
      </div>)}
    </div> : null}
    {error ? <div className="formError" role="alert">{error}</div> : null}
  </div>;
}
