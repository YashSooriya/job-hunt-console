"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function JobIngestForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const response = await fetch("/api/jobs/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to analyse job.");
      router.push(result.applicationId ? `/applications/${result.applicationId}` : `/jobs/${result.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to analyse job.");
      setBusy(false);
    }
  }

  return (
    <form className="jobForm" onSubmit={submit}>
      <div className="formGrid two">
        <label><span>Company *</span><input className="input" name="company" required /></label>
        <label><span>Role title *</span><input className="input" name="title" required /></label>
        <label><span>Location</span><input className="input" name="location" placeholder="Reading, London, Bristol..." /></label>
        <label><span>Salary</span><input className="input" name="salaryText" placeholder="£55,000–£65,000" /></label>
        <label><span>Posted date</span><input className="input" name="postedAt" type="date" /></label>
        <label><span>Closing date</span><input className="input" name="closesAt" type="date" /></label>
        <label><span>Source URL</span><input className="input" name="sourceUrl" type="url" placeholder="https://..." /></label>
        <label><span>Job ID</span><input className="input" name="externalJobId" /></label>
      </div>
      <label className="fullField"><span>Job description *</span><textarea className="input textarea" name="description" required minLength={40} placeholder="Paste the complete vacancy description. The original text is preserved as a snapshot before analysis." /></label>
      <input type="hidden" name="discoverySource" value="manual" />
      <div className="formActions">
        <button className="primaryButton" disabled={busy} type="submit">{busy ? "Analysing…" : "Analyse job"}</button>
        <span>First-pass analysis is deterministic and evidence-grounded. It does not use paid OpenAI API calls.</span>
      </div>
      {error ? <div className="formError">{error}</div> : null}
    </form>
  );
}
