import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ApplicationCreateButton } from "@/components/application-create-button";
import { JobDetailControls } from "@/components/job-detail-controls";
import { JobUrlInspectionForm } from "@/components/job-url-inspection-form";
import { getApplicationForJob, getCandidateProfile, getJobById } from "@/lib/data/repository";
import type { EvidenceItem } from "@/lib/types";

const labels: Record<string, string> = {
  technical: "Technical capability",
  evidence: "Evidence strength",
  seniority: "Seniority",
  domain: "Domain",
  role_type: "Role type",
  qualification: "Qualifications",
  compensation: "Compensation",
  freshness: "Posting freshness",
  effort: "Application effort",
  urgency: "Closing urgency",
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

function fitLabel(value: number | null) {
  const score = Math.max(0, Math.min(100, Number(value)));
  return (score / 10).toFixed(1);
}

export default async function JobDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sort?: string; direction?: string; edit?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [job, profile, existingApplication] = await Promise.all([getJobById(id), getCandidateProfile(), getApplicationForJob(id)]);
  if (!job) notFound();
  const analysis = job.analysis;
  const evidenceById = new Map<string, EvidenceItem>();
  const sourceLabelById = new Map<string, string>();
  for (const item of profile.evidence) {
    if (item.id) evidenceById.set(item.id, item);
    evidenceById.set(item.evidenceKey, item);
  }
  for (const item of profile.structured.employment) if (typeof item.id === "string") sourceLabelById.set(item.id, `${item.role_title || "Role"} · ${item.employer || "Employer"}`);
  for (const item of profile.structured.education) if (typeof item.id === "string") sourceLabelById.set(item.id, `${item.qualification || "Qualification"} · ${item.institution || "Institution"}`);
  for (const item of profile.structured.skills) if (typeof item.id === "string") sourceLabelById.set(item.id, String(item.name || "Verified skill"));
  for (const item of profile.structured.projects) if (typeof item.id === "string") sourceLabelById.set(item.id, String(item.title || "Verified project"));
  for (const item of profile.structured.publications) if (typeof item.id === "string") sourceLabelById.set(item.id, String(item.title || "Verified publication"));
  for (const item of profile.facts) if (typeof item.id === "string") sourceLabelById.set(item.id, `Verified fact: ${item.factKey.replaceAll("_", " ")}`);
  const evidenceLabel = (reference: string) => {
    const evidenceId = reference.includes(":") ? reference.slice(reference.indexOf(":") + 1) : reference;
    const evidence = evidenceById.get(evidenceId) || evidenceById.get(reference);
    if (evidence) return `${evidence.evidenceKey}: ${evidence.claim}`;
    return sourceLabelById.get(evidenceId) || reference;
  };
  const analysisIsCurrent = job.analysisStatus !== "pending" && job.analysisStatus !== "outdated";
  const analysisBlocked = job.analysisStatus === "pending"
    ? "JobHuntAI fit analysis is pending. Analyse this listing before preparing an application."
    : job.analysisStatus === "outdated"
      ? "JobHuntAI fit analysis is outdated. Refresh it against your current profile before preparing an application."
      : analysis?.eligibility === "ineligible"
        ? "This job is marked ineligible for application preparation."
        : null;

  return (
    <AppShell>
      <div className="pageHeader jobDetailHeader">
        <div>
          <div className="eyebrow">{job.company}</div>
          <h1 className="title">{job.title}</h1>
          <p className="sub">{job.location || "Location not supplied"}{job.industry ? ` · ${job.industry}` : ""}{job.salaryText ? ` · ${job.salaryText}` : " · Salary not advertised"}</p>
        </div>
        <div className="headerActions">
          <ApplicationCreateButton
            jobId={job.id}
            existingApplicationId={existingApplication?.id || null}
            disabledReason={job.archivedAt ? "Restore this vacancy before preparing an application." : analysisBlocked}
          />
          {analysis?.triage === "reject" && !analysisBlocked ? <small className="manualApplicationHint">Low fit is guidance; you can still choose to apply.</small> : null}
          <a className="textLink" href={`/jobs?sort=${encodeURIComponent(query.sort || "discovered")}&direction=${query.direction === "asc" ? "asc" : "desc"}`}>← Job inbox</a>
        </div>
      </div>

      <JobDetailControls job={job} initialEditing={query.edit === "1"} />

      {analysis && !analysisIsCurrent ? <div className="warningNotice jobOutdatedAnalysisNotice" role="status">This is an older fit assessment and should not be used for a new application. Refresh it against your current profile to see an up-to-date result.</div> : null}
      {analysis ? <>
        <section className="scoreHero">
          <div className="scoreBox"><small>Fit</small><strong>{analysis.fitScore === null ? "—" : fitLabel(analysis.fitScore)}</strong><span>{analysis.fitScore === null ? "Incomplete" : "/10"}</span></div>
          <div className="scoreBox"><small>Priority</small><strong>{analysis.priorityScore === null ? "—" : Math.round(analysis.priorityScore)}</strong><span>{analysis.priorityScore === null ? "Incomplete" : "/100"}</span></div>
          <div className="decisionBox">
            <span className={`badge ${analysisIsCurrent ? `triage-${analysis.triage}` : "warningBadge"}`}>{analysisIsCurrent ? human(analysis.triage) : "Outdated analysis"}</span>
            <strong>{analysis.triageReason}</strong>
            <small>{human(analysis.recommendedCvFamily)} CV · {human(analysis.eligibility)}</small>
            {analysis.assessmentCompleteness === "partial" ? <small>Partial evidence — inspect the requirement-by-requirement results below.</small> : null}
          </div>
        </section>

        <section className="profileGrid jobAnalysisGrid">
          <div className="card">
            <div className="cardHeader"><div><h2>Fit components</h2><p>Suitability independent of posting urgency</p></div></div>
            <div className="scoreList">{Object.entries(analysis.fitComponents).map(([key, value]) => { const score = typeof value === "number" ? Math.max(0, Math.min(100, value)) : null; return <div className="scoreLine" key={key}><span>{labels[key] || human(key)}</span><div><i style={{ width: `${score ?? 0}%` }} /><b>{score === null ? "—" : Math.round(score)}</b></div></div>; })}</div>
          </div>
          <div className="card">
            <div className="cardHeader"><div><h2>Priority components</h2><p>How quickly this application deserves effort</p></div></div>
            <div className="scoreList">{Object.entries(analysis.priorityComponents).map(([key, value]) => { const score = typeof value === "number" ? Math.max(0, Math.min(100, value)) : null; return <div className="scoreLine" key={key}><span>{labels[key] || human(key)}</span><div><i style={{ width: `${score ?? 0}%` }} /><b>{score === null ? "—" : Math.round(score)}</b></div></div>; })}</div>
          </div>
        </section>

        <section className="card strategyCard">
          <div className="cardHeader"><div><h2>Application strategy</h2><p>Common positioning basis for CV, letter, questions and later interview preparation</p></div></div>
          <p>{analysis.applicationStrategy}</p>
          {analysis.assessmentLimitations?.length ? <div className="analysisList"><strong>Assessment limitations</strong>{analysis.assessmentLimitations.map((item, index) => <span key={index}>{item}</span>)}</div> : null}
          <div className="badges"><span className="badge">CV: {human(analysis.recommendedCvFamily)}</span><span className="badge">Cover letter value: {human(analysis.coverLetterValue)}</span><span className="badge">Analysis: {human(analysis.analysisSource)}</span></div>
        </section>

        <section className="card requirementsCard">
          <div className="cardHeader"><div><h2>Requirements and evidence</h2><p>Every match is grounded in the candidate evidence library</p></div></div>
          <div className="tableWrap"><table className="dataTable"><thead><tr><th>Requirement</th><th>Type</th><th>Match</th><th>Evidence</th></tr></thead><tbody>
            {job.requirements.map((req, index) => <tr key={`${index}-${req.text.slice(0, 30)}`}><td className="requirementText">{req.text}</td><td><span className="badge">{human(req.type)}</span></td><td><strong>{req.matchLabel || (req.matchScore === null ? "Not scored" : `${req.matchScore}%`)}</strong>{req.matchExplanation ? <small className="formHint">{req.matchExplanation}</small> : null}</td><td>{req.evidenceQuotes?.length ? <div className="evidenceRefs">{req.evidenceQuotes.map((item, evidenceIndex) => <span className="evidenceRef" key={`${item.reference}:${evidenceIndex}`}>“{item.quote}”<small>{evidenceLabel(item.reference)}</small></span>)}</div> : req.evidenceIds.length ? <div className="evidenceRefs">{req.evidenceIds.map((evidenceId) => <span className="evidenceRef" key={evidenceId}>{evidenceLabel(evidenceId)}</span>)}</div> : <span className="badge danger">Gap</span>}</td></tr>)}
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

      {job.listingSummary || job.salarySource === "chatgpt_estimate" || (job.responsibilities?.length ?? 0) > 0 ? <section className="card listingExtractionCard">
        <div className="cardHeader"><div><h2>ChatGPT listing extraction</h2><p>Structured facts read from the public advert and kept with the frozen vacancy snapshot</p></div><div className="badges"><span className="badge review">{job.listingExtractionSource === "chatgpt_url" || job.listingExtractionSource === "chatgpt_direct" ? "Read from listing URL" : "Structured extraction"}</span>{job.listingExtractedAt ? <span className="badge muted">{new Date(job.listingExtractedAt).toLocaleDateString("en-GB")}</span> : null}</div></div>
        <div className="listingExtractionBody">
          {job.listingSummary ? <p className="listingSummary">{job.listingSummary}</p> : null}
          <div className="listingMetaGrid">
            <div><small>Salary</small><strong>{job.salaryText || "Not available"}</strong>{job.salarySource === "chatgpt_estimate" ? <span className="extractionNote">ChatGPT estimate{job.salaryConfidence ? ` · ${job.salaryConfidence} confidence` : ""}</span> : <span className="extractionNote">{job.salarySource === "advertised" ? "Advertised by employer" : "No salary supplied"}</span>}</div>
            <div><small>Salary basis</small><strong>{job.salaryBasis?.length ? job.salaryBasis.join(" · ") : "—"}</strong></div>
            <div><small>Employment</small><strong>{job.employmentType || "Not supplied"}</strong></div>
            <div><small>Work arrangement</small><strong>{job.workMode || "Not supplied"}</strong></div>
          </div>
          <div className="listingExtractionColumns">
            {job.responsibilities?.length ? <div><h3>Responsibilities</h3><ul>{job.responsibilities.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
            {job.extractedRequirements?.length || job.desirableRequirements?.length ? <div><h3>Requirements</h3><ul>{[...(job.extractedRequirements || []), ...(job.desirableRequirements || []).map((item) => `Desirable: ${item}`)].map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
            {job.skills?.length || job.benefits?.length ? <div><h3>Skills and benefits</h3><ul>{[...(job.skills || []).map((item) => `Skill: ${item}`), ...(job.benefits || []).map((item) => `Benefit: ${item}`)].map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
          </div>
          {job.applicationInstructions ? <div className="extractionInstructions"><h3>Application instructions</h3><p>{job.applicationInstructions}</p></div> : null}
        </div>
      </section> : null}

      <section className="card advertCard">
        <div className="cardHeader"><div><h2>Preserved vacancy snapshot</h2><p>The original text remains available even if the employer removes the advert{job.snapshotCapturedAt ? ` · captured ${new Date(job.snapshotCapturedAt).toLocaleDateString("en-GB")}` : ""}</p></div>{job.sourceUrl ? <a className="textLink" href={job.sourceUrl} rel="noreferrer" target="_blank">Original listing</a> : null}</div>
        <pre>{job.description}</pre>
      </section>

      {job.sourceUrl ? <details className="card jobRefreshCard">
        <summary>Refresh this listing from its public page</summary>
        <p>Send the saved public URL through the existing ChatGPT listing-inspection flow. The extracted fields can update this vacancy using the same duplicate checks as a normal import.</p>
        <JobUrlInspectionForm initialSourceUrl={job.sourceUrl} />
      </details> : <div className="notice">Add a public listing URL in Edit vacancy to enable a ChatGPT refresh.</div>}
    </AppShell>
  );
}
