import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { ApplicationCreateButton } from "@/components/application-create-button";
import { JobIngestForm } from "@/components/job-ingest-form";
import { JobUrlInspectionForm } from "@/components/job-url-inspection-form";
import { SearchAutomationPanel } from "@/components/search-automation-panel";
import { getJobDataset, getPreparationApplications } from "@/lib/data/repository";

const triageLabel = {
  auto_prepare: "Auto-prepare",
  recommend: "Recommend",
  maybe: "Maybe",
  reject: "Reject",
} as const;

function dateLabel(value: string | null) {
  if (!value) return "Date unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function postingAge(value: string | null) {
  if (!value) return "Unknown";
  const posted = new Date(value).getTime();
  if (!Number.isFinite(posted)) return "Unknown";
  const days = Math.max(0, Math.floor((Date.now() - posted) / 86400000));
  return `${days} day${days === 1 ? "" : "s"}`;
}

function sourceLabel(source: string) {
  if (source === "chatgpt_url") return "URL + ChatGPT";
  if (source === "openai_responses") return "Instant ChatGPT";
  if (source === "chatgpt_mcp") return "ChatGPT search";
  return source === "manual" ? "Added by you" : source.replaceAll("_", " ");
}

export default async function JobsPage() {
  const [jobs, preparation] = await Promise.all([getJobDataset(), getPreparationApplications()]);
  const visible = jobs.records.filter((job) => job.triage !== "reject");
  const applicationByJob = new Map(preparation.records.map((item) => [item.jobId, item]));

  return (
    <AppShell>
      <div className="pageHeader">
        <div>
          <div className="eyebrow">Milestone 21</div>
          <h1 className="title">Autonomous job discovery</h1>
          <p className="sub">Recurring ChatGPT search runs preserve vacancy snapshots, deduplicate reposts, score roles against this member's verified evidence and surface only useful work.</p>
        </div>
        <DataSourceBadge source={jobs.source} />
      </div>

      <section className="metrics compactMetrics">
        <div className="metric"><span>Discovered</span><strong>{jobs.summary.total}</strong></div>
        <div className="metric"><span>Auto-prepare</span><strong>{jobs.summary.autoPrepare}</strong></div>
        <div className="metric"><span>Recommended</span><strong>{jobs.summary.recommend}</strong></div>
        <div className="metric"><span>Maybe</span><strong>{jobs.summary.maybe}</strong></div>
      </section>

      <SearchAutomationPanel />

      <section className="card jobEntryCard">
        <div className="cardHeader"><div><h2>Import from a job listing URL</h2><p>Let ChatGPT read a public listing and extract the complete vacancy record</p></div><span className="badge action">ChatGPT extraction</span></div>
        <JobUrlInspectionForm />
      </section>

      <section className="card jobEntryCard">
        <div className="cardHeader"><div><h2>Add a vacancy manually</h2><p>Use this path when you already have the listing text or want to test the deterministic pipeline</p></div></div>
        <JobIngestForm />
      </section>

      <section className="card tableCard jobPoolCard">
        <div className="cardHeader"><div><h2>Job pool</h2><p>URL imports and ChatGPT profile-matched discoveries appear together here. Choose a row to prepare an application; human review is still required before any employer-form work.</p></div><span className="badge muted">{jobs.summary.reject} rejected hidden</span></div>
        {visible.length ? <div className="tableWrap"><table className="dataTable jobPoolTable"><thead><tr><th>Company</th><th>Role</th><th>Salary</th><th>Posted</th><th>Source</th><th>Fit</th><th>Choose to apply</th></tr></thead><tbody>
          {visible.map((job) => {
            const application = applicationByJob.get(job.id);
            const disabledReason = !job.analysis
              ? "ChatGPT analysis pending"
              : job.analysis.eligibility === "ineligible" || job.analysis.triage === "reject"
                ? "This job is not eligible for application preparation."
                : null;
            return <tr key={job.id}>
              <td><strong>{job.company}</strong></td>
              <td><a className="textLink" href={`/jobs/${job.id}`}>{job.title}</a>{job.location ? <span className="tableSubtext">{job.location}</span> : null}</td>
              <td>{job.salaryText || "Not listed"}{job.salarySource === "chatgpt_estimate" ? <span className="tableSubtext estimateText">ChatGPT estimate{job.salaryConfidence ? ` · ${job.salaryConfidence}` : ""}</span> : null}</td>
              <td><strong>{postingAge(job.postedAt)}</strong><span className="tableSubtext">{dateLabel(job.postedAt)}</span></td>
              <td><span className={`badge ${job.discoverySource === "chatgpt_url" || job.discoverySource === "openai_responses" || job.discoverySource === "chatgpt_mcp" ? "review" : "muted"}`}>{sourceLabel(job.discoverySource)}</span></td>
              <td>{job.analysis ? <><strong>{Math.round(job.analysis.fitScore)}</strong><span className="tableSubtext">Priority {Math.round(job.analysis.priorityScore)}</span></> : "—"}</td>
              <td><ApplicationCreateButton jobId={job.id} existingApplicationId={application?.id || null} disabledReason={disabledReason} actionLabel="Choose to apply" /></td>
            </tr>;
          })}
        </tbody></table></div> : <div className="emptyState">No newly discovered vacancies yet. Import a listing URL or run the connected ChatGPT search Task.</div>}
      </section>
    </AppShell>
  );
}
