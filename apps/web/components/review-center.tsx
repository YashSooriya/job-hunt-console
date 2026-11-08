"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApplicationReviewPackage, ScreeningAnswerRecord, SalaryContextRecord } from "@/lib/types";

type Version = {
  id: string;
  versionNumber: number;
  approvalStatus: string;
  unsupportedClaimsCount: number;
  structuredContent: Record<string, any>;
} | null;

function memoryDraft(version: Version) {
  return version?.structuredContent?.source_mode === "chatgpt_memory" || version?.structuredContent?.memory_review_required === true;
}

export function ReviewCenter({
  applicationId,
  applicationState,
  review,
  salary,
  answers,
  cvVersion,
  coverVersion,
}: {
  applicationId: string;
  applicationState: string;
  review: ApplicationReviewPackage;
  salary: SalaryContextRecord | null;
  answers: ScreeningAnswerRecord[];
  cvVersion: Version;
  coverVersion: Version;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [salaryValue, setSalaryValue] = useState(String(salary?.recommendedValue ?? ""));
  const [answerValues, setAnswerValues] = useState<Record<string, string>>(
    Object.fromEntries(answers.map((answer) => [answer.id || answer.questionKey || answer.questionText, answer.answerText || ""])),
  );

  async function act(key: string, payload: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/review/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Review action failed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!review.assembledAt && applicationState !== "content_approved") {
    const revision = applicationState === "revision_requested";
    return (
      <section className="card gateCard" data-testid="application-review-centre">
        <div className="cardHeader"><div>
          <h2>{revision ? "Return revised content to review" : "Ready for Review"}</h2>
          <p>{revision
            ? "The previous Gate 1 approval was cleared. Assemble the current saved versions to begin a fresh review."
            : "The saved documents can be reviewed here. Legacy preparation-task history does not block this handoff."}</p>
        </div></div>
        <button className="primaryButton" disabled={Boolean(busy)} onClick={() => act("assemble", { action: "assemble" })}>
          {busy === "assemble" ? "Assembling…" : revision ? "Assemble revised package" : "Assemble review package"}
        </button>
        {error ? <p className="formError" role="alert">{error}</p> : null}
      </section>
    );
  }

  const isReviewing = applicationState === "ready_for_review" || applicationState === "revision_requested";
  const hasMemoryDraft = memoryDraft(cvVersion) || memoryDraft(coverVersion);
  const currencyPrefix = salary?.currency === "GBP" || !salary ? "£" : `${salary.currency} `;

  return (
    <section className="card reviewCentreCard" data-testid="application-review-centre">
      <div className="cardHeader"><div>
        <div className="eyebrow">Approval Gate 1</div>
        <h2>{applicationState === "content_approved" ? "Application content approved" : "Ready for Review"}</h2>
        <p>Review and approve the exact saved versions, answers and salary that will be carried to a later form stage.</p>
      </div><span className={`badge ${review.canApprove ? "review" : applicationState === "content_approved" ? "review" : "action"}`}>
        {applicationState === "content_approved" ? "Approved" : `${review.completed}/${review.total} checks complete`}
      </span></div>

      {hasMemoryDraft ? <div className="notice warningNotice" data-testid="memory-factual-review-notice">
        This draft uses ChatGPT Memory. Verify every factual claim against your records before accepting it. Accepting a version records your factual review of that exact saved version.
      </div> : null}

      <div className="reviewChecklist">
        {review.checklist.map((item) => <div className="reviewCheck" key={item.key}>
          <span className={item.complete ? "checkDone" : "checkOpen"}>{item.complete ? "✓" : "○"}</span><span>{item.label}</span>
        </div>)}
      </div>

      {isReviewing ? <>
        <div className="reviewSection">
          <h3>CV decision</h3>
          {cvVersion ? <div className="reviewActionRow">
            <div><strong>Selected CV · version {cvVersion.versionNumber}</strong>
              <p>{cvVersion.unsupportedClaimsCount} unsupported claims · {cvVersion.approvalStatus.replaceAll("_", " ")}{memoryDraft(cvVersion) ? " · Memory draft; factual review required" : ""}</p>
            </div>
            <div className="buttonRow">
              <button className="secondaryButton" disabled={Boolean(busy)} onClick={() => act("cv-reject", { action: "document", versionId: cvVersion.id, decision: "reject" })}>Request revision</button>
              <button className="primaryButton" disabled={Boolean(busy) || cvVersion.approvalStatus === "approved"}
                onClick={() => act("cv-approve", { action: "document", versionId: cvVersion.id, decision: "approve" })}>
                {cvVersion.approvalStatus === "approved" ? "Accepted" : memoryDraft(cvVersion) ? "Confirm facts & accept CV" : "Accept CV"}
              </button>
            </div>
          </div> : <div className="emptyState">No selected CV version.</div>}
        </div>

        <div className="reviewSection">
          <h3>Cover letter decision</h3>
          {review.coverLetterDecision === "not_required" ? <div className="notice successNotice">No cover letter is included in this package.</div> : <div className="reviewActionRow">
            <div><strong>{review.coverLetterDecision === "remove" ? "Cover letter removed from package" : `Selected cover letter · version ${coverVersion?.versionNumber || "?"}`}</strong>
              <p>{coverVersion ? `${coverVersion.approvalStatus.replaceAll("_", " ")}${memoryDraft(coverVersion) ? " · Memory draft; factual review required" : ""}` : "Not included"}</p>
            </div>
            <div className="buttonRow">
              <button className="secondaryButton" disabled={Boolean(busy)} onClick={() => act("cover-remove", { action: "cover_letter", decision: review.coverLetterDecision === "remove" ? "use" : "remove" })}>
                {review.coverLetterDecision === "remove" ? "Use letter" : "Remove letter"}
              </button>
              {review.coverLetterDecision === "use" && coverVersion ? <button className="primaryButton" disabled={Boolean(busy) || coverVersion.approvalStatus === "approved"}
                onClick={() => act("cover-approve", { action: "document", versionId: coverVersion.id, decision: "approve" })}>
                {coverVersion.approvalStatus === "approved" ? "Accepted" : memoryDraft(coverVersion) ? "Confirm facts & accept letter" : "Accept letter"}
              </button> : null}
            </div>
          </div>}
        </div>

        <div className="reviewSection">
          <h3>Salary expectation</h3>
          {salary ? <div className="salaryApproval">
            <label>Base annual salary expectation ({salary.currency})
              <input aria-label="Annual salary expectation" value={salaryValue} inputMode="numeric" onChange={(event) => setSalaryValue(event.target.value.replace(/[^0-9]/g, ""))} />
            </label>
            <button className="primaryButton" disabled={Boolean(busy) || !salaryValue} onClick={() => act("salary", { action: "salary", recommendedValue: Number(salaryValue) })}>
              {busy === "salary" ? "Saving…" : salary.approvedAt ? "Update & approve" : "Approve salary"}
            </button>
            {salary.approvedAt ? <span className="badge review">Approved · {currencyPrefix}{Number(salaryValue).toLocaleString("en-GB")}</span> : <span className="badge action">Needs approval</span>}
          </div> : <div className="salaryApproval">
            <label>Annual salary expectation (GBP)
              <input aria-label="Annual salary expectation" value={salaryValue} inputMode="numeric" placeholder="Enter an amount" onChange={(event) => setSalaryValue(event.target.value.replace(/[^0-9]/g, ""))} />
            </label>
            <button className="primaryButton" disabled={Boolean(busy) || !salaryValue} onClick={() => act("salary", { action: "salary", recommendedValue: Number(salaryValue) })}>
              {busy === "salary" ? "Saving…" : "Save & approve salary"}
            </button>
            <span className="badge action">Required</span>
          </div>}
        </div>

        <div className="reviewSection">
          <h3>Screening answers</h3>
          <div className="screeningReviewList">{answers.map((answer) => {
            const key = answer.id || answer.questionKey || answer.questionText;
            const verified = answer.trust === "verified";
            return <div className="screeningReviewItem" key={key}>
              <div className="screeningQuestion"><span className={`trustDot trust-${answer.colour}`}></span><div>
                <strong>{answer.questionText}</strong>
                <small>{verified ? "Green · verified fact" : answer.trust === "proposed" ? "Amber · review and approve" : "Red · answer yourself"}</small>
              </div></div>
              {verified ? <div className="verifiedAnswer">{answer.answerText || "Verified fact unavailable"}</div> : <textarea rows={3} aria-label={`Answer: ${answer.questionText}`}
                value={answerValues[key] || ""} placeholder={answer.trust === "user_required" ? "Enter your answer" : "Review or edit the generated answer"}
                onChange={(event) => setAnswerValues((current) => ({ ...current, [key]: event.target.value }))} />}
              {verified ? <span className="badge review">Verified</span> : <div className="answerApproveRow">
                <button className="secondaryButton" disabled={Boolean(busy) || !String(answerValues[key] || "").trim()}
                  onClick={() => act(`answer-${key}`, { action: "answer", answerId: answer.id, questionKey: answer.questionKey, answerText: answerValues[key] || "" })}>
                  {answer.approvedAt ? "Update approved answer" : "Save & approve"}
                </button>
                {answer.approvedAt ? <span className="badge review">Approved</span> : <span className="badge action">Needs you</span>}
              </div>}
            </div>;
          })}</div>
          {!answers.length ? <div className="emptyState">No screening questions are required for this application.</div> : null}
        </div>

        <div className="gateApprovalBar"><div>
          <strong>{review.canApprove ? "Everything required for Gate 1 is approved." : `${review.unresolvedCount} review check${review.unresolvedCount === 1 ? "" : "s"} remain.`}</strong>
          <p>Approval freezes the selected content package. It does not create an employer form or submit an application.</p>
        </div><button className="primaryButton approveApplicationButton" disabled={Boolean(busy) || !review.canApprove}
          onClick={() => act("approve", { action: "approve" })}>
          {busy === "approve" ? "Approving…" : "Approve application content"}
        </button></div>
      </> : applicationState === "content_approved" ? <div className="notice successNotice">
        Approval Gate 1 has been passed and saved. No employer form or submission was created. If any selected content or decision needs to change, return this application to revision first.
        <div className="buttonRow"><button className="secondaryButton" disabled={Boolean(busy)} onClick={() => act("return-to-revision", { action: "return_to_revision", reason: "User requested a review revision" })}>
          {busy === "return-to-revision" ? "Returning…" : "Return to revision"}
        </button></div>
      </div> : <div className="notice">This application is not currently open for Gate 1 review.</div>}

      {error ? <p className="formError" role="alert">{error}</p> : null}
    </section>
  );
}
