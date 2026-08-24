import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ApplicationCreateButton } from "@/components/application-create-button";
import { getApplicationForJob, getCandidateProfile, getJobById } from "@/lib/data/repository";
import type { EvidenceItem } from "@/lib/types";

const labels: Record<string, string> = {
  technical_capability: "Technical",
  evidence_strength: "Evidence",
  seniority_fit: "Seniority",
  domain_fit: "Domain",
  role_type_fit: "Role type",
  qualifications: "Qualifications",
  screening_probability: "Screening",
  compensation_value: "Compensation",
  geography: "Geography",
  posting_freshness: "Freshness",
  application_effort: "Low effort",
  closing_urgency: "Urgency",
};

function human(value: string) { return value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()); }

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job, profile, existingApplication] = await Promise.all([getJobById(id), getCandidateProfile(), getApplicationForJob(id)]);
  if (!job) notFound();
  const analysis = job.analysis;
  const evidenceById = new Map<string, EvidenceItem>();
  for (const item of profile.evidence) {
    if (item.id) evidenceById.set(item.id, item);
    evidenceById.set(item.evidenceKey, item);
  }
  const evidenceLabel = (evidenceId: string) => {
    const evidence = evidenceById.get(evidenceId);
    return evidence ? `${evidence.evidenceKey}: ${evidence.claim}` : evidenceId;
  };

  return (
    <AppShell>
      <div className="pageHeader jobDetailHeader">
        <div>
          <div className="eyebrow">{job.company}</div>
          <h1 className="title">{job.title}</h1>
          <p className="sub">{job.location || "Location not supplied"}{job.salaryText ? ` · ${job.salaryText}` : " · Salary not advertised"}</p>
        </div>
        <div className="headerActions">
          <ApplicationCreateButton
            jobId={job.id}
            existingApplicationId={existingApplication?.id || null}
            disabledReason={analysis?.triage === "reject" || analysis?.eligibility === "ineligible" ? "This job is not eligible for application preparation." : null}
          />
          <a className="textLink" href="/jobs">← Job inbox</a>
        </div>
      </div>

      {analysis ? <>
        <section className="scoreHero">
          <div className="scoreBox"><small>Fit</small><strong>{Math.round(analysis.fitScore)}</strong><span>/100</span></div>
          <div className="scoreBox"><small>Priority</small><strong>{Math.round(analysis.priorityScore)}</strong><span>/100</span></div>
          <div className="decisionBox">
            <span className={`badge triage-${analysis.triage}`}>{human(analysis.triage)}</span>
            <strong>{analysis.triageReason}</strong>
            <small>{human(analysis.recommendedCvFamily)} CV · {human(analysis.eligibility)}</small>
          </div>
        </section>

        <section className="profileGrid jobAnalysisGrid">
          <div className="card">
            <div className="cardHeader"><div><h2>Fit components</h2><p>Suitability independent of posting urgency</p></div></div>
            <div className="scoreList">{Object.entries(analysis.fitComponents).map(([key, value]) => <div className="scoreLine" key={key}><span>{labels[key] || human(key)}</span><div><i style={{ width: `${value}%` }} /><b>{Math.round(value)}</b></div></div>)}</div>
          </div>
          <div className="card">
            <div className="cardHeader"><div><h2>Priority components</h2><p>How quickly this application deserves effort</p></div></div>
            <div className="scoreList">{Object.entries(analysis.priorityComponents).map(([key, value]) => <div className="scoreLine" key={key}><span>{labels[key] || human(key)}</span><div><i style={{ width: `${value}%` }} /><b>{Math.round(value)}</b></div></div>)}</div>
          </div>
        </section>

        <section className="card strategyCard">
          <div className="cardHeader"><div><h2>Application strategy</h2><p>Common positioning basis for CV, letter, questions and later interview preparation</p></div></div>
          <p>{analysis.applicationStrategy}</p>
          <div className="badges"><span className="badge">CV: {human(analysis.recommendedCvFamily)}</span><span className="badge">Cover letter value: {human(analysis.coverLetterValue)}</span><span className="badge">Analysis: {human(analysis.analysisSource)}</span></div>
        </section>

        <section className="card requirementsCard">
          <div className="cardHeader"><div><h2>Requirements and evidence</h2><p>Every match is grounded in the candidate evidence library</p></div></div>
          <div className="tableWrap"><table className="dataTable"><thead><tr><th>Requirement</th><th>Type</th><th>Match</th><th>Evidence</th></tr></thead><tbody>
            {job.requirements.map((req, index) => <tr key={`${index}-${req.text.slice(0, 30)}`}><td className="requirementText">{req.text}</td><td><span className="badge">{human(req.type)}</span></td><td><strong>{req.matchScore}%</strong></td><td>{req.evidenceIds.length ? <div className="evidenceRefs">{req.evidenceIds.map((evidenceId) => <span className="evidenceRef" key={evidenceId}>{evidenceLabel(evidenceId)}</span>)}</div> : <span className="badge danger">Gap</span>}</td></tr>)}
          </tbody></table></div>
        </section>

        <section className="profileGrid jobAnalysisGrid">
          <div className="card">
            <div className="cardHeader"><div><h2>Strongest evidence</h2><p>Likely recruiter-facing strengths</p></div></div>
            <div className="analysisList">{analysis.strengths.length ? analysis.strengths.map((item, index) => <div key={index}><strong>{item.description}</strong><span>{item.evidenceIds.map(evidenceLabel).join(" · ")}</span></div>) : <div className="emptyState">No high-confidence evidence matches found.</div>}</div>
          </div>
          <div className="card">
            <div className="cardHeader"><div><h2>Concerns</h2><p>Never silently papered over</p></div></div>
            <div className="analysisList">{analysis.weaknesses.length ? analysis.weaknesses.map((item, index) => <div key={index}><strong>{item.description}</strong><span>{human(item.severity)} severity</span></div>) : <div className="emptyState">No material gaps identified in the first pass.</div>}</div>
          </div>
        </section>
      </> : <div className="notice">This vacancy has not been analysed yet.</div>}

      <section className="card advertCard">
        <div className="cardHeader"><div><h2>Preserved vacancy snapshot</h2><p>The original text remains available even if the employer removes the advert</p></div>{job.sourceUrl ? <a className="textLink" href={job.sourceUrl} rel="noreferrer" target="_blank">Original listing</a> : null}</div>
        <pre>{job.description}</pre>
      </section>
    </AppShell>
  );
}
