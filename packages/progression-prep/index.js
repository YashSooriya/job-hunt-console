export const PROGRESSION_PREP_CONTRACT_VERSION = "1.0.0";

const clean = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
const unique = (values) => [...new Set((values || []).map(clean).filter(Boolean))];

export function deadlineUrgency(deadlineAt, now = new Date()) {
  if (!deadlineAt) return { band: "unknown", hoursRemaining: null };
  const deadline = new Date(deadlineAt);
  const current = new Date(now);
  if (Number.isNaN(deadline.valueOf()) || Number.isNaN(current.valueOf())) return { band: "unknown", hoursRemaining: null };
  const hoursRemaining = Math.round(((deadline.valueOf() - current.valueOf()) / 3600000) * 10) / 10;
  const band = hoursRemaining < 0 ? "overdue" : hoursRemaining <= 24 ? "urgent" : hoursRemaining <= 72 ? "soon" : "normal";
  return { band, hoursRemaining };
}

function roleSignals(role = "", description = "") {
  const text = `${role} ${description}`.toLowerCase();
  const signals = [];
  if (/aero|thermal|fluid|cfd|heat transfer|thermodynamic/.test(text)) signals.push("aerothermal and engineering judgement");
  if (/simulation|model|finite element|fem|numerical|computational/.test(text)) signals.push("numerical modelling and verification");
  if (/python|c\+\+|matlab|software|code/.test(text)) signals.push("technical programming and problem solving");
  if (/data|quant|statistic|machine learning|analytics/.test(text)) signals.push("quantitative reasoning and data interpretation");
  if (/customer|stakeholder|team|collaborat|communicat/.test(text)) signals.push("communication and collaborative judgement");
  return unique(signals);
}

function standardAssessmentModules(input) {
  const text = `${input.assessmentType || ""} ${input.invitationNotes || ""} ${input.provider || ""}`.toLowerCase();
  const modules = [];
  if (/situational|judgement|sjt|aon|maptq/.test(text)) modules.push({ key: "situational_judgement", label: "Situational judgement", focus: "Consistency, prioritisation, integrity, safety and collaboration in synthetic workplace scenarios." });
  if (/numerical|reasoning|aon|maptq/.test(text)) modules.push({ key: "numerical_reasoning", label: "Numerical reasoning", focus: "Percentages, ratios, charts, tables, estimation and time-pressured arithmetic using synthetic practice questions." });
  if (/verbal|reasoning|aon|maptq/.test(text)) modules.push({ key: "verbal_reasoning", label: "Verbal reasoning", focus: "Evidence-based conclusions from short passages and careful distinction between true, false and insufficient information." });
  if (/coding|technical/.test(text)) modules.push({ key: "technical", label: "Technical assessment", focus: "Role-relevant concepts and synthetic technical exercises, never live assessment questions." });
  if (!modules.length) modules.push({ key: "general", label: "General assessment preparation", focus: "Timed practice, instructions discipline, role judgement and environment setup." });
  return modules;
}

function interviewQuestions(context) {
  const signals = roleSignals(context.role, context.jobDescription);
  const questions = [
    "Walk me through the experience that is most relevant to this role.",
    "Describe a technically difficult problem where you had to decide whether the result could be trusted.",
    "Tell me about a disagreement or ambiguity in a technical project and how you resolved it.",
    "What would you want to understand in your first few weeks in this role?",
  ];
  if (signals.some((s) => /numerical|aerothermal/.test(s))) questions.push("How do you validate a computational model before relying on it for an engineering decision?");
  if (signals.some((s) => /programming/.test(s))) questions.push("How do you structure scientific or engineering code so that it remains testable and maintainable?");
  return unique(questions);
}

function evidenceStories(context) {
  return (context.evidence || []).slice(0, 6).map((item) => ({
    evidenceId: item.id,
    headline: item.claim,
    prompt: `Prepare a concise STAR-style example grounded only in evidence ${item.id}.`,
  }));
}

export function validatePracticeOnlyPackage(pkg) {
  const issues = [];
  const text = JSON.stringify(pkg || {}).toLowerCase();
  if (pkg?.practice_only !== true) issues.push("Preparation package must be marked practice_only=true.");
  if (/live_assessment_answer|actual_assessment_answer|answer_real_assessment/.test(text)) issues.push("Package contains a prohibited live-assessment answer field.");
  if (pkg?.assessment_submission || pkg?.assessment_answers) issues.push("Preparation package must not contain assessment submission data.");
  return { valid: issues.length === 0, issues };
}

export function buildAssessmentPreparation(input) {
  const context = input.context;
  const urgency = deadlineUrgency(input.deadlineAt, input.now || new Date());
  const rules = unique([
    ...(input.rules || []),
    "Use this workspace only before the assessment. Do not paste or solve live assessment questions here.",
    "Follow the employer/provider instructions if they are stricter than this workspace.",
  ]);
  const modules = standardAssessmentModules(input);
  const prep = {
    contract_version: PROGRESSION_PREP_CONTRACT_VERSION,
    kind: "assessment",
    practice_only: true,
    generated_at: new Date(input.now || Date.now()).toISOString(),
    context_quality: context.quality,
    application_recap: {
      company: context.company,
      role: context.role,
      strategy: context.strategy,
      selected_cv_family: context.selectedCvFamily,
      strongest_evidence: (context.evidence || []).slice(0, 5).map((x) => ({ evidence_id: x.id, claim: x.claim })),
    },
    assessment: {
      provider: input.provider || null,
      type: input.assessmentType || "Online assessment",
      deadline_at: input.deadlineAt || null,
      estimated_minutes: input.estimatedMinutes || null,
      urgency,
      invitation_notes: input.invitationNotes || null,
    },
    rules,
    likely_components: modules,
    checklist: [
      "Read the invitation and provider instructions again before starting.",
      "Use a quiet environment, stable internet connection and a charged computer.",
      "Complete only synthetic practice before opening the live assessment.",
      "Review the role and the application evidence most likely to shape judgement scenarios.",
      "Leave enough uninterrupted time to finish in one sitting if the provider requires it.",
    ],
    practice_plan: modules.map((m) => ({ module: m.key, suggested_minutes: m.key === "general" ? 25 : 20, objective: m.focus })),
    chatgpt_handoff: {
      purpose: "Generate additional synthetic practice and preparation only.",
      prompt: `Prepare me for the ${input.provider || "employer"} ${input.assessmentType || "online assessment"} for ${context.company} ${context.role}. Use only synthetic practice questions. Do not answer, interpret or assist with any live assessment question. Focus on ${modules.map((m) => m.label).join(", ")}.`,
    },
  };
  const validation = validatePracticeOnlyPackage(prep);
  if (!validation.valid) throw new Error(validation.issues.join(" "));
  return prep;
}

export function buildInterviewPreparation(input) {
  const context = input.context;
  const signals = roleSignals(context.role, context.jobDescription);
  return {
    contract_version: PROGRESSION_PREP_CONTRACT_VERSION,
    kind: "interview",
    practice_only: true,
    generated_at: new Date(input.now || Date.now()).toISOString(),
    context_quality: context.quality,
    interview: {
      type: input.interviewType || "Interview",
      round: input.roundLabel || null,
      scheduled_at: input.scheduledAt || null,
      participants: input.participants || [],
    },
    submitted_recap: {
      company: context.company,
      role: context.role,
      strategy: context.strategy,
      selected_cv_family: context.selectedCvFamily,
      cv_version_id: context.cvVersionId,
      cover_letter_version_id: context.coverLetterVersionId,
      screening_answers: context.screeningAnswers || [],
      salary_expectation: context.salaryExpectation || null,
    },
    role_focus: signals,
    strongest_evidence: evidenceStories(context),
    likely_questions: interviewQuestions(context),
    weak_areas: unique(context.weaknesses || []).slice(0, 6),
    questions_to_ask: [
      "What distinguishes someone who performs very well in this role after the first six months?",
      "Which technical problems would you expect the successful candidate to tackle first?",
      "How are modelling, validation and engineering judgement reviewed within the team?",
      "What are the main interfaces with other technical teams or stakeholders?",
    ],
    salary_discussion: {
      submitted_expectation: context.salaryExpectation || null,
      guidance: "Keep the discussion consistent with the figure or range already submitted unless new information materially changes the role scope.",
    },
    preparation_checklist: [
      "Read the exact submitted CV and screening answers before the interview.",
      "Prepare concise evidence-backed examples for the strongest requirements.",
      "Prepare an explicit explanation for each known weak area without overstating experience.",
      "Review the original vacancy snapshot, not a possibly edited/reposted advert.",
      "Prepare questions for the interviewer and a consistent salary answer.",
    ],
    chatgpt_handoff: {
      purpose: "Run interview preparation using the exact application context.",
      prompt: `Prepare me for an interview for ${context.company} ${context.role}. Base every claim on the supplied application context and evidence. Challenge weak or vague answers, avoid inventing experience, and keep answers consistent with the submitted CV and screening responses.`,
    },
  };
}
