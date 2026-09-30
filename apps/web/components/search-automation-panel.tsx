"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiResponse } from "@/lib/onboarding/client-api";

type SearchRun = {
  id: string;
  state: string;
  trigger: string;
  requested_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  next_run_at?: string | null;
  jobs_checked: number;
  jobs_discovered: number;
  jobs_deduped: number;
  jobs_accepted: number;
  summary?: Record<string, unknown>;
  error_json?: Record<string, unknown> | null;
};

type Source = { source_key: string; label: string; enabled: boolean; health: string; last_success_at?: string | null; last_error?: string | null };
type Schedule = { enabled: boolean; cadence: string; timezone: string; localTime: string; nextRunAt: string | null; lastRunAt: string | null; lastError: string | null };

function dateLabel(value?: string | null, timezone?: string) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", ...(timezone ? { timeZone: timezone } : {}) }).format(date); }
  catch { return date.toLocaleString("en-GB"); }
}

export function SearchAutomationPanel() {
  const [runs, setRuns] = useState<SearchRun[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [preferences, setPreferences] = useState<Record<string, any>>({});
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/search/runs", { cache: "no-store" });
    const data = await readApiResponse(response, "Search status unavailable");
    setRuns(data.runs || []); setSources(data.sources || []); setPreferences(data.preferences || {}); setSchedule(data.schedule || null);
  }, []);
  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Search status unavailable."));
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function toggle(source: Source) {
    try { const response = await fetch("/api/search/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceKey: source.source_key, enabled: !source.enabled }) }); await readApiResponse(response, "Could not update source"); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not update source."); }
  }

  const latestTerminal = runs.find((run) => ["completed", "failed", "user_required"].includes(run.state));
  const latestCompleted = runs.find((run) => run.state === "completed");
  const active = runs.find((run) => ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready", "sent", "acknowledged_by_mcp", "running", "importing"].includes(run.state));
  const activeAge = active ? Date.now() - Date.parse(active.started_at || active.requested_at) : 0;
  const activeStale = Boolean(active && active.state === "running" && Number.isFinite(activeAge) && activeAge > 45 * 60 * 1000);
  const stateLabel = activeStale ? "stalled" : active?.state || latestTerminal?.state || "not started";
  const cadence = schedule?.cadence || (typeof preferences.search_cadence === "string" ? preferences.search_cadence : "not configured");
  const nextScheduled = schedule?.enabled ? dateLabel(schedule.nextRunAt, schedule.timezone) : "Paused";
  return <section className="card searchAutomationCard">
    <div className="cardHeader"><div><h2>Search automation</h2><p>Runs automatically using your saved cadence.</p></div></div>
    <div className="searchStatusGrid"><div><span>Last search</span><strong>{latestCompleted ? dateLabel(latestCompleted.finished_at || latestCompleted.requested_at) : "Not yet"}</strong></div><div><span>Next search</span><strong>{schedule?.enabled ? `${nextScheduled} (${schedule.timezone})` : "Paused"}</strong></div><div><span>Status</span><strong className={activeStale ? "statusStale" : ""}>{stateLabel.replaceAll("_", " ")}</strong></div><div><span>Cadence</span><strong>{cadence}{schedule?.enabled ? ` · ${schedule.localTime} ${schedule.timezone}` : ""}</strong></div></div>
    {schedule?.lastError ? <div className="notice warningNotice">The scheduler could not queue its latest run: {schedule.lastError}</div> : null}
    {activeStale ? <div className="notice warningNotice">This run has been running for more than 45 minutes. It is shown as stalled until the connected worker recovers or finalises it; starting another search may create duplicate work.</div> : null}
    {latestCompleted ? <div className="searchRunSummary"><span>{latestCompleted.jobs_checked} checked</span><span>{latestCompleted.jobs_discovered} added to pool</span><span>{latestCompleted.jobs_deduped} deduplicated</span><span>{latestCompleted.jobs_accepted} strong/kept</span>{typeof latestCompleted.summary?.result_summary === "string" ? <span>{latestCompleted.summary.result_summary}</span> : null}</div> : null}
    {error ? <p className="formError">{error}</p> : null}
    <details className="searchAutomationDetails"><summary>Sources and recent runs</summary>
      <div className="searchSourceList"><strong>Discovery sources</strong>{sources.length ? sources.map((source) => <label key={source.source_key}><input type="checkbox" checked={source.enabled} onChange={() => void toggle(source)} /><span>{source.label}</span><small>{source.enabled ? source.health : "Off"}</small></label>) : <p className="emptyState">Save search preferences to set up discovery sources.</p>}</div>
      <div className="searchHistory">{runs.slice(0, 5).map((run) => <div key={run.id}><span>{dateLabel(run.requested_at)}</span><strong className={run.state === "running" && Date.now() - Date.parse(run.started_at || run.requested_at) > 45 * 60 * 1000 ? "statusStale" : ""}>{run.state === "running" && Date.now() - Date.parse(run.started_at || run.requested_at) > 45 * 60 * 1000 ? "stalled" : run.state.replaceAll("_", " ")}</strong><small>{run.jobs_discovered} added · {run.jobs_accepted} kept</small>{typeof run.summary?.result_summary === "string" ? <small>{run.summary.result_summary}</small> : null}{typeof run.error_json?.message === "string" ? <small className="formError">{run.error_json.message}</small> : null}</div>)}</div>
    </details>
  </section>;
}
