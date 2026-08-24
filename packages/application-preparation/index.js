export const APPLICATION_PREPARATION_CONTRACT_VERSION = "1.0.0";

const ALLOWED_ORIGINS = new Set(["manual", "auto_prepare"]);

function hasAdvertisedSalary(job) {
  return Boolean(job?.salaryText || job?.salaryMin != null || job?.salaryMax != null);
}

function task(taskType, state, label, input = {}, output = null) {
  return { taskType, state, label, input, output };
}

export function buildApplicationPreparationPlan(job, options = {}) {
  if (!job?.id) throw new Error("A persistent job ID is required before application creation.");
  if (!job.analysis) throw new Error("The job must have a completed analysis before application creation.");
  if (!job.analysis.recommendedCvFamily) throw new Error("The job analysis does not contain a CV-family recommendation.");

  const origin = options.origin || "manual";
  if (!ALLOWED_ORIGINS.has(origin)) throw new Error(`Unsupported application origin: ${origin}`);
  if (job.analysis.eligibility === "ineligible") throw new Error("Ineligible jobs cannot create applications.");
  if (job.analysis.triage === "reject") throw new Error("Rejected jobs cannot create applications without a new analysis.");
  if (origin === "auto_prepare" && job.analysis.triage !== "auto_prepare") {
    throw new Error("Only jobs classified auto_prepare may enter the automatic preparation path.");
  }

  const coverLetterValue = job.analysis.coverLetterValue || "low";
  const shouldPrepareCoverLetter = coverLetterValue === "high" || coverLetterValue === "medium";
  const advertisedSalary = hasAdvertisedSalary(job);

  const tasks = [
    task("freeze_job_context", "completed", "Freeze vacancy and analysis", {
      jobId: job.id,
      snapshotCapturedAt: job.snapshotCapturedAt || null,
      analysisId: job.analysis.id || null,
      contractVersion: job.analysis.contractVersion,
    }, { frozen: true }),
    task("lock_application_strategy", "completed", "Lock application strategy", {
      strategy: job.analysis.applicationStrategy,
      evidenceIds: job.analysis.evidenceIds || [],
    }, { locked: true }),
    task("select_cv_family", "completed", "Select base CV family", {
      cvFamily: job.analysis.recommendedCvFamily,
    }, { cvFamily: job.analysis.recommendedCvFamily }),
    task("prepare_cv", "pending", "Prepare tailored CV", {
      executionMode: "chatgpt_plus_handoff",
      cvFamily: job.analysis.recommendedCvFamily,
      evidenceIds: job.analysis.evidenceIds || [],
      unsupportedClaimsTarget: 0,
    }),
    shouldPrepareCoverLetter
      ? task("prepare_cover_letter", "pending", "Prepare cover letter", {
          executionMode: "chatgpt_plus_handoff",
          value: coverLetterValue,
          conditional: coverLetterValue === "medium",
          evidenceIds: job.analysis.evidenceIds || [],
        })
      : task("prepare_cover_letter", "completed", "Cover letter decision", {
          value: coverLetterValue,
        }, { skipped: true, reason: coverLetterValue === "not_accepted" ? "Employer does not accept a cover letter." : "Low expected value." }),
    task("prepare_screening_answers", "pending", "Prepare screening answers", {
      executionMode: "chatgpt_plus_handoff",
      trustPolicy: "verified_proposed_user_required",
    }),
    advertisedSalary
      ? task("research_salary", "completed", "Resolve salary context", {
          advertisedSalary: job.salaryText || null,
          salaryMin: job.salaryMin ?? null,
          salaryMax: job.salaryMax ?? null,
          salaryCurrency: job.salaryCurrency || "GBP",
        }, { advertised: true })
      : task("research_salary", "pending", "Research salary range", {
          executionMode: "chatgpt_plus_handoff",
          requiredOutput: "clearly_labelled_estimate",
        }),
    task("assemble_review_package", "pending", "Assemble Ready for Review package", {
      waitsFor: ["prepare_cv", "prepare_cover_letter", "prepare_screening_answers", "research_salary"],
    }),
  ];

  return {
    contractVersion: APPLICATION_PREPARATION_CONTRACT_VERSION,
    origin,
    state: "preparing",
    jobId: job.id,
    jobAnalysisId: job.analysis.id || null,
    selectedCvFamily: job.analysis.recommendedCvFamily,
    strategyText: job.analysis.applicationStrategy,
    evidenceIds: job.analysis.evidenceIds || [],
    nextAction: "Complete preparation tasks and review the finished application package.",
    tasks,
  };
}

export function preparationProgress(tasks = []) {
  const total = tasks.length;
  const completed = tasks.filter((item) => item.state === "completed").length;
  const needsUser = tasks.filter((item) => item.state === "needs_user").length;
  const failed = tasks.filter((item) => item.state === "failed").length;
  return {
    total,
    completed,
    pending: Math.max(0, total - completed - failed),
    needsUser,
    failed,
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
}
