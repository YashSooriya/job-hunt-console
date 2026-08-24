"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApplicationReviewPackage, ScreeningAnswerRecord, SalaryContextRecord } from "@/lib/types";

type Version = { id: string; versionNumber: number; approvalStatus: string; unsupportedClaimsCount: number } | null;

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
  const [salaryValue, setSalaryValue] = useState(String(salary?.recommendedValue || ""));
  const [answerValues, setAnswerValues] = useState<Record<string, string>>(Object.fromEntries(answers.map((a) => [a.id || a.questionKey || a.questionText, a.answerText || ""])));

  async function act(key: string, payload: Record<string, unknown>) {
    setBusy(key); setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/review/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Review action failed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review action failed.");
    } finally { setBusy(null); }
  }

  if (!review.assembledAt && applicationState !== "content_approved") {
    return <section className="card gateCard"><div className="cardHeader"><div><h2>Ready for Review</h2><p>The content exists, but the review package has not been assembled yet.</p></div></div><button className="primaryButton" disabled={Boolean(busy)} onClick={() => act("assemble", { action: "assemble" })}>{busy === "assemble" ? "Assembling…" : "Assemble review package"}</button>{error ? <p className="formError">{error}</p> : null}</section>;
  }

  return (
    <section className="card reviewCentreCard">
      <div className="cardHeader"><div><div className="eyebrow">Approval Gate 1</div><h2>{applicationState === "content_approved" ? "Application content approved" : "Ready for Review"}</h2><p>Review the exact package that will be carried forward to the employer form.</p></div><span className={`badge ${review.canApprove ? "review" : applicationState === "content_approved" ? "review" : "action"}`}>{applicationState === "content_approved" ? "Approved" : `${review.completed}/${review.total} checks complete`}</span></div>

      <div className="reviewChecklist">
        {review.checklist.map((item) => <div className="reviewCheck" key={item.key}><span className={item.complete ? "checkDone" : "checkOpen"}>{item.complete ? "✓" : "○"}</span><span>{item.label}</span></div>)}
      </div>

      {applicationState === "ready_for_review" ? <>
        <div className="reviewSection">
          <h3>CV decision</h3>
          {cvVersion ? <div className="reviewActionRow"><div><strong>Selected CV · version {cvVersion.versionNumber}</strong><p>{cvVersion.unsupportedClaimsCount} unsupported claims · {cvVersion.approvalStatus.replaceAll("_", " ")}</p></div><div className="buttonRow"><button className="secondaryButton" disabled={Boolean(busy)} onClick={() => act("cv-reject", { action: "document", versionId: cvVersion.id, decision: "reject" })}>Request revision</button><button className="primaryButton" disabled={Boolean(busy) || cvVersion.approvalStatus === "approved"} onClick={() => act("cv-approve", { action: "document", versionId: cvVersion.id, decision: "approve" })}>{cvVersion.approvalStatus === "approved" ? "Accepted" : "Accept CV"}</button></div></div> : <div className="emptyState">No selected CV version.</div>}
        </div>

        <div className="reviewSection">
          <h3>Cover letter decision</h3>
          {review.coverLetterDecision === "not_required" ? <div className="notice successNotice">No cover letter is required for this application.</div> : <div className="reviewActionRow"><div><strong>{review.coverLetterDecision === "remove" ? "Cover letter removed from package" : `Selected cover letter · version ${coverVersion?.versionNumber || "?"}`}</strong><p>{coverVersion ? coverVersion.approvalStatus.replaceAll("_", " ") : "Not included"}</p></div><div className="buttonRow"><button className="secondaryButton" disabled={Boolean(busy)} onClick={() => act("cover-remove", { action: "cover_letter", decision: review.coverLetterDecision === "remove" ? "use" : "remove" })}>{review.coverLetterDecision === "remove" ? "Use letter" : "Remove letter"}</button>{review.coverLetterDecision === "use" && coverVersion ? <button className="primaryButton" disabled={Boolean(busy) || coverVersion.approvalStatus === "approved"} onClick={() => act("cover-approve", { action: "document", versionId: coverVersion.id, decision: "approve" })}>{coverVersion.approvalStatus === "approved" ? "Accepted" : "Accept letter"}</button> : null}</div></div>}
        </div>

        <div className="reviewSection">
          <h3>Salary expectation</h3>
          {salary ? <div className="salaryApproval"><label>Base annual salary expectation ({salary.currency})<input value={salaryValue} inputMode="numeric" onChange={(e) => setSalaryValue(e.target.value.replace(/[^0-9]/g, ""))} /></label><button className="primaryButton" disabled={Boolean(busy) || !salaryValue} onClick={() => act("salary", { action: "salary", recommendedValue: Number(salaryValue) })}>{salary.approvedAt ? "Update & approve" : "Approve salary"}</button>{salary.approvedAt ? <span className="badge review">Approved</span> : <span className="badge action">Needs approval</span>}</div> : <div className="emptyState">Salary context missing.</div>}
        </div>

        <div className="reviewSection">
          <h3>Screening answers</h3>
          <div className="screeningReviewList">{answers.map((answer) => {
            const key = answer.id || answer.questionKey || answer.questionText;
            const verified = answer.trust === "verified";
            return <div className="screeningReviewItem" key={key}><div className="screeningQuestion"><span className={`trustDot trust-${answer.colour}`}></span><div><strong>{answer.questionText}</strong><small>{verified ? "Green · verified fact" : answer.trust === "proposed" ? "Amber · review and approve" : "Red · answer yourself"}</small></div></div>{verified ? <div className="verifiedAnswer">{answer.answerText || "Verified fact unavailable"}</div> : <textarea rows={3} value={answerValues[key] || ""} placeholder={answer.trust === "user_required" ? "Enter your answer" : "Review or edit the generated answer"} onChange={(e) => setAnswerValues((current) => ({ ...current, [key]: e.target.value }))} />}{verified ? <span className="badge review">Verified</span> : <div className="answerApproveRow"><button className="secondaryButton" disabled={Boolean(busy) || !String(answerValues[key] || "").trim()} onClick={() => act(`answer-${key}`, { action: "answer", answerId: answer.id, questionKey: answer.questionKey, answerText: answerValues[key] || "" })}>{answer.approvedAt ? "Update approved answer" : "Save & approve"}</button>{answer.approvedAt ? <span className="badge review">Approved</span> : <span className="badge action">Needs you</span>}</div>}</div>;
          })}</div>
        </div>

        <div className="gateApprovalBar"><div><strong>{review.canApprove ? "Everything required for Gate 1 is approved." : `${review.unresolvedCount} review check${review.unresolvedCount === 1 ? "" : "s"} remain.`}</strong><p>Approval freezes the selected content package for the next form-completion stage. It does not submit an application.</p></div><button className="primaryButton approveApplicationButton" disabled={Boolean(busy) || !review.canApprove} onClick={() => act("approve", { action: "approve" })}>{busy === "approve" ? "Approving…" : "Approve application content"}</button></div>
      </> : <div className="notice successNotice">Approval Gate 1 has been passed. External form completion is the next stage; nothing has been submitted automatically.</div>}
      {error ? <p className="formError">{error}</p> : null}
    </section>
  );
}
