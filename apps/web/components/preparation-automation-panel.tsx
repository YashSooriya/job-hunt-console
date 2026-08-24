"use client";

import { useCallback, useEffect, useState } from "react";

type RequestRow = {
  id: string;
  state: string;
  source: string;
  application_id: string | null;
  selected_cv_family: string | null;
  created_at: string;
  job?: { title?: string; companies?: { canonical_name?: string } | { canonical_name?: string }[] } | null;
};

function human(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()) : "—";
}

function companyName(job: RequestRow["job"]) {
  const companies = job?.companies;
  return Array.isArray(companies) ? companies[0]?.canonical_name : companies?.canonical_name;
}

export function PreparationAutomationPanel() {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/applications/preparation", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Preparation automation unavailable.");
    setRequests(data.requests || []);
  }, []);
  useEffect(() => { load().catch((err) => setError(err instanceof Error ? err.message : "Preparation automation unavailable.")); }, [load]);

  return <section className="card preparationAutomationCard">
    <div className="cardHeader"><div><div className="eyebrow">M22 automatic preparation</div><h2>Preparation requests</h2><p>Eligible high-confidence matches can be prepared in the background. Every request stays before human Gate 1; no employer form is opened.</p></div></div>
    {requests.length ? <div className="preparationRequestList">{requests.slice(0, 6).map((request) => <div key={request.id}><div><strong>{request.job?.title || "Vacancy"}</strong><span>{companyName(request.job) || "Company unavailable"} · {human(request.source)}</span></div><div className="badges"><span className={`badge ${request.state === "blocked" ? "danger" : request.state === "awaiting_content" ? "action" : "review"}`}>{human(request.state)}</span>{request.selected_cv_family ? <span className="badge muted">{human(request.selected_cv_family)} CV</span> : null}{request.application_id ? <a className="textLink" href={`/applications/${request.application_id}`}>Open</a> : null}</div></div>)}</div> : <div className="emptyState">No automatic preparation requests yet. Strong matches will appear here after a connected search worker runs.</div>}
    {error ? <p className="formError">{error}</p> : null}
  </section>;
}
