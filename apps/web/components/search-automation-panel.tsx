"use client";

import { useCallback, useEffect, useState } from "react";
import { createChatGptDispatch } from "@/lib/chatgpt-bridge/client";

type SearchRun = {
  id: string;
  state: string;
  trigger: string;
  requested_at: string;
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

function dateLabel(value?: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB");
}

export function SearchAutomationPanel() {
  const [runs, setRuns] = useState<SearchRun[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [preferences, setPreferences] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/search/runs", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Search status unavailable.");
    setRuns(data.runs || []); setSources(data.sources || []); setPreferences(data.preferences || {});
  }, []);
  useEffect(() => { load().catch((err) => setError(err instanceof Error ? err.message : "Search status unavailable.")); }, [load]);

  async function runNow() {
    setBusy(true); setError(null);
    try { await createChatGptDispatch({ actionType: "jobs.search.manual", displayTitle: "Run a manual job search", websiteInstruction: "Run the requested job search and return the results clearly. Do not apply or contact employers.", idempotencyKey: `jobs.search.manual:${new Date().toISOString().slice(0, 10)}:${Math.floor(Date.now() / 60000)}` }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not queue search."); }
    finally { setBusy(false); }
  }

  async function toggle(source: Source) {
    try { const response = await fetch("/api/search/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceKey: source.source_key, enabled: !source.enabled }) }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "Could not update source."); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not update source."); }
  }

  const latest = runs[0];
  return <section className="card searchAutomationCard">
    <div className="cardHeader"><div><div className="eyebrow">M21 recurring discovery</div><h2>Search automation</h2><p>ChatGPT Tasks call the connected app, claim bounded search work and write discoveries back here. Search sources and cadence are controlled in JobHuntAI Console.</p></div><button className="primaryButton" disabled={busy} onClick={() => void runNow()}>{busy ? "Queueing…" : "Run search now"}</button></div>
    <div className="searchStatusGrid"><div><span>Last run</span><strong>{latest ? dateLabel(latest.finished_at || latest.requested_at) : "No runs yet"}</strong></div><div><span>Next expected</span><strong>{dateLabel(latest?.next_run_at)}</strong></div><div><span>Last state</span><strong>{latest?.state || "Not started"}</strong></div><div><span>Cadence</span><strong>{preferences.search_cadence || "Set in activation"}</strong></div></div>
    <div className="searchSourceList"><strong>Enabled discovery sources</strong>{sources.length ? sources.map((source) => <label key={source.source_key}><input type="checkbox" checked={source.enabled} onChange={() => void toggle(source)} /><span>{source.label}</span><small>{source.enabled ? source.health : "disabled"}</small></label>) : <p className="emptyState">Sources are initialised when the first search is queued.</p>}</div>
    {latest ? <div className="searchRunSummary"><span>{latest.jobs_checked} checked</span><span>{latest.jobs_discovered} new</span><span>{latest.jobs_deduped} deduplicated</span><span>{latest.jobs_accepted} strong/kept</span></div> : null}
    {error ? <p className="formError">{error}</p> : null}
    <div className="searchHistory">{runs.slice(0, 5).map((run) => <div key={run.id}><span>{dateLabel(run.requested_at)}</span><strong>{run.state}</strong><small>{run.jobs_discovered} new · {run.jobs_accepted} kept</small></div>)}</div>
  </section>;
}
