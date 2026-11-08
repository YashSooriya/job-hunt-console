import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildReviewChecklist } from "../packages/review-center/index.js";

const reviewService = await readFile(new URL("../apps/web/lib/application/review.ts", import.meta.url), "utf8");
const integrityMigration = await readFile(new URL("../database/migrations/20261108130000_m08_reviewed_artifact_integrity.sql", import.meta.url), "utf8");
const acceptanceRunner = await readFile(new URL("../scripts/windows_m07_document_generation_acceptance.py", import.meta.url), "utf8");

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

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: { ...cover, approvalStatus: "needs_review" }, coverLetterDecision: "use", salary, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, false, "an included letter without factual acceptance must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: cover, coverLetterDecision: "use", salary: { approvedAt: null }, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, false, "unapproved salary must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: cover, coverLetterDecision: "use", salary, answers: [green, { ...amber, approvedAt: null }, red], assembled: true });
assert.equal(gate.canApprove, false, "unapproved Amber answer must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: cover, coverLetterDecision: "use", salary, answers: [green, amber, { ...red, answerText: null, approvedAt: null }], assembled: true });
assert.equal(gate.canApprove, false, "blank Red required answer must block Gate 1");

gate = buildReviewChecklist({ application: app, cvVersion: cv, coverLetterVersion: null, coverLetterDecision: "remove", salary, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, true, "explicitly removed cover letter must not block Gate 1");

const approvalRpc = reviewService.indexOf('supabase.rpc("approve_application_content"');
const reusableWrite = reviewService.indexOf("rememberApprovedApplicationAnswers(supabase, profile.id, applicationId)");
assert.ok(approvalRpc >= 0 && reusableWrite > approvalRpc, "reusable answers must only be written after the Gate 1 RPC succeeds");
assert.match(reviewService, /isSensitiveApplicationAnswer[\s\S]*?answer\.question_text[\s\S]*?metadata\.sensitive/i,
  "question text and explicit metadata sensitivity must keep disclosures application-scoped");
assert.match(reviewService, /if \(existingSensitivity\.get\(answer\.key\)\) continue/,
  "a reusable answer already marked sensitive must not be overwritten by Gate 1 promotion");
assert.match(integrityMigration, /factual_review_locked_at[\s\S]*?private\.can_mutate_application_document_object[\s\S]*?v_factual_review_locked_at is not null/i,
  "an individually accepted version and its stored artifacts must stay immutable after return to revision");
assert.match(integrityMigration, /Selected CV version is not approved[\s\S]*?factual_review_locked_at/i,
  "Gate 1 must require the factual-review lock for its exact selected CV");
assert.match(acceptanceRunner, /m08_assert_gate1_prerequisites[\s\S]*?missingMemoryFactualReviewBlocked[\s\S]*?m08_assert_reviewed_artifacts_locked/i,
  "local acceptance must probe each missing Gate 1 prerequisite and artifact write denial");
assert.match(acceptanceRunner, /m08_rejected_approval_probe_[\s\S]*?review\/action[\s\S]*?reusable_after_rejected_approval/i,
  "local acceptance must prove a rejected authenticated Gate 1 action leaves reusable answers unchanged");
assert.match(acceptanceRunner, /sensitiveAnswerReusableCount[\s\S]*?sensitiveAnswerRemainsApplicationScoped/i,
  "local acceptance must prove a sensitive synthetic answer is not promoted into reusable profile memory");
assert.match(acceptanceRunner, /m08_storage_http[\s\S]*?x-upsert[\s\S]*?storage\/v1\/object\/authenticated[\s\S]*?storageApiPdfDocxReplacementDenied/i,
  "local acceptance must attempt actual authenticated replacement and deletion through loopback Storage");

gate = buildReviewChecklist({ application: { state: "preparing" }, cvVersion: cv, coverLetterVersion: null, coverLetterDecision: "not_required", salary, answers: [green, amber, red], assembled: true });
assert.equal(gate.canApprove, false, "preparing state cannot pass Gate 1");

console.log("Review centre verification passed");
console.log(`Checks: ${gate.total}`);
