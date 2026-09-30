"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { JobRecord, JobUserStatus } from "@/lib/types";

const statuses: Array<[JobUserStatus, string]> = [
  ["new", "New"], ["reviewing", "Reviewing"], ["interested", "Interested"],
  ["not_interested", "Not interested"], ["applied", "Applied"], ["closed", "Closed"],
];

function dateValue(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

export function JobDetailControls({ job, initialEditing = false }: { job: JobRecord; initialEditing?: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(initialEditing);
  const [status, setStatus] = useState<JobUserStatus>(job.userStatus || "new");
  const [archived, setArchived] = useState(Boolean(job.archivedAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function manage(action: "archive" | "restore" | "status", nextStatus?: JobUserStatus) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/jobs/management", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [job.id], action, status: nextStatus }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to update this vacancy.");
      if (action === "archive") setArchived(true);
      if (action === "restore") setArchived(false);
      if (action === "status" && nextStatus) setStatus(nextStatus);
      setNotice(action === "status" ? "Your status was saved." : action === "archive" ? "Removed from the active pool. You can restore it here." : "Restored to the active pool.");
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update this vacancy.");
    } finally {
      setBusy(false);
    }
  }

  async function reanalyse() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reanalyse" }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to re-analyse this vacancy.");
      setNotice("Fit analysis was refreshed against your current profile.");
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to re-analyse this vacancy.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const response = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to save this vacancy.");
      setEditing(false);
      setNotice("Vacancy saved and fit analysis refreshed.");
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save this vacancy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card jobDetailManagement">
      <div className="cardHeader"><div><h2>Manage this vacancy</h2><p>Your status is yours to set and does not change ChatGPT’s separate fit assessment.</p></div></div>
      <div className="jobDetailManagementActions">
        <label><span>My status</span><select className="input" value={status} disabled={busy} onChange={(event) => void manage("status", event.target.value as JobUserStatus)}>{statuses.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <button className="secondaryButton" type="button" disabled={busy} onClick={() => setEditing((value) => !value)}>{editing ? "Close editor" : "Edit vacancy"}</button>
        <button className="secondaryButton" type="button" disabled={busy || archived} onClick={() => void reanalyse()}>Re-analyse against my profile</button>
        <button className="secondaryButton" type="button" disabled={busy} onClick={() => void manage(archived ? "restore" : "archive")}>{archived ? "Restore to job pool" : "Remove from job pool"}</button>
      </div>
      {archived ? <p className="jobArchiveHint">This vacancy is archived and hidden from the open job pool. Restore it when you want it back.</p> : null}
      {notice ? <p className="jobManagementNotice" role="status">{notice}</p> : null}
      {error ? <p className="formError jobManagementError" role="alert">{error}</p> : null}
      {editing ? <form className="jobEditForm" onSubmit={(event) => void save(event)}>
        <div className="formGrid two">
          <label><span>Company *</span><input className="input" name="company" required maxLength={300} defaultValue={job.company} /></label>
          <label><span>Role title *</span><input className="input" name="title" required maxLength={500} defaultValue={job.title} /></label>
          <label><span>Industry</span><input className="input" name="industry" maxLength={300} defaultValue={job.industry || ""} /></label>
          <label><span>Employer job ID</span><input className="input" name="externalJobId" maxLength={300} defaultValue={job.externalJobId || ""} /></label>
          <label><span>Location</span><input className="input" name="location" maxLength={500} defaultValue={job.location || ""} /></label>
          <label><span>Work mode</span><input className="input" name="workMode" maxLength={100} placeholder="On-site, hybrid, or remote" defaultValue={job.workMode || ""} /></label>
          <label><span>Employment type</span><input className="input" name="employmentType" maxLength={200} defaultValue={job.employmentType || ""} /></label>
          <label><span>Salary as shown</span><input className="input" name="salaryText" maxLength={500} defaultValue={job.salaryText || ""} /></label>
          <label><span>Salary minimum</span><input className="input" name="salaryMin" type="number" min="0" step="1" defaultValue={job.salaryMin ?? ""} /></label>
          <label><span>Salary maximum</span><input className="input" name="salaryMax" type="number" min="0" step="1" defaultValue={job.salaryMax ?? ""} /></label>
          <label><span>Salary currency</span><input className="input" name="salaryCurrency" maxLength={20} defaultValue={job.salaryCurrency || "GBP"} /></label>
          <label><span>Posted date</span><input className="input" name="postedAt" type="date" defaultValue={dateValue(job.postedAt)} /></label>
          <label><span>Closing date</span><input className="input" name="closesAt" type="date" defaultValue={dateValue(job.closesAt)} /></label>
          <label><span>Public listing URL</span><input className="input" name="sourceUrl" type="url" defaultValue={job.sourceUrl || ""} /></label>
          <label><span>Application URL</span><input className="input" name="applicationUrl" type="url" defaultValue={job.applicationUrl || ""} /></label>
        </div>
        <label className="fullField"><span>Saved job description *</span><textarea className="input textarea" name="description" required minLength={40} defaultValue={job.description} /></label>
        <div className="jobEditFooter"><p>Saving updates the structured vacancy and re-runs its fit analysis. Earlier captured listing snapshots stay in the record.</p><div className="buttonRow"><button className="secondaryButton" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button><button className="primaryButton" type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes and re-analyse"}</button></div></div>
      </form> : null}
    </section>
  );
}
