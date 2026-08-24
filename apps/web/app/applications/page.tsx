import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { getPreparationApplications, getTrackerDataset } from "@/lib/data/repository";
import { PreparationAutomationPanel } from "@/components/preparation-automation-panel";

const progressedStates = new Set(["assessment", "interview", "offer"]);
function human(value: string | null | undefined) { return value ? value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()) : "—"; }

export default async function ApplicationsPage() {
  const [preparation, tracker] = await Promise.all([getPreparationApplications(), getTrackerDataset()]);
  const active = tracker.records.filter((item) => !["rejected", "withdrawn", "expired"].includes(item.applicationState)).length;
  const progressed = tracker.records.filter((item) => progressedStates.has(item.applicationState)).length;

  return (
    <AppShell>
      <div className="pageHeader">
        <div>
          <div className="eyebrow">Milestone 4 · application creation</div>
          <h1 className="title">Applications</h1>
          <p className="sub">New applications are created from analysed Jobs, freeze their vacancy/analysis context, lock a strategy and queue preparation work before anything can reach an employer form.</p>
        </div>
        <DataSourceBadge source={preparation.source} />
      </div>

      <section className="metrics compactMetrics">
        <div className="metric"><span>Preparing</span><strong>{preparation.summary.preparing}</strong></div>
        <div className="metric"><span>Auto-prepared</span><strong>{preparation.summary.autoPrepared}</strong></div>
        <div className="metric"><span>Ready for review</span><strong>{preparation.summary.readyForReview}</strong></div>
        <div className="metric"><span>Historical tracked</span><strong>{tracker.summary.total}</strong></div>
      </section>

      <PreparationAutomationPanel />

      <section className="card tableCard preparationQueue">
        <div className="cardHeader"><div><h2>Preparation queue</h2><p>Job → Application is now a real persistent transition. Application content generation is the next milestone.</p></div></div>
        {preparation.records.length ? <div className="tableWrap"><table className="dataTable"><thead><tr><th>Company</th><th>Role</th><th>State</th><th>CV</th><th>Progress</th><th>Origin</th><th></th></tr></thead><tbody>
          {preparation.records.map((item) => <tr key={item.id}>
            <td><strong>{item.company}</strong></td>
            <td>{item.role}</td>
            <td><span className="badge review">{human(item.state)}</span></td>
            <td>{human(item.selectedCvFamily)}</td>
            <td><strong>{item.progress.percent}%</strong> <span className="mutedText">({item.progress.completed}/{item.progress.total})</span></td>
            <td><span className={`badge ${item.origin === "auto_prepare" ? "action" : "muted"}`}>{human(item.origin)}</span></td>
            <td><a className="textLink" href={`/applications/${item.id}`}>Open</a></td>
          </tr>)}
        </tbody></table></div> : <div className="emptyState">No new applications are being prepared yet. Open a recommended Job and choose Prepare application.</div>}
      </section>

      {tracker.quality.issueCount > 0 ? (
        <section className="card qualityCard">
          <div className="cardHeader"><div><h2>Historical import quality</h2><p>{tracker.quality.issueCount} source-data notes retained for review, {tracker.quality.errorCount} blocking errors</p></div></div>
          <div className="qualityList">{tracker.quality.issues.map((issue) => <div className="qualityItem" key={`${issue.sourceRow}-${issue.code}`}><span className={`badge ${issue.severity === "error" ? "danger" : issue.severity === "warning" ? "action" : "muted"}`}>{issue.severity}</span><div><strong>Tracker row {issue.sourceRow ?? "—"}</strong><p>{issue.message}</p></div></div>)}</div>
        </section>
      ) : null}

      <section className="card tableCard historyTable">
        <div className="cardHeader"><div><h2>Historical pipeline</h2><p>{active} active · {progressed} progressed · {tracker.summary.rejected} rejected</p></div></div>
        <div className="tableWrap"><table className="dataTable"><thead><tr><th>Applied</th><th>Company</th><th>Role</th><th>State</th><th>Priority</th><th>Next action</th><th>Deadline</th></tr></thead><tbody>
          {tracker.records.map((item) => <tr key={`${item.sourceRow}-${item.company}-${item.role}`}><td>{item.applicationDate || "—"}</td><td><strong>{item.company}</strong></td><td>{item.role}</td><td><span className={`badge ${item.applicationState === "assessment" ? "action" : item.applicationState === "rejected" ? "muted" : "review"}`}>{item.stage}</span></td><td>{item.priority}</td><td>{item.nextAction || "None"}</td><td>{item.deadline || "—"}</td></tr>)}
        </tbody></table></div>
      </section>
    </AppShell>
  );
}
