import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { getEmailMonitoringDataset, getJobDataset, getPreparationApplications, getProgressionDataset, getTrackerDataset } from "@/lib/data/repository";
import { GmailSync } from "@/components/gmail-sync";
import { SearchAutomationPanel } from "@/components/search-automation-panel";

function fitLabel(value: number | null | undefined) {
  const score = Math.max(0, Math.min(100, Number(value || 0)));
  return `${(score / 10).toFixed(1)}/10`;
}

function formatDate(value: string | null) {
  if (!value) return "No deadline";
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

export default async function Dashboard() {
  let tracker: Awaited<ReturnType<typeof getTrackerDataset>>;
  let jobs: Awaited<ReturnType<typeof getJobDataset>>;
  let preparation: Awaited<ReturnType<typeof getPreparationApplications>>;
  let mail: Awaited<ReturnType<typeof getEmailMonitoringDataset>>;
  let progression: Awaited<ReturnType<typeof getProgressionDataset>>;
  try {
    [tracker, jobs, preparation, mail, progression] = await Promise.all([
      getTrackerDataset(),
      getJobDataset(),
      getPreparationApplications(),
      getEmailMonitoringDataset(),
      getProgressionDataset(),
    ]);
  } catch (error) {
    const detail = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { value: String(error) };
    console.error("jobhunt.dashboard.data_load_failed", detail);
    throw error;
  }
  const current = tracker.records.filter((item) => item.applicationState !== "rejected").slice(0, 6);
  const needsYou = tracker.records.filter((item) => item.status === "Action Required" || item.applicationState === "assessment").slice(0, 4);
  const mailNeedsYou = mail.records.filter((item) => item.needsUser).slice(0, 4);
  const applicationJobIds = new Set(preparation.records.map((item) => item.jobId));
  const strongJobs = jobs.records.filter((job) => (job.triage === "auto_prepare" || job.triage === "recommend") && !applicationJobIds.has(job.id)).slice(0, 4);
  const preparing = preparation.records.slice(0, 5);
  const upcomingProgression = [
    ...progression.assessments.filter((item) => !["completed", "cancelled", "expired"].includes(item.status)).map((item) => ({ kind: "assessment", id: item.id, company: item.company, role: item.role, when: item.deadlineAt, prep: item.preparationStatus })),
    ...progression.interviews.filter((item) => !["completed", "cancelled"].includes(item.status)).map((item) => ({ kind: "interview", id: item.id, company: item.company, role: item.role, when: item.scheduledAt, prep: item.preparationStatus })),
  ].sort((a,b) => String(a.when || "9999").localeCompare(String(b.when || "9999"))).slice(0,4);

  return (
    <AppShell>
      <div className="pageHeader">
        <div>
          <div className="eyebrow">Milestone 9</div>
          <h1 className="title">Application dashboard</h1>
          <p className="sub">Assessment and interview workspaces now turn pipeline progression into structured preparation using the exact submitted application context when available.</p>
        </div>
        <div><DataSourceBadge source={tracker.source === "supabase" || jobs.source === "supabase" ? "supabase" : "local_snapshot"} /><GmailSync auto={mail.source === "supabase"} /></div>
      </div>
      <SearchAutomationPanel />
      <section className="card profileBuilderCallout">
        <div>
          <div className="eyebrow">Start here</div>
          <h2>Build your professional profile</h2>
          <p>Give JobHuntAI your CV, LinkedIn profile and any extra context. ChatGPT will organise your experience, education, skills and application-form facts; you only review the extracted information.</p>
        </div>
        <a className="primaryButton" href="/onboarding">Build or update profile</a>
      </section>
      <section className="metrics">
        <div className="metric"><span>Needs attention</span><strong>{tracker.summary.actionRequired + mail.summary.needsUser}</strong></div>
        <div className="metric"><span>Applications preparing</span><strong>{preparation.summary.preparing}</strong></div>
        <div className="metric"><span>Active applications</span><strong>{tracker.records.filter((item) => !["rejected", "withdrawn", "expired"].includes(item.applicationState)).length}</strong></div>
        <div className="metric"><span>Progressed</span><strong>{tracker.records.filter((item) => ["assessment", "interview", "offer"].includes(item.applicationState)).length}</strong></div>
        <div className="metric"><span>Upcoming stages</span><strong>{progression.summary.assessments + progression.summary.interviews}</strong></div>
      </section>
      <section className="grid">
        <div className="card">
          <div className="cardHeader"><div><h2>{preparing.length ? "Applications preparing" : strongJobs.length ? "New strong matches" : "Current applications"}</h2><p>{preparing.length ? "Persistent application packages in progress" : strongJobs.length ? "Strong matches not yet converted into applications" : "Most recent active records"}</p></div><a className="textLink" href={preparing.length ? "/applications" : strongJobs.length ? "/jobs" : "/applications"}>View all</a></div>
          {preparing.length ? preparing.map((item) => (
            <a className="jobInboxRow" href={`/applications/${item.id}`} key={item.id}>
              <div><div className="role">{item.role}</div><div className="company">{item.company}</div><div className="badges"><span className="badge review">{item.progress.percent}% prepared</span><span className={`badge ${item.origin === "auto_prepare" ? "action" : "muted"}`}>{item.origin === "auto_prepare" ? "Auto-prepared" : "Manual"}</span></div></div>
              <div className="scorePair"><span><small>Fit</small><strong>{fitLabel(item.fitScore)}</strong></span><span><small>Done</small><strong>{item.progress.completed}/{item.progress.total}</strong></span></div>
            </a>
          )) : strongJobs.length ? strongJobs.map((job) => (
            <a className="jobInboxRow" href={`/jobs/${job.id}`} key={job.id}>
              <div><div className="role">{job.title}</div><div className="company">{job.company}</div><div className="badges"><span className={`badge triage-${job.triage}`}>{job.triage === "auto_prepare" ? "Auto-prepare" : "Recommend"}</span>{job.location ? <span className="badge">{job.location}</span> : null}</div></div>
              <div className="scorePair"><span><small>Fit</small><strong>{fitLabel(job.analysis?.fitScore)}</strong></span><span><small>Priority</small><strong>{Math.round(job.analysis?.priorityScore || 0)}</strong></span></div>
            </a>
          )) : current.map((item) => (
            <div className="row" key={`${item.sourceRow}-${item.company}-${item.role}`}><div><div className="role">{item.role}</div><div className="company">{item.company}</div><div className="badges"><span className={`badge ${item.applicationState === "assessment" ? "action" : "review"}`}>{item.stage}</span><span className="badge">{item.priority} priority</span><span className="badge">{formatDate(item.deadline)}</span></div></div></div>
          ))}
        </div>
        <aside className="card">
          <div className="cardHeader"><div><h2>Needs you</h2><p>Human decision points only</p></div></div>
          <div className="asideBody">
            {mailNeedsYou.map((item) => <a className="todo" href={`/email-review/${item.id}`} key={`mail-${item.id}`}><strong>{item.classification === "offer" ? "Offer decision" : item.classification === "recruiter_message" ? "Recruiter follow-up" : item.classificationSource === "chatgpt" ? "Email match needed" : "Email needs ChatGPT classification"}</strong><span>{item.subject || "Recruiting email"}{item.company ? ` · ${item.company}` : ""}</span></a>)}
            {needsYou.map((item) => <div className="todo" key={`${item.sourceRow}-${item.role}`}><strong>{item.company}: {item.stage}</strong><span>{item.role}. {item.nextAction || "Review required"}{item.deadline ? ` by ${formatDate(item.deadline)}.` : "."}</span></div>)}
            {upcomingProgression.map((item) => <a className="todo" href={`/${item.kind === "assessment" ? "assessments" : "interviews"}/${item.id}`} key={`progress-${item.kind}-${item.id}`}><strong>{item.kind === "assessment" ? "Assessment" : "Interview"}: {item.company}</strong><span>{item.role}. {item.prep === "not_prepared" ? "Preparation workspace not prepared." : "Preparation workspace ready."}</span></a>)}
            {!needsYou.length && !mailNeedsYou.length && !upcomingProgression.length ? <div className="emptyState">Nothing currently requires your input.</div> : null}
          </div>
        </aside>
      </section>
      <div className="notice">Fit and Priority are intentionally separate. Fit answers how suitable the role is; Priority incorporates screening likelihood, salary value, geography, freshness, effort and deadline urgency.</div>
    </AppShell>
  );
}
