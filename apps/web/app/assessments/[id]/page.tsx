import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ProgressionPrepareButton } from "@/components/progression-prepare-button";
import { CopyChatGptPrompt } from "@/components/copy-chatgpt-prompt";
import { AssessmentStatusButton } from "@/components/assessment-status-button";
import { getAssessmentWorkspaceById } from "@/lib/data/repository";

function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(value)) : "Not provided";
}
function human(value: string | null | undefined) { return value ? value.replaceAll("_", " ").replace(/^./, c => c.toUpperCase()) : "—"; }

export default async function AssessmentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const assessment = await getAssessmentWorkspaceById(id);
  if (!assessment) return notFound();
  const version = assessment.preparationVersions.find((v) => v.id === assessment.currentPreparationVersionId) || assessment.preparationVersions[0] || null;
  const prep: any = version?.preparationPackage || null;
  return (
    <AppShell>
      <div className="pageHeader">
        <div><div className="eyebrow">{assessment.company}</div><h1 className="title">{assessment.role}</h1><p className="sub">Assessment preparation · {assessment.provider || human(assessment.assessmentType)}</p></div>
        <div className="headerActions"><a className="textLink" href="/assessments">← Assessments</a><ProgressionPrepareButton kind="assessment" workflowId={assessment.id} hasPreparation={Boolean(version)} /></div>
      </div>
      <section className="scoreHero progressionHero">
        <div className="scoreBox"><small>Deadline</small><strong className="deadlineHero">{assessment.deadlineAt ? new Intl.DateTimeFormat("en-GB", { day:"numeric", month:"short", timeZone:"Europe/London" }).format(new Date(assessment.deadlineAt)) : "—"}</strong></div>
        <div className="scoreBox"><small>Provider</small><strong className="textHero">{assessment.provider || "—"}</strong></div>
        <div className="decisionBox"><span className={`badge ${assessment.preparationStatus === "prepared" ? "review" : "action"}`}>{human(assessment.preparationStatus)}</span><strong>{human(assessment.status)}</strong><small>{dateTime(assessment.deadlineAt)}</small></div>
      </section>

      <div className="notice actionNotice"><strong>Preparation boundary:</strong> this workspace is for practice before you open the live assessment. Do not paste, interpret or solve live assessment questions here. Follow the employer/provider instructions during the real assessment.</div>

      <section className="profileGrid jobAnalysisGrid">
        <div className="card"><div className="cardHeader"><div><h2>Invitation facts</h2><p>Stored separately from generated preparation.</p></div></div><div className="factsList">
          <div className="factRow"><div><span>Invited</span><strong>{dateTime(assessment.invitedAt)}</strong></div></div>
          <div className="factRow"><div><span>Deadline</span><strong>{dateTime(assessment.deadlineAt)}</strong></div></div>
          <div className="factRow"><div><span>Estimated duration</span><strong>{assessment.estimatedMinutes ? `${assessment.estimatedMinutes} minutes` : "Not stated"}</strong></div></div>
          <div className="factRow"><div><span>Notes</span><strong>{assessment.notes || "No additional instructions stored."}</strong></div></div>
        </div></div>
        <div className="card"><div className="cardHeader"><div><h2>Context integrity</h2><p>The prep version records exactly what application material it used.</p></div></div><div className="factsList">
          <div className="factRow"><div><span>Context quality</span><strong>{version ? human(version.contextQuality) : "Not prepared"}</strong></div></div>
          <div className="factRow"><div><span>Preparation version</span><strong>{version ? `Version ${version.versionNumber}` : "None"}</strong></div></div>
          <div className="factRow"><div><span>Generator</span><strong>{version?.generator || "—"}</strong></div></div>
        </div></div>
      </section>

      {prep ? <>
        <section className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>Before you start</h2><p>Employer/provider rules plus practical setup checks.</p></div></div><div className="prepColumns"><div><h3>Rules</h3><ul>{(prep.rules || []).map((x: string) => <li key={x}>{x}</li>)}</ul></div><div><h3>Checklist</h3><ul>{(prep.checklist || []).map((x: string) => <li key={x}>{x}</li>)}</ul></div></div></section>
        <section className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>Likely components & synthetic practice</h2><p>These are preparation hypotheses, not claims about the live assessment content.</p></div></div><div className="moduleGrid">{(prep.likely_components || []).map((module: any) => <div className="moduleCard" key={module.key}><strong>{module.label}</strong><p>{module.focus}</p><small>{prep.practice_plan?.find((p:any)=>p.module===module.key)?.suggested_minutes || 20} min suggested practice</small></div>)}</div></section>
        <section className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>ChatGPT handoff</h2><p>Use your Plus session for deeper synthetic practice without adding API cost.</p></div><CopyChatGptPrompt prompt={prep.chatgpt_handoff?.prompt || ""} /></div><div className="promptBox">{prep.chatgpt_handoff?.prompt}</div></section>
      </> : <div className="card emptyState">Prepare the workspace to create a versioned practice plan and ChatGPT handoff packet.</div>}

      <section className="card progressionActionCard"><div><strong>Assessment status</strong><p>Updating this does not open or interact with the assessment provider.</p></div><div className="buttonRow">{assessment.status === "pending" ? <AssessmentStatusButton assessmentId={assessment.id} status="in_progress" /> : null}{assessment.status !== "completed" ? <AssessmentStatusButton assessmentId={assessment.id} status="completed" /> : <span className="badge review">Completed</span>}</div></section>
    </AppShell>
  );
}
