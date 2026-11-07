import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getApplicationContentPackage, getApplicationCvDocument, getApplicationEmailActivity, getApplicationReviewPackage, getCandidateProfile, getPreparationApplicationById, getJobById } from "@/lib/data/repository";
import { ApplicationDocumentGenerator } from "@/components/application-document-generator";
import { ApplicationCreateButton } from "@/components/application-create-button";
import { ReviewCenter } from "@/components/review-center";
import { FormAgentPanel } from "@/components/form-agent-panel";
import { DEFAULT_DOCUMENT_TEMPLATE, isDocumentTemplateId } from "@/lib/document/templates";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";

function human(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()) : "—";
}

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [application, profile, cvDocument, contentPackage, emailActivity] = await Promise.all([getPreparationApplicationById(id), getCandidateProfile(), getApplicationCvDocument(id), getApplicationContentPackage(id), getApplicationEmailActivity(id)]);
  if (!application) return notFound();
  const linkedJob = application.chosenToApplyAt ? null : await getJobById(application.jobId);
  const review = await getApplicationReviewPackage(id);
  let defaultTemplateId = DEFAULT_DOCUMENT_TEMPLATE;
  let initialDocumentRequestId: string | null = null;
  if (isSupabaseConfigured() && getDataMode() !== "local") {
    try {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      const [{ data: preference }, { data: requests }] = await Promise.all([
        supabase.from("document_preferences").select("default_template_id").maybeSingle(),
        supabase.from("document_generation_requests").select("id").eq("application_id", id).neq("state", "cancelled").order("created_at", { ascending: false }).limit(1),
      ]);
      if (isDocumentTemplateId(preference?.default_template_id)) defaultTemplateId = preference.default_template_id;
      if (typeof requests?.[0]?.id === "string") initialDocumentRequestId = requests[0].id;
    } catch (error) {
      console.warn("Application document preferences could not be loaded.", error);
    }
  }
  const selectedCvVersion = cvDocument?.versions.find((version) => version.id === review.cvVersionId) || null;
  const selectedCoverVersion = contentPackage.coverLetter?.versions.find((version) => version.id === review.coverLetterVersionId) || null;

  const evidenceById = new Map<string, any>();
  for (const item of profile.evidence) {
    if (item.id) evidenceById.set(item.id, item);
    evidenceById.set(item.evidenceKey, item);
  }
  const evidence = application.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)).filter(Boolean);

  return (
    <AppShell>
      <div className="pageHeader">
        <div>
          <div className="eyebrow">{application.company}</div>
          <h1 className="title">{application.role}</h1>
          <p className="sub">Application preparation · {human(application.origin)} · {human(application.state)}</p>
        </div>
        <div className="headerActions">
          {!application.chosenToApplyAt ? <ApplicationCreateButton
            jobId={application.jobId}
            existingApplicationId={application.id}
            existingApplicationChosenAt={null}
            actionLabel="Choose to apply"
            disabledReason={linkedJob?.archivedAt ? "Restore this vacancy before choosing to apply." : null}
          /> : null}
          <a className="textLink" href={`/jobs/${application.jobId}`}>View job</a>
          <a className="textLink" href="/applications">← Applications</a>
        </div>
      </div>

      <section className="scoreHero applicationScoreHero">
        <div className="scoreBox"><small>Fit</small><strong>{application.fitScore == null ? "—" : Math.round(application.fitScore)}</strong><span>{application.fitScore == null ? "" : "/100"}</span></div>
        <div className="scoreBox"><small>Priority</small><strong>{application.priorityScore == null ? "—" : Math.round(application.priorityScore)}</strong><span>{application.priorityScore == null ? "" : "/100"}</span></div>
        <div className="decisionBox">
          <span className="badge review">{application.progress.percent}% prepared</span>
          <strong>{human(application.selectedCvFamily)} CV</strong>
          <small>{application.progress.completed} of {application.progress.total} preparation steps complete</small>
        </div>
      </section>

      {application.origin === "auto_prepare" ? (
        <div className={application.chosenToApplyAt ? "notice" : "notice warningNotice"}>
          {application.chosenToApplyAt
            ? "This legacy Auto-prepare record and its origin are preserved. You chose to apply explicitly; that choice did not create documents or start an employer form."
            : "This legacy Auto-prepare record and its origin are preserved. Choose to apply before this record can proceed; no documents or employer form will start automatically."}
        </div>
      ) : null}

      <section className="card strategyCard">
        <div className="cardHeader"><div><h2>Locked application strategy</h2><p>This is the common basis for the CV, cover letter, screening answers and later interview preparation.</p></div></div>
        <p>{application.strategyText || "Strategy has not been generated."}</p>
        <div className="badges">
          <span className="badge">CV: {human(application.selectedCvFamily)}</span>
          <span className="badge">State: {human(application.state)}</span>
          <span className="badge">Origin: {human(application.origin)}</span>
        </div>
      </section>

      <section className="card preparationCard">
        <div className="cardHeader"><div><h2>Preparation tasks</h2><p>These task rows preserve progress and history. Choosing to apply does not request documents or start employer-form work; each later action remains explicit.</p></div></div>
        <div className="taskList">
          {application.tasks.filter((task) => !["prepare_cv", "prepare_cover_letter"].includes(task.taskType)).map((task) => {
            const executionMode = String(task.input?.executionMode || task.input?.execution_mode || "");
            return (
              <div className="taskRow" key={task.id || task.taskType}>
                <span className={`taskState task-${task.state}`}>{task.state === "completed" ? "✓" : task.state === "failed" ? "!" : "○"}</span>
                <div>
                  <strong>{task.label}</strong>
                  <p>{task.state === "completed" ? "Completed" : task.state === "needs_user" ? "Waiting for a separate explicit request" : executionMode === "chatgpt_plus_handoff" ? "Not requested" : human(task.state)}</p>
                </div>
                <span className={`badge ${task.state === "completed" ? "review" : task.state === "needs_user" ? "action" : task.state === "failed" ? "danger" : "muted"}`}>{human(task.state)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <ApplicationDocumentGenerator
        applicationId={application.id}
        company={application.company}
        role={application.role}
        defaultTemplateId={defaultTemplateId}
        initialRequestId={initialDocumentRequestId}
        canGenerate={Boolean(application.chosenToApplyAt) && ["preparing", "ready_for_review", "revision_requested"].includes(application.state) && profile.source === "supabase"}
      />

      <section className="profileGrid jobAnalysisGrid">
        <div className="card">
          <div className="cardHeader"><div><h2>Frozen context</h2><p>Prevents a later advert or analysis change from silently changing what this application was based on.</p></div></div>
          <div className="factsList">
            <div className="factRow"><div><span>Job snapshot</span><strong className="monoKey">{application.jobSnapshotId || "Local snapshot"}</strong></div></div>
            <div className="factRow"><div><span>Job analysis</span><strong className="monoKey">{application.jobAnalysisId || "Local analysis"}</strong></div></div>
            <div className="factRow"><div><span>Next action</span><strong>{application.nextAction || "Continue preparation"}</strong></div></div>
          </div>
        </div>
        <div className="card">
          <div className="cardHeader"><div><h2>Evidence selected</h2><p>Only evidence-backed claims may flow into generated application documents.</p></div></div>
          <div className="analysisList">
            {evidence.length ? evidence.slice(0, 8).map((item: any) => <div key={item.evidenceKey}><strong>{item.claim}</strong><span>{item.evidenceKey} · {item.category}</span></div>) : <div className="emptyState">Evidence IDs are locked in the strategy, but the local profile does not expose matching database UUIDs yet.</div>}
          </div>
        </div>
      </section>

      <section className="card cvReviewCard">
        <div className="cardHeader"><div><h2>Saved CV versions</h2><p>Previously saved versions remain available here. New custom drafts are created only when you request them above.</p></div>{application.state === "content_approved" ? <span className="badge review">Gate 1 approved</span> : null}</div>
        {cvDocument?.versions?.length ? (
          <div className="versionList">
            {cvDocument.versions.map((version) => (
              <article className="versionRow" key={version.id}>
                <div>
                  <strong>Version {version.versionNumber}</strong>
                  <p>{version.engine || "Unknown engine"} · {version.approvalStatus.replaceAll("_", " ")} · {version.evidenceLinks.length} evidence links</p>
                </div>
                <div className="badges">
                  <span className={`badge ${version.unsupportedClaimsCount === 0 ? "review" : "danger"}`}>{version.unsupportedClaimsCount} unsupported claims</span>
                  {version.renderedObjectKey ? <a className="textLink" href={`/api/documents/${version.id}/download`} target="_blank">Open PDF</a> : <span className="badge action">PDF missing</span>}
                </div>
                {version.changeSummary?.length ? <div className="changeSummary">{version.changeSummary.slice(0, 5).map((change, i) => <div key={`${version.id}-${i}`}><span className="badge muted">{change.change_type}</span><strong>{change.area}</strong><p>{change.reason}</p></div>)}</div> : null}
              </article>
            ))}
          </div>
        ) : <div className="emptyState">No CV version has been saved yet. Choose Tailored CV above when you are ready.</div>}
      </section>


      <section className="card contentPackageCard">
        <div className="cardHeader"><div><h2>Prepared answers and salary</h2><p>Review answers and salary context before using them in an application.</p></div>{application.state === "content_approved" ? <span className="badge review">Gate 1 approved</span> : null}</div>
        <div className="profileGrid jobAnalysisGrid">
          <div>
            <h3>Salary context</h3>
            {contentPackage.salary ? (
              <div className="salaryPanel">
                <div className="badges"><span className="badge action">Amber · review</span><span className="badge">{contentPackage.salary.confidence} confidence</span></div>
                <strong>{contentPackage.salary.source === "advertised" ? "Advertised" : "Estimated"}: {contentPackage.salary.currency === "GBP" ? "£" : `${contentPackage.salary.currency} `}{contentPackage.salary.estimatedLow?.toLocaleString("en-GB") || "?"} - {contentPackage.salary.currency === "GBP" ? "£" : ""}{contentPackage.salary.estimatedHigh?.toLocaleString("en-GB") || "?"}</strong>
                <p>Suggested base expectation: {contentPackage.salary.currency === "GBP" ? "£" : `${contentPackage.salary.currency} `}{contentPackage.salary.recommendedValue?.toLocaleString("en-GB") || "Needs review"}</p>
                <small>{contentPackage.salary.basis.join(" · ")}</small>
              </div>
            ) : <div className="emptyState">Salary context has not been prepared yet.</div>}
          </div>
          <div>
            <h3>Earlier cover-letter version</h3>
            {contentPackage.coverLetter?.versions?.length ? (() => {
              const version = contentPackage.coverLetter!.versions[0];
              return <div className="salaryPanel"><div className="badges"><span className="badge action">Needs review</span><span className="badge">{version.evidenceLinks.length} evidence links</span></div><strong>Version {version.versionNumber}</strong><p>Earlier saved draft. New custom letters are created only when you request one above.</p>{version.renderedObjectKey ? <a className="textLink" href={`/api/documents/${version.id}/download`} target="_blank">Open PDF</a> : null}</div>;
            })() : <div className="emptyState">No earlier letter version. Request a custom letter above when you want one.</div>}
          </div>
        </div>
        <div className="screeningTable">
          <div className="screeningHeader"><strong>Screening question</strong><strong>Prepared answer</strong><strong>Trust</strong></div>
          {contentPackage.answers.length ? contentPackage.answers.map((answer) => (
            <div className="screeningRow" key={answer.id || answer.questionKey || answer.questionText}>
              <div><strong>{answer.questionText}</strong><small>{answer.category || "general"}</small></div>
              <div>{answer.answerText || <em>Waiting for your answer</em>}<small>{answer.rationale}</small></div>
              <div><span className={`trustDot trust-${answer.colour}`}></span><strong>{answer.colour === "green" ? "Green · verified" : answer.colour === "amber" ? "Amber · review" : "Red · user only"}</strong></div>
            </div>
          )) : <div className="emptyState">No screening-answer package exists yet.</div>}
        </div>
        {contentPackage.unresolvedRequired > 0 ? <div className="notice">{contentPackage.unresolvedRequired} required answer{contentPackage.unresolvedRequired === 1 ? "" : "s"} remain user-only. The system has deliberately left them blank.</div> : null}
      </section>


      <section className="card">
        <div className="cardHeader"><div><h2>Recruiting email activity</h2><p>Gmail is read-only. High-confidence status events can update this application automatically; ambiguous messages stay visible for review.</p></div><span className="badge">{emailActivity.records.length} linked</span></div>
        <div className="taskList">
          {emailActivity.records.length ? emailActivity.records.slice(0, 12).map((email) => (
            <div className="taskRow" key={email.id}>
              <span className={`taskState ${email.needsUser ? "task-needs_user" : "task-completed"}`}>{email.needsUser ? "!" : "✓"}</span>
              <div>
                <strong>{email.subject || "Recruiting email"}</strong>
                <p>{email.sender || "Unknown sender"} · {email.classification ? human(email.classification) : "Unclassified"}{email.receivedAt ? ` · ${new Date(email.receivedAt).toLocaleDateString("en-GB")}` : ""}</p>
                {email.classificationReason ? <small>{email.classificationReason}</small> : null}
              </div>
              <div className="badges">
                {email.autoAppliedAt ? <span className="badge review">Pipeline updated</span> : null}
                {email.needsUser ? <span className="badge action">Needs you</span> : <span className="badge muted">Logged</span>}
              </div>
            </div>
          )) : <div className="emptyState">No Gmail messages are linked to this application yet.</div>}
        </div>
      </section>

      <FormAgentPanel applicationId={application.id} applicationState={application.state} />

      <ReviewCenter
        applicationId={application.id}
        applicationState={application.state}
        review={review}
        salary={contentPackage.salary}
        answers={contentPackage.answers}
        cvVersion={selectedCvVersion}
        coverVersion={selectedCoverVersion}
      />
    </AppShell>
  );
}
