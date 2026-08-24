export const REVIEW_CENTER_CONTRACT_VERSION = "1.0.0";

export function buildReviewChecklist({ application, cvVersion, coverLetterVersion, coverLetterDecision, salary, answers = [], assembled = false }) {
  const cvApproved = Boolean(cvVersion && cvVersion.approvalStatus === "approved" && cvVersion.unsupportedClaimsCount === 0);
  const coverRequired = coverLetterDecision === "use";
  const coverApproved = !coverRequired || Boolean(coverLetterVersion && coverLetterVersion.approvalStatus === "approved" && coverLetterVersion.unsupportedClaimsCount === 0);
  const salaryApproved = Boolean(salary?.approvedAt);
  const requiredAnswersResolved = answers.filter((a) => a.required && !String(a.answerText || "").trim()).length === 0;
  const proposedAnswersApproved = answers.filter((a) => a.trust === "proposed" && !a.approvedAt).length === 0;
  const userRequiredApproved = answers.filter((a) => a.trust === "user_required" && (!String(a.answerText || "").trim() || !a.approvedAt)).length === 0;
  const checklist = [
    { key: "assembled", label: "Review package assembled", complete: Boolean(assembled) },
    { key: "cv", label: "Selected CV approved", complete: cvApproved },
    { key: "cover_letter", label: coverRequired ? "Selected cover letter approved" : "Cover-letter decision resolved", complete: coverApproved },
    { key: "salary", label: "Salary expectation approved", complete: salaryApproved },
    { key: "required_answers", label: "Required answers completed", complete: requiredAnswersResolved },
    { key: "generated_answers", label: "Generated answers approved", complete: proposedAnswersApproved },
    { key: "user_answers", label: "User-only answers supplied", complete: userRequiredApproved },
  ];
  return {
    contractVersion: REVIEW_CENTER_CONTRACT_VERSION,
    state: application?.state || null,
    checklist,
    completed: checklist.filter((x) => x.complete).length,
    total: checklist.length,
    canApprove: checklist.every((x) => x.complete) && application?.state === "ready_for_review",
    unresolvedCount: checklist.filter((x) => !x.complete).length,
  };
}
