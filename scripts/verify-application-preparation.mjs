import { buildApplicationPreparationPlan, preparationProgress } from "../packages/application-preparation/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function job(overrides = {}) {
  const { analysis: analysisOverrides = {}, ...jobOverrides } = overrides;
  return {
    id: "job-001",
    company: "Engineering Co",
    title: "Simulation Engineer",
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: "GBP",
    snapshotCapturedAt: "2026-08-23T12:00:00Z",
    analysis: {
      id: "analysis-001",
      contractVersion: "1.0.0",
      analysisSource: "deterministic_v1",
      eligibility: "eligible",
      fitScore: 93,
      priorityScore: 88,
      recommendedCvFamily: "simulation_cae",
      applicationStrategy: "Lead with multiphysics FEM, validation and Python scientific software evidence.",
      coverLetterValue: "high",
      evidenceIds: ["EV-001", "EV-002"],
      triage: "auto_prepare",
      triageReason: "Strong fit and priority.",
      ...analysisOverrides,
    },
    ...jobOverrides,
  };
}

const automatic = buildApplicationPreparationPlan(job(), { origin: "auto_prepare" });
assert(automatic.state === "preparing", "Application creation must begin in preparing rather than bypassing review states");
assert(automatic.selectedCvFamily === "simulation_cae", "Selected CV family was not locked from job analysis");
assert(automatic.strategyText.includes("multiphysics FEM"), "Application strategy was not carried into preparation");
assert(automatic.tasks.some((task) => task.taskType === "prepare_cv" && task.state === "pending"), "CV preparation task missing");
assert(automatic.tasks.some((task) => task.taskType === "prepare_cover_letter" && task.state === "pending"), "High-value cover letter should be prepared");
assert(automatic.tasks.some((task) => task.taskType === "research_salary" && task.state === "pending"), "Missing salary should create a research task");
assert(automatic.tasks.every((task) => task.taskType !== "submit_application"), "Preparation plan must never contain a submit task");
assert(new Set(automatic.tasks.map((task) => task.taskType)).size === automatic.tasks.length, "Preparation task types are duplicated");

const salaryKnown = buildApplicationPreparationPlan(job({ salaryText: "£55,000–£65,000" }), { origin: "manual" });
assert(salaryKnown.tasks.find((task) => task.taskType === "research_salary")?.state === "completed", "Advertised salary should resolve the initial salary-context task");

const lowLetter = buildApplicationPreparationPlan(job({ analysis: { coverLetterValue: "low", triage: "recommend" } }), { origin: "manual" });
const letterTask = lowLetter.tasks.find((task) => task.taskType === "prepare_cover_letter");
assert(letterTask?.state === "completed" && letterTask.output?.skipped === true, "Low-value cover letter should be explicitly skipped rather than generated mechanically");

let rejectedBlocked = false;
try { buildApplicationPreparationPlan(job({ analysis: { triage: "reject" } }), { origin: "manual" }); } catch { rejectedBlocked = true; }
assert(rejectedBlocked, "Rejected jobs must not create applications");

let ineligibleBlocked = false;
try { buildApplicationPreparationPlan(job({ analysis: { eligibility: "ineligible" } }), { origin: "manual" }); } catch { ineligibleBlocked = true; }
assert(ineligibleBlocked, "Ineligible jobs must not create applications");

let falseAutoBlocked = false;
try { buildApplicationPreparationPlan(job({ analysis: { triage: "recommend" } }), { origin: "auto_prepare" }); } catch { falseAutoBlocked = true; }
assert(falseAutoBlocked, "Recommend jobs must not enter the automatic preparation path");

const progress = preparationProgress(automatic.tasks);
assert(progress.total === automatic.tasks.length, "Progress total is inconsistent");
assert(progress.completed >= 3 && progress.percent > 0 && progress.percent < 100, "Bootstrap should complete deterministic context steps but leave content work pending");

console.log(JSON.stringify({
  state: automatic.state,
  origin: automatic.origin,
  cv: automatic.selectedCvFamily,
  taskCount: automatic.tasks.length,
  progress,
  pendingTasks: automatic.tasks.filter((task) => task.state === "pending").map((task) => task.taskType),
}, null, 2));
console.log("Application preparation verification passed.");
