import assert from "node:assert/strict";
import { buildReviewChecklist } from "../packages/review-center/index.js";

const app = { state: "ready_for_review" };
const cv = { approvalStatus: "approved", unsupportedClaimsCount: 0 };
const cover = { approvalStatus: "approved", unsupportedClaimsCount: 0 };
const salary = { approvedAt: "2026-08-23T16:00:00Z" };
const green = { required: true, trust: "verified", answerText: "PhD", approvedAt: null };
const amber = { required: true, trust: "proposed", answerText: "£51,000", approvedAt: "2026-08-23T16:00:00Z" };
const red = { required: true, trust: "user_required", answerText: "Yes", approvedAt: "2026-08-23T16:00:00Z" };

let gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: cover, coverLetterDecision: "use", salary, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, true, "fully reviewed package should pass Gate 1");
assert.equal(gate.unresolvedCount, 0);

gate = buildReviewChecklist({ application: app, cvVersion: { ...cv, approvalStatus: "needs_review" }, coverLetterVersion: cover, coverLetterDecision: "use", salary, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, false, "unapproved CV must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: cover, coverLetterDecision: "use", salary: { approvedAt: null }, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, false, "unapproved salary must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: cover, coverLetterDecision: "use", salary, answers: [green, { ...amber, approvedAt: null }, red], assembled: true });
assert.equal(gate.canApprove, false, "unapproved Amber answer must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: cover, coverLetterDecision: "use", salary, answers: [green, amber, { ...red, answerText: null, approvedAt: null }], assembled: true });
assert.equal(gate.canApprove, false, "blank Red required answer must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: null, coverLetterDecision: "remove", salary, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, true, "explicitly removed cover letter must not block Gate 1");

gate = buildReviewChecklist({ application: { state: "preparing" }, cvVersion: cv, coverLetterVersion: null, coverLetterDecision: "not_required", salary, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, false, "preparing state cannot pass Gate 1");

console.log("Review centre verification passed");
console.log(`Checks: ${gate.total}`);
