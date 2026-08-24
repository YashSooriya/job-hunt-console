import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { getProgressionDataset } from "@/lib/data/repository";

function dateTime(value: string | null) {
  if (!value) return "Not provided";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(value));
}

export default async function AssessmentsPage() {
  const progression = await getProgressionDataset();
  return (
    <AppShell>
      <div className="pageHeader">
        <div><div className="eyebrow">Milestone 9</div><h1 className="title">Assessments & interviews</h1><p className="sub">Preparation workspaces are grounded in the application context you actually submitted. Historical records are clearly marked when only best-available context exists.</p></div>
        <DataSourceBadge source={progression.source} />
      </div>
      <section className="metrics">
        <div className="metric"><span>Assessments</span><strong>{progression.summary.assessments}</strong></div>
        <div className="metric"><span>Interviews</span><strong>{progression.summary.interviews}</strong></div>
        <div className="metric"><span>Within 72h</span><strong>{progression.summary.dueSoon}</strong></div>
        <div className="metric"><span>Needs prep</span><strong>{progression.summary.needsPreparation}</strong></div>
      </section>

      <section className="card progressionListCard">
        <div className="cardHeader"><div><h2>Active assessments</h2><p>Preparation only. Live assessment questions must be completed independently according to the employer/provider rules.</p></div></div>
        {progression.assessments.length ? progression.assessments.map((item) => (
          <a className="progressionRow" href={`/assessments/${item.id}`} key={item.id}>
            <div><div className="eyebrow">{item.company}</div><strong>{item.role}</strong><p>{item.provider || item.assessmentType || "Online assessment"}</p></div>
            <div className="progressionMeta"><span><small>Deadline</small>{dateTime(item.deadlineAt)}</span><span><small>Status</small>{item.status.replaceAll("_", " ")}</span><span><small>Prep</small>{item.preparationStatus.replaceAll("_", " ")}</span></div>
          </a>
        )) : <div className="emptyState">No active assessment records.</div>}
      </section>

      <section className="card progressionListCard">
        <div className="cardHeader"><div><h2>Interviews</h2><p>Interview preparation uses the exact submitted application context when available.</p></div></div>
        {progression.interviews.length ? progression.interviews.map((item) => (
          <a className="progressionRow" href={`/interviews/${item.id}`} key={item.id}>
            <div><div className="eyebrow">{item.company}</div><strong>{item.role}</strong><p>{[item.roundLabel, item.interviewType].filter(Boolean).join(" · ") || "Interview"}</p></div>
            <div className="progressionMeta"><span><small>Scheduled</small>{dateTime(item.scheduledAt)}</span><span><small>Status</small>{item.status.replaceAll("_", " ")}</span><span><small>Prep</small>{item.preparationStatus.replaceAll("_", " ")}</span></div>
          </a>
        )) : <div className="emptyState">No interviews scheduled yet.</div>}
      </section>
    </AppShell>
  );
}
