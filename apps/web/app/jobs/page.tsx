import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { JobIngestForm } from "@/components/job-ingest-form";
import { SearchAutomationPanel } from "@/components/search-automation-panel";
import { getJobDataset } from "@/lib/data/repository";

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

export default async function JobsPage() {
  const jobs = await getJobDataset();
  const visible = jobs.records.filter((job) => job.triage !== "reject");

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
        <div className="cardHeader"><div><h2>Add a vacancy</h2><p>Manual ingestion path for testing the complete intelligence pipeline</p></div></div>
        <JobIngestForm />
      </section>

      <section className="card jobInboxCard">
        <div className="cardHeader"><div><h2>Job inbox</h2><p>Rejected jobs are retained for deduplication but hidden from the working queue by default</p></div><span className="badge muted">{jobs.summary.reject} rejected</span></div>
        {visible.length ? visible.map((job) => (
          <a className="jobInboxRow" href={`/jobs/${job.id}`} key={job.id}>
            <div className="jobInboxMain">
              <div className="role">{job.title}</div>
              <div className="company">{job.company}{job.location ? ` · ${job.location}` : ""}</div>
              <div className="badges">
                {job.triage ? <span className={`badge triage-${job.triage}`}>{triageLabel[job.triage]}</span> : null}
                <span className="badge">Posted {dateLabel(job.postedAt)}</span>
                {job.salaryText ? <span className="badge">{job.salaryText}</span> : <span className="badge muted">Salary not advertised</span>}
              </div>
            </div>
            <div className="scorePair">
              <span><small>Fit</small><strong>{job.analysis ? Math.round(job.analysis.fitScore) : "–"}</strong></span>
              <span><small>Priority</small><strong>{job.analysis ? Math.round(job.analysis.priorityScore) : "–"}</strong></span>
            </div>
          </a>
        )) : <div className="emptyState">No newly discovered vacancies yet. Paste a vacancy above to test the full analysis path.</div>}
      </section>
    </AppShell>
  );
}
