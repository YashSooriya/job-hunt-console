import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAssessmentPreparation, buildInterviewPreparation, deadlineUrgency, validatePracticeOnlyPackage } from "../packages/progression-prep/index.js";

const context = {
  quality: "best_available",
  capturedAt: "2026-08-23T17:00:00.000Z",
  applicationId: "tracker-row-2",
  company: "Rolls-Royce",
  role: "Aerothermal Engineer (JR6158436)",
  strategy: "Emphasise computational engineering, verification, structural dynamics and evidence-based technical judgement.",
  selectedCvFamily: "simulation_cae",
  cvVersionId: null,
  coverLetterVersionId: null,
  screeningAnswers: [],
  salaryExpectation: null,
  jobDescription: "Aerothermal engineering role involving modelling, engineering judgement, numerical methods and collaboration.",
  strengths: ["Numerical modelling", "Verification"],
  weaknesses: ["Direct gas-turbine aerothermal industry experience is limited."],
  evidence: [
    { id: "EV-0001", claim: "Developed a Python/NGSolve finite-element framework for coupled electromagnetic and structural analysis." },
    { id: "EV-0005", claim: "Verified computational results against analytical, manufactured, convergence and ANSYS references." },
  ],
};

const assessment = buildAssessmentPreparation({
  context,
  provider: "AON MapTQ",
  assessmentType: "Online assessment",
  deadlineAt: "2026-08-26T20:42:35.000Z",
  invitationNotes: "One chance. Complete independently without assistance. Use a quiet environment and stable internet connection.",
  rules: ["The employer requires independent completion without assistance during the live assessment."],
  now: "2026-08-23T17:00:00.000Z",
});
assert.equal(assessment.practice_only, true);
assert.equal(assessment.assessment.provider, "AON MapTQ");
assert.ok(assessment.rules.some((x) => /independent/i.test(x)));
assert.ok(assessment.likely_components.length >= 1);
assert.ok(assessment.chatgpt_handoff.prompt.includes("synthetic practice"));
assert.equal(validatePracticeOnlyPackage(assessment).valid, true);
assert.equal(validatePracticeOnlyPackage({ practice_only: true, live_assessment_answer: "x" }).valid, false);
assert.equal(deadlineUrgency("2026-08-24T12:00:00Z", "2026-08-23T17:00:00Z").band, "urgent");

const interview = buildInterviewPreparation({
  context: { ...context, quality: "exact_submitted", cvVersionId: "cv-v3", coverLetterVersionId: "cl-v2", salaryExpectation: 51000 },
  interviewType: "Technical interview",
  roundLabel: "Round 1",
  scheduledAt: "2026-09-01T10:00:00Z",
  participants: [{ name: "Hiring Manager" }],
  now: "2026-08-23T17:00:00.000Z",
});
assert.equal(interview.practice_only, true);
assert.equal(interview.submitted_recap.cv_version_id, "cv-v3");
assert.equal(interview.submitted_recap.salary_expectation, 51000);
assert.ok(interview.likely_questions.some((q) => /validate a computational model/i.test(q)));
assert.ok(interview.strongest_evidence.every((x) => x.evidenceId));

const fixture = JSON.parse(fs.readFileSync(new URL("../data/progression/workflows.json", import.meta.url), "utf8"));
assert.ok(fixture.assessments.some((a) => a.company === "Rolls-Royce" && a.provider === "AON MapTQ"));
assert.ok(!JSON.stringify(fixture).includes("accesscode="), "Assessment access links must not be stored in local fixtures.");

const migration = fs.readFileSync(new URL("../database/migrations/0021_progression_workspaces.sql", import.meta.url), "utf8");
assert.ok(migration.includes("application_submission_contexts"));
assert.ok(migration.includes("Submitted application context is immutable"));
assert.ok(migration.includes("practice_only"));
assert.ok(migration.includes("Live assessment answer/submission content is prohibited"));

console.log("Progression preparation verification passed.");
console.log(`Assessment modules: ${assessment.likely_components.length}`);
console.log(`Interview likely questions: ${interview.likely_questions.length}`);
