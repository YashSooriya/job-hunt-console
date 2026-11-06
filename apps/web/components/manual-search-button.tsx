"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dispatchStateLabel, readBridgeApiJson } from "@/lib/chatgpt-bridge/client";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";

type Availability = {
  serverNow?: string | null;
  allowed?: boolean;
  cooldownDisabled?: boolean;
  lastTriggeredAt?: string | null;
  nextAllowedAt?: string | null;
  remainingSeconds?: number;
  scopeId?: string;
};

type SearchRunSnapshot = Record<string, any> & { id: string; state: string; dispatch_id?: string; error_json?: { message?: string } | null };

const ACTIVE_SEARCH_KEY = "jobhunt:manual-search-attempt:v1";
const TERMINAL_SEARCH_STATES = new Set(["completed", "failed", "user_required", "expired", "cancelled"]);

function scopedSearchKey(scopeId: string) {
  return `${ACTIVE_SEARCH_KEY}:${scopeId}`;
}

function formatRemaining(seconds: number) {
  const bounded = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(bounded / 3600);
  const minutes = Math.floor((bounded % 3600) / 60);
  const remainder = bounded % 60;
  return `${hours ? `${hours}h ` : ""}${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
}

export function ManualSearchButton() {
  const router = useRouter();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runScopeId, setRunScopeId] = useState<string | null>(null);
  const [storageScopeId, setStorageScopeId] = useState<string | null>(null);
  const [searchRun, setSearchRun] = useState<SearchRunSnapshot | null>(null);
  const [statusPolling, setStatusPolling] = useState(false);
  const [retryPolling, setRetryPolling] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const completionHandled = useRef<string | null>(null);
  const dispatchStatus = useDispatchStatus(dispatchId);
  const chatgptOperation = useChatGptOperation();
  const waitingForChatGpt = isWaitingForChatGpt({ state: dispatchStatus.state || undefined, raw: dispatchStatus.dispatch?.raw });

  const load = useCallback(async () => {
    const response = await fetch("/api/search/manual", { cache: "no-store" });
    const body = await readBridgeApiJson<{ ok?: boolean; availability?: Availability; error?: string }>(response);
    if (!response.ok || body.ok !== true || !body.availability || typeof body.availability.scopeId !== "string") {
      throw new Error(body.error || "Manual-search availability is unavailable.");
    }
    setStorageScopeId(body.availability.scopeId);
    setAvailability(body.availability);
    if (body.availability.serverNow) setClockOffset(Date.parse(body.availability.serverNow) - Date.now());
  }, []);

  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Manual-search availability is unavailable."));
    const refresh = window.setInterval(() => { void load().catch(() => undefined); }, 15000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => { if (document.visibilityState === "visible") void load().catch(() => undefined); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(refresh); window.clearInterval(tick); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  useEffect(() => {
    if (!storageScopeId) return;
    setRunId(null);
    setRunScopeId(null);
    setSearchRun(null);
    setDispatchId(null);
    setStatusPolling(false);
    setError(null);
    completionHandled.current = null;
    try {
      // Discard the pre-scope key because it could belong to a different
      // account that used this browser profile before the scoped format.
      window.localStorage.removeItem(ACTIVE_SEARCH_KEY);
      const saved = JSON.parse(window.localStorage.getItem(scopedSearchKey(storageScopeId)) || "null");
      if (saved && typeof saved.runId === "string") {
        setRunScopeId(storageScopeId);
        setRunId(saved.runId);
      }
    } catch { /* local recovery is optional; the run is also durable on the server */ }
  }, [storageScopeId]);

  useEffect(() => {
    if (!runId || !runScopeId || runScopeId !== storageScopeId || busy) return;
    let cancelled = false;
    let timer = 0;
    let attempts = 0;
    setStatusPolling(true);
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const response = await fetch(`/api/search/manual?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
        const body = await readBridgeApiJson<{ ok?: boolean; run?: SearchRunSnapshot; error?: string }>(response);
        if (!response.ok || body.ok !== true || !body.run) throw new Error(body.error || "Search status is unavailable.");
        const run = body.run;
        if (cancelled) return;
        setSearchRun(run);
        if (typeof run.dispatch_id === "string") setDispatchId(run.dispatch_id);
        const isTerminal = TERMINAL_SEARCH_STATES.has(run.state);
        const tooManyUploadRetries = run.state === "importing" && attempts >= 8;
        if (isTerminal || tooManyUploadRetries) {
          setStatusPolling(false);
          if (run.state === "completed") {
            try { window.localStorage.removeItem(scopedSearchKey(runScopeId)); } catch { /* ignore */ }
            if (completionHandled.current !== run.id) {
              completionHandled.current = run.id;
              router.refresh();
            }
          }
          return;
        }
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Search status is unavailable.");
        if (attempts >= 8) { setStatusPolling(false); return; }
      }
      timer = window.setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [runId, runScopeId, storageScopeId, retryPolling, router, busy]);

  const remaining = useMemo(() => {
    if (!availability?.nextAllowedAt || availability.cooldownDisabled) return 0;
    const next = Date.parse(availability.nextAllowedAt);
    return Number.isFinite(next) ? Math.max(0, Math.ceil((next - (now + clockOffset)) / 1000)) : Number(availability.remainingSeconds || 0);
  }, [availability, clockOffset, now]);
  const allowed = Boolean(storageScopeId && availability && (availability.cooldownDisabled || !availability.nextAllowedAt || remaining <= 0));

  async function run() {
    if (!storageScopeId) { setError("Manual-search availability is still loading."); return; }
    const operationToken = chatgptOperation.beginLocalOperation("Manual job search");
    if (!operationToken) { setError(chatgptOperation.message || "Another ChatGPT task is already active."); return; }
    setBusy(true); setError(null);
    try {
      const activeSearchKey = scopedSearchKey(storageScopeId);
      let saved: { runId?: string } | null = null;
      try { saved = JSON.parse(window.localStorage.getItem(activeSearchKey) || "null"); } catch { saved = null; }
      const reusable = saved?.runId && (!searchRun || !TERMINAL_SEARCH_STATES.has(searchRun.state)) ? saved.runId : null;
      const nextRunId = reusable || window.crypto.randomUUID();
      try { window.localStorage.setItem(activeSearchKey, JSON.stringify({ runId: nextRunId })); } catch { /* the server request remains idempotent within this attempt */ }
      // Start status polling only after the POST has created or recovered the
      // durable run. Polling here races the POST and can show a false 404.
      const response = await fetch("/api/search/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: nextRunId }) });
      const body = await readBridgeApiJson<{ ok?: boolean; runId?: string; dispatch?: Record<string, unknown>; activeRunId?: string; activeDispatchId?: string; reason?: string; availability?: Availability; bridge_hint?: unknown; error?: string }>(response);
      if (body.availability) {
        setAvailability(body.availability);
        if (body.availability.serverNow) setClockOffset(Date.parse(body.availability.serverNow) - Date.now());
      }
      if (!response.ok || body.ok !== true) {
        if (response.status === 429) setRunId(null);
        if (response.status === 409 && body.reason === "active_search" && typeof body.activeRunId === "string") {
          setRunScopeId(storageScopeId);
          setRunId(body.activeRunId);
          if (typeof body.activeDispatchId === "string") setDispatchId(body.activeDispatchId);
          try { window.localStorage.setItem(activeSearchKey, JSON.stringify({ runId: body.activeRunId })); } catch { /* recovery remains available from server history */ }
          setError(body.error || "A search is already in progress; showing its existing status.");
          return;
        }
        throw new Error(body.error || "Unable to queue a manual search.");
      }
      setRunScopeId(storageScopeId);
      setRunId(typeof body.runId === "string" ? body.runId : nextRunId);
      notifyBridgeHint(body.bridge_hint);
      if (body.dispatch && typeof body.dispatch.id === "string") {
        setDispatchId(body.dispatch.id);
        setSearchRun({ id: body.runId || nextRunId, state: String(body.dispatch.state || "queued"), dispatch_id: body.dispatch.id });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to queue a manual search.");
    } finally {
      setBusy(false);
      void load().catch(() => undefined);
      chatgptOperation.finishLocalOperation(operationToken);
    }
  }

  function retryCapturedResultUpload() {
    setError(null);
    setRetryPolling((value) => value + 1);
  }

  return <div className="manualSearchControl">
    <button className="primaryButton" type="button" disabled={busy || chatgptOperation.blocked || !allowed} onClick={() => void run()}>
      {waitingForChatGpt ? <><span className="chatgptActivitySpinner" aria-hidden="true" /> Searching jobs…</> : busy ? "Queueing…" : "Search jobs now"}
    </button>
    <small className="cooldownLabel" aria-live="polite">
      {!availability ? "Checking availability…" : availability.cooldownDisabled ? "Cooldown disabled for diagnostics" : allowed ? "Available now · limited to once per hour" : `Next search in ${formatRemaining(remaining)}`}
    </small>
    {dispatchStatus.dispatch ? <small className="cooldownLabel">Search bridge: {dispatchStateLabel(dispatchStatus.state || "queued", dispatchStatus.dispatch.raw)}{waitingForChatGpt ? <> · <span className="chatgptActivitySpinner" aria-hidden="true" /> Waiting for ChatGPT</> : ""}</small> : null}
    {searchRun ? <div className="manualSearchResult" role="status" aria-live="polite">
      <strong>{searchRun.state === "completed" ? "Search complete" : searchRun.state === "importing" ? "Saving captured search results" : `Search ${searchRun.state.replaceAll("_", " ")}`}</strong>
      {typeof searchRun.jobs_discovered === "number" ? <span>{searchRun.jobs_discovered} job{searchRun.jobs_discovered === 1 ? "" : "s"} added to the pool{typeof searchRun.jobs_checked === "number" ? ` · ${searchRun.jobs_checked} checked` : ""}</span> : null}
      {typeof searchRun.summary?.result_summary === "string" ? <span>{searchRun.summary.result_summary}</span> : null}
      {searchRun.error_json?.message ? <span className="formError">{searchRun.error_json.message}</span> : null}
      {searchRun.state === "importing" && !statusPolling ? <button className="textButton" type="button" onClick={retryCapturedResultUpload}>Retry saving captured results</button> : null}
    </div> : null}
    {error ? <small className="formError">{error}</small> : null}
    </div>;
}
