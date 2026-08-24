"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { inspectionStatusLabel, type JobUrlInspectionStatus } from "@/lib/job-url-inspection";

type Inspection = {
  id: string;
  source_url: string;
  status: JobUrlInspectionStatus;
  error_json?: { message?: string } | null;
  job_id?: string | null;
};

export function JobUrlInspectionForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);

  useEffect(() => {
    if (!inspection || !["queued", "processing"].includes(inspection.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/jobs/inspect?id=${encodeURIComponent(inspection.id)}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Unable to read inspection status.");
        const next = result.inspection as Inspection;
        setInspection(next);
        if (next.status === "completed" && next.job_id) {
          router.push(`/jobs/${next.job_id}`);
          router.refresh();
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "Unable to read inspection status.");
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [inspection, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await fetch("/api/jobs/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: form.get("sourceUrl") }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to queue the listing URL.");
      setInspection(result.inspection as Inspection);
      formElement.reset();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to queue the listing URL.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="urlInspectionBody">
      <form className="urlInspectionForm" onSubmit={submit}>
        <label><span>Public job listing URL *</span><input className="input" name="sourceUrl" type="url" required placeholder="https://company.example/careers/role" /></label>
        <button className="primaryButton" disabled={busy || Boolean(inspection && ["queued", "processing"].includes(inspection.status))} type="submit">{busy ? "Queueing…" : "Inspect with ChatGPT"}</button>
      </form>
      <p className="formHint">Your connected ChatGPT Task in Project Job Hunt opens the public listing in read-only mode, extracts the role details, and saves the vacancy here. It will never sign in, apply, or submit an employer form.</p>
      {inspection ? <div className="urlInspectionStatus">
        <span className={`badge ${inspection.status === "completed" ? "review" : inspection.status === "failed" || inspection.status === "user_required" ? "danger" : "action"}`}>{inspectionStatusLabel(inspection.status)}</span>
        <span>{inspection.status === "queued" ? "Run your recurring ChatGPT Task to pick this URL up." : inspection.status === "processing" ? "ChatGPT has claimed the URL and is extracting the listing." : inspection.status === "completed" ? "Opening the imported vacancy…" : inspection.error_json?.message || "Review the listing URL and try again."}</span>
      </div> : null}
      {error ? <div className="formError">{error}</div> : null}
    </div>
  );
}
