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
  execution?: "openai_responses" | "chatgpt_mcp_fallback";
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
        setInspection({ ...next, execution: inspection.execution });
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
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to start the listing inspection.");
      const next = { ...(result.inspection as Inspection), execution: result.execution as Inspection["execution"] };
      setInspection(next);
      formElement.reset();
      if (next.status === "completed" && next.job_id) {
        router.push(`/jobs/${next.job_id}`);
        router.refresh();
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to start the listing inspection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="urlInspectionBody">
      <form className="urlInspectionForm" onSubmit={submit}>
        <label><span>Public job listing URL *</span><input className="input" name="sourceUrl" type="url" required placeholder="https://company.example/careers/role" /></label>
        <button className="primaryButton" disabled={busy || Boolean(inspection && ["queued", "processing"].includes(inspection.status))} type="submit">{busy ? "Starting ChatGPT…" : "Inspect with ChatGPT"}</button>
      </form>
      <p className="formHint">With the OpenAI production key configured, this button starts a ChatGPT model inspection immediately. If that key is not configured, the URL is handed to your connected ChatGPT Task in Project Job Hunt instead. Either path is read-only: it never signs in, applies, or submits an employer form.</p>
      {inspection ? <div className="urlInspectionStatus">
        <span className={`badge ${inspection.status === "completed" ? "review" : inspection.status === "failed" || inspection.status === "user_required" ? "danger" : "action"}`}>{inspectionStatusLabel(inspection.status)}</span>
        <span>{inspection.status === "queued" ? "Run your recurring ChatGPT Task to pick this URL up; immediate OpenAI inspection is not configured on this deployment." : inspection.status === "processing" ? inspection.execution === "openai_responses" ? "The immediate ChatGPT model inspection is running now." : "ChatGPT has claimed the URL and is extracting the listing." : inspection.status === "completed" ? "Opening the imported vacancy…" : inspection.error_json?.message || "Review the listing URL and try again."}</span>
      </div> : null}
      {error ? <div className="formError">{error}</div> : null}
    </div>
  );
}
