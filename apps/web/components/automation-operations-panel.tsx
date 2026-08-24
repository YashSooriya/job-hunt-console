"use client";

import { useCallback, useEffect, useState } from "react";

type Operations = { work?: Record<string, number>; search?: { active_runs?: number; last_run?: Record<string, any> }; browser?: Record<string, number>; rate_limits?: Array<{ bucket: string; request_count: number; window_started_at: string }> };

export function AutomationOperationsPanel() {
  const [data, setData] = useState<Operations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/operations/status", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || "Operations status unavailable.");
    setData(body);
  }, []);
  useEffect(() => { load().catch((err) => setError(err instanceof Error ? err.message : "Operations status unavailable.")); }, [load]);
  const work = data?.work || {};
  const browser = data?.browser || {};
  return <section className="card operationsCard">
    <div className="cardHeader"><div><div className="eyebrow">M24 reliability</div><h2>Automation operations</h2><p>Per-user queue recovery, browser sessions and rate-limit windows. Counts are operational metadata only; private applicant content is not exposed here.</p></div><span className={`badge ${data ? "review" : "muted"}`}>{data ? "Healthy boundary" : "Loading"}</span></div>
    {data ? <><div className="operationsGrid"><div><span>Queued work</span><strong>{work.queued ?? 0}</strong></div><div><span>Stale leases</span><strong>{work.stale ?? 0}</strong></div><div><span>User-required</span><strong>{work.user_required ?? 0}</strong></div><div><span>Browser pauses</span><strong>{browser.needs_user ?? 0}</strong></div><div><span>Active searches</span><strong>{data.search?.active_runs ?? 0}</strong></div><div><span>Failed / 24h</span><strong>{work.failed_last_24h ?? 0}</strong></div></div><div className="rateLimitList">{(data.rate_limits || []).map((item) => <span key={item.bucket}><strong>{item.bucket.replaceAll("_", " ")}</strong> {item.request_count} used</span>)}</div></> : null}
    {error ? <p className="formError">{error}</p> : null}
  </section>;
}
