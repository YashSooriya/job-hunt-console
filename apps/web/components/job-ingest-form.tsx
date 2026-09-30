"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { readApiResponse } from "@/lib/onboarding/client-api";

export function JobIngestForm({ initialSourceUrl = "" }: { initialSourceUrl?: string }) {
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
      const result = await readApiResponse(response, "Unable to analyse job");
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
      </div>
      <details className="advancedJobFields">
        <summary>Optional details</summary>
        <div className="formGrid two">
        <label><span>Industry</span><input className="input" name="industry" placeholder="e.g. Scientific software, aerospace" /></label>
        <label><span>Work mode</span><select className="input" name="workMode" defaultValue=""><option value="">Not specified</option><option value="onsite">On-site</option><option value="hybrid">Hybrid</option><option value="remote">Remote</option></select></label>
        <label><span>Employment type</span><input className="input" name="employmentType" placeholder="Full-time, contract..." /></label>
        <label><span>Salary minimum</span><input className="input" name="salaryMin" type="number" min="0" step="1" inputMode="decimal" /></label>
        <label><span>Salary maximum</span><input className="input" name="salaryMax" type="number" min="0" step="1" inputMode="decimal" /></label>
        <label><span>Salary currency</span><input className="input" name="salaryCurrency" defaultValue="GBP" maxLength={10} /></label>
        <label><span>Posted date</span><input className="input" name="postedAt" type="date" /></label>
        <label><span>Closing date</span><input className="input" name="closesAt" type="date" /></label>
        <label><span>Source URL</span><input className="input" name="sourceUrl" type="url" defaultValue={initialSourceUrl} placeholder="https://..." /></label>
        <label><span>Application URL</span><input className="input" name="applicationUrl" type="url" placeholder="https://..." /></label>
        <label><span>Job ID</span><input className="input" name="externalJobId" /></label>
        </div>
      </details>
      <label className="fullField"><span>Job description *</span><textarea className="input textarea" name="description" required minLength={40} placeholder="Paste the complete vacancy description. The original text is preserved as a snapshot before analysis." /></label>
      <input type="hidden" name="discoverySource" value="manual" />
      <div className="formActions">
        <button className="primaryButton" disabled={busy} type="submit">{busy ? "Saving…" : "Save vacancy"}</button>
      </div>
      {error ? <div className="formError">{error}</div> : null}
    </form>
  );
}
