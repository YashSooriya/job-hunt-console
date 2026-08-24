import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ProgressionPrepareButton } from "@/components/progression-prepare-button";
import { CopyChatGptPrompt } from "@/components/copy-chatgpt-prompt";
import { getInterviewWorkspaceById } from "@/lib/data/repository";

function dateTime(value: string | null) { return value ? new Intl.DateTimeFormat("en-GB", { day:"numeric", month:"long", year:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"Europe/London" }).format(new Date(value)) : "Not scheduled"; }
function human(value: string | null | undefined) { return value ? value.replaceAll("_", " ").replace(/^./, c => c.toUpperCase()) : "—"; }

export default async function InterviewDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const interview = await getInterviewWorkspaceById(id);
  if (!interview) return notFound();
  const version = interview.preparationVersions.find((v) => v.id === interview.currentPreparationVersionId) || interview.preparationVersions[0] || null;
  const prep: any = version?.preparationPackage || null;
  return <AppShell>
    <div className="pageHeader"><div><div className="eyebrow">{interview.company}</div><h1 className="title">{interview.role}</h1><p className="sub">{interview.roundLabel || "Interview"} · {human(interview.interviewType)}</p></div><div className="headerActions"><a className="textLink" href="/assessments">← Assessments</a><ProgressionPrepareButton kind="interview" workflowId={interview.id} hasPreparation={Boolean(version)} /></div></div>
    <section className="scoreHero progressionHero"><div className="scoreBox"><small>Scheduled</small><strong className="deadlineHero">{interview.scheduledAt ? new Intl.DateTimeFormat("en-GB", { day:"numeric",month:"short",timeZone:"Europe/London" }).format(new Date(interview.scheduledAt)) : "—"}</strong></div><div className="scoreBox"><small>Round</small><strong className="textHero">{interview.roundLabel || "—"}</strong></div><div className="decisionBox"><span className={`badge ${interview.preparationStatus === "prepared" ? "review" : "action"}`}>{human(interview.preparationStatus)}</span><strong>{human(interview.status)}</strong><small>{dateTime(interview.scheduledAt)}</small></div></section>
    {prep ? <>
      <section className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>Exact application recap</h2><p>What the interviewer may have in front of them.</p></div><span className="badge">{human(version?.contextQuality)}</span></div><div className="factsList"><div className="factRow"><div><span>CV version</span><strong>{prep.submitted_recap?.cv_version_id || "Historical / unavailable"}</strong></div></div><div className="factRow"><div><span>Cover letter version</span><strong>{prep.submitted_recap?.cover_letter_version_id || "Not available"}</strong></div></div><div className="factRow"><div><span>Salary expectation</span><strong>{prep.submitted_recap?.salary_expectation ? `£${Number(prep.submitted_recap.salary_expectation).toLocaleString("en-GB")}` : "Not recorded"}</strong></div></div></div></section>
      <section className="profileGrid jobAnalysisGrid"><div className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>Strongest evidence</h2></div></div><div className="analysisList">{(prep.strongest_evidence || []).map((x:any)=><div key={x.evidenceId}><strong>{x.headline}</strong><span>{x.prompt}</span></div>)}</div></div><div className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>Weak areas to handle cleanly</h2></div></div><div className="analysisList">{(prep.weak_areas || []).length ? prep.weak_areas.map((x:string)=><div key={x}><strong>{x}</strong></div>) : <div className="emptyState">No explicit weak areas recorded.</div>}</div></div></section>
      <section className="profileGrid jobAnalysisGrid"><div className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>Likely questions</h2></div></div><ol className="questionList">{(prep.likely_questions || []).map((q:string)=><li key={q}>{q}</li>)}</ol></div><div className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>Questions to ask</h2></div></div><ol className="questionList">{(prep.questions_to_ask || []).map((q:string)=><li key={q}>{q}</li>)}</ol></div></section>
      <section className="card prepWorkspaceCard"><div className="cardHeader"><div><h2>ChatGPT interview practice</h2><p>The handoff keeps the mock interview consistent with the submitted application.</p></div><CopyChatGptPrompt prompt={prep.chatgpt_handoff?.prompt || ""} /></div><div className="promptBox">{prep.chatgpt_handoff?.prompt}</div></section>
    </> : <div className="card emptyState">Prepare the interview workspace to create a context-locked practice package.</div>}
  </AppShell>;
}
