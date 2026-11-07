import { createHash } from "node:crypto";
import { priorityAndRecommendation, type Preferences } from "../job-fit-v3/priority.ts";
import { MEMORY_FIT_CONTRACT_VERSION, MEMORY_FIT_DIMENSIONS, MEMORY_FIT_ENGINE_VERSION, MEMORY_FIT_WEIGHTS, type MemoryFitDimension, type MemoryFitResponseJob } from "./contract.ts";

export type LocalVacancy = {
  id: string;
  jobRevision: number;
  title: string;
  description?: string;
  sourceUrl: string;
  industry?: string | null;
  location?: string | null;
  workMode?: string | null;
  employmentType?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: "annual" | "monthly" | "weekly" | "daily" | "hourly" | "unknown";
  salaryHoursPerWeek?: number | null;
  salaryDaysPerWeek?: number | null;
  salarySource?: "advertised" | "chatgpt_estimate" | "not_available";
  postedAt?: string | null;
  closesAt?: string | null;
  applicationInstructions?: string | null;
};

function round1(value: number) { return Math.round(value * 10) / 10; }
function fitInputHash(jobId: string, url: string, jobRevision: number) {
  return createHash("sha256").update(JSON.stringify({ engine: MEMORY_FIT_ENGINE_VERSION, rubric: "job-fit-memory-rubric-v1", jobId, url, jobRevision }), "utf8").digest("hex");
}
function cvFamily(text: string): "simulation_cae" | "scientific_software" | "quantitative_data" | "motorsport" {
  const value = text.toLowerCase();
  if (/formula\s*1|formula one|motorsport|race car|racing/.test(value)) return "motorsport";
  if (/data scientist|statistics|quantitative|machine learning|analytics|financial modelling/.test(value)) return "quantitative_data";
  if (/software engineer|software developer|scientific software|python developer|c\+\+/.test(value)) return "scientific_software";
  return "simulation_cae";
}

export function buildMemoryFitAnalysis(input: {
  result: MemoryFitResponseJob;
  vacancy: LocalVacancy;
  preferences: Preferences;
  assessmentAsOf: Date;
}) {
  const { result, vacancy, preferences, assessmentAsOf } = input;
  if (result.job_id !== vacancy.id || result.listing_url !== vacancy.sourceUrl) throw new Error("The Memory-fit result does not belong to this current listing URL.");
  const applicable = MEMORY_FIT_DIMENSIONS.filter((key) => result.components[key].state !== "not_applicable");
  const mandatory: MemoryFitDimension[] = ["technical", "evidence", "role_type"];
  const complete = mandatory.every((key) => result.components[key].state === "assessed")
    && applicable.every((key) => result.components[key].state === "assessed");
  const weight = applicable.reduce((sum, key) => sum + MEMORY_FIT_WEIGHTS[key], 0);
  const fitScore = complete && weight > 0
    ? round1(applicable.reduce((sum, key) => sum + result.components[key].score! * MEMORY_FIT_WEIGHTS[key], 0) / weight)
    : null;
  const possibleConflict = result.eligibility.state === "possible_conflict";
  const memoryUnavailable = result.status === "insufficient_memory"
    || result.memory_status === "unknown"
    || result.memory_status === "insufficient";
  const fitSignal = {
    completeness: complete ? "complete" as const : "partial" as const,
    fit_score: fitScore,
    eligibility: possibleConflict ? "confirmed_conflict" as const : "needs_confirmation" as const,
  };
  const priority = priorityAndRecommendation(fitSignal, {
    title: vacancy.title,
    company: "",
    description: vacancy.description || "",
    source_url: vacancy.sourceUrl,
    industry: vacancy.industry || null,
    location: vacancy.location || null,
    work_mode: vacancy.workMode || null,
    employment_type: vacancy.employmentType || null,
    salary_min: vacancy.salaryMin ?? null,
    salary_max: vacancy.salaryMax ?? null,
    salary_currency: vacancy.salaryCurrency || "GBP",
    salary_period: vacancy.salaryPeriod || "unknown",
    salary_hours_per_week: vacancy.salaryHoursPerWeek ?? null,
    salary_days_per_week: vacancy.salaryDaysPerWeek ?? null,
    salary_source: vacancy.salarySource || "not_available",
    posted_at: vacancy.postedAt || null,
    closes_at: vacancy.closesAt || null,
    application_instructions: vacancy.applicationInstructions || null,
  }, preferences, assessmentAsOf);
  const triage = priority.recommendation === "Recommended" ? "recommend"
    : ["Worth reviewing", "Needs information"].includes(priority.recommendation) ? "maybe" : "reject";
  const limitations = [...result.limitations];
  if (!complete) limitations.unshift("The overall fit score is withheld because ChatGPT Memory is incomplete for one or more applicable categories.");
  limitations.push(memoryUnavailable
    ? "No candidate Memory context was available; JobHuntAI did not send a profile or background."
    : "This assessment used ChatGPT Memory; JobHuntAI did not send your profile or background.");
  const details = Object.fromEntries(MEMORY_FIT_DIMENSIONS.map((key) => [key, result.components[key]]));
  const strengths = result.strengths.map((description) => ({ description, evidenceIds: [] }));
  const weaknesses = MEMORY_FIT_DIMENSIONS.filter((key) => result.components[key].state !== "not_applicable" && (result.components[key].score === null || result.components[key].score < 50))
    .map((key) => ({ description: `${key.replaceAll("_", " ")}: ${result.components[key].explanation}`, severity: result.components[key].score !== null && result.components[key].score! < 25 ? "high" : "medium" }));
  for (const limitation of result.limitations) weaknesses.push({ description: limitation, severity: "medium" });
  return {
    item_result: {
      ...result,
      fit_score: fitScore,
      completeness: complete ? "complete" : "partial",
      applicable_weight: weight,
      input_hash: fitInputHash(vacancy.id, vacancy.sourceUrl, vacancy.jobRevision),
      job_revision: vacancy.jobRevision,
      contract_version: MEMORY_FIT_CONTRACT_VERSION,
      assessment_as_of: assessmentAsOf.toISOString(),
    },
    analysis: {
      contract_version: MEMORY_FIT_CONTRACT_VERSION,
      engine_version: MEMORY_FIT_ENGINE_VERSION,
      input_hash: fitInputHash(vacancy.id, vacancy.sourceUrl, vacancy.jobRevision),
      job_revision: vacancy.jobRevision,
      assessment_as_of: assessmentAsOf.toISOString(),
      fit_score: fitScore,
      priority_score: priority.priority_score,
      fit_components: Object.fromEntries(MEMORY_FIT_DIMENSIONS.map((key) => [key, result.components[key].score])),
      fit_component_details: details,
      assessment_completeness: complete ? "complete" : "partial",
      assessment_limitations: limitations,
      priority_components: priority.components,
      eligibility: possibleConflict ? "eligible_with_concerns" : "unknown",
      eligibility_notes: [result.eligibility.explanation, "Memory-based suggestion only; verify legal or work-authorisation requirements yourself."].filter(Boolean),
      recommended_cv_family: cvFamily(`${vacancy.title} ${vacancy.description || ""}`),
      strengths,
      weaknesses,
      application_strategy: result.summary,
      cover_letter_value: /no cover letter|do not (?:send|include) a cover letter|cover letters? (?:are )?not accepted/i.test(vacancy.applicationInstructions || "") ? "not_accepted" : /cover letter|supporting statement/i.test(vacancy.applicationInstructions || "") ? "high" : "medium",
      evidence_item_ids: [],
      triage,
      triage_reason: priority.recommendation,
      analysis_source: "chatgpt_memory_v4",
    },
  };
}
