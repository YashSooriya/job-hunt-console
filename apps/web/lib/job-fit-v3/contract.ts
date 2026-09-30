/** Shared application contract; no browser, database or bridge transport dependency. */
export const INPUT_VERSION = "job-fit-input-v3.1";
export const RESPONSE_VERSION = "job-fit-assessment-v3.1";
export const RUBRIC_VERSION = "job-fit-rubric-v3.0";
export const ENGINE_VERSION = "job-fit-v3";
export const PRIORITY_VERSION = "job-priority-v3.0";
export const FIT_WEIGHTS = { technical: 30, evidence: 20, seniority: 15, domain: 15, role_type: 10, qualification: 10 } as const;
export const MATCH_VALUES = { direct: 100, strong_transfer: 75, partial: 50, weak_transfer: 25, not_evidenced: 0, conflict: 0, not_assessable: null } as const;
export type Dimension = "technical" | "seniority" | "domain" | "role_type" | "qualification" | "eligibility";
export type Match = keyof typeof MATCH_VALUES;
export type RecordType = "employment" | "education" | "skill" | "project" | "publication" | "certification" | "fact" | "evidence";
export type BackgroundRecord = { reference: string; record_type: RecordType; source_record_id: string; verification_status: "verified"; content: Record<string, unknown>; source_reference: string | null };
export type Criterion = { reference: string; text: string; importance: "essential" | "desirable" | "responsibility" | "context"; dimension: Dimension; source_field: string };
export type CriterionSourceUnit = { reference: string; text: string; importance: Criterion["importance"]; source_field: string; source_index: number };
export type Vacancy = { title: string; company: string; description: string; summary?: string | null; industry?: string | null; responsibilities?: string[]; essential_requirements?: string[]; desirable_requirements?: string[]; skills?: string[]; location?: string | null; work_mode?: string | null; employment_type?: string | null; application_instructions?: string | null; salary_min?: number | null; salary_max?: number | null; salary_currency?: string | null; salary_period?: "annual" | "monthly" | "weekly" | "daily" | "hourly" | "unknown"; salary_hours_per_week?: number | null; salary_days_per_week?: number | null; salary_source?: "advertised" | "chatgpt_estimate" | "not_available"; salary_confidence?: string | null; salary_text?: string | null; salary_basis?: string[]; posted_at?: string | null; closes_at?: string | null; source_url?: string | null; [key: string]: unknown };
export type FitInput = { schema_version: typeof INPUT_VERSION; assessment_request_id: string; job_id: string; job_snapshot_id: string; job_revision: number; profile_id: string; profile_revision: number; profile_snapshot_hash: string; vacancy_snapshot_hash: string; rubric_version: typeof RUBRIC_VERSION; candidate_background: BackgroundRecord[]; vacancy: Vacancy; criteria_source_units: CriterionSourceUnit[]; criteria: Criterion[] };
export type CriterionFinding = { requirement_reference: string; match: Match; evidence: Array<{ reference: string; quote: string }>; explanation: string };
export type EligibilityFinding = { requirement_reference: string; state: "confirmed_eligible" | "confirmed_conflict" | "needs_confirmation"; evidence: Array<{ reference: string; quote: string }>; explanation: string };
export type FitResponse = { schema_version: typeof RESPONSE_VERSION; assessment_request_id: string; job_id: string; profile_snapshot_hash: string; vacancy_snapshot_hash: string; rubric_version: typeof RUBRIC_VERSION; criteria: CriterionFinding[]; dimension_applicability: Record<"seniority" | "domain" | "qualification", "applicable" | "not_specified">; eligibility_findings: EligibilityFinding[]; summary: string; limitations: string[] };
export type Component = { score: number | null; state: "assessed" | "not_specified" | "cannot_assess"; explanation: string };
export type FitResult = { engine_version: typeof ENGINE_VERSION; rubric_version: typeof RUBRIC_VERSION; completeness: "complete" | "partial"; fit_score: number | null; applicable_weight: number; components: Record<keyof typeof FIT_WEIGHTS, Component>; criteria: CriterionFinding[]; summary: string; limitations: string[]; eligibility: "confirmed_eligible" | "confirmed_conflict" | "needs_confirmation" | "no_condition_identified"; eligibility_findings: EligibilityFinding[]; seniority_calculations: SeniorityCalculation[] };
export type SeniorityCalculation = {
  requirement_reference: string;
  cited_employment_references: string[];
  assessment_as_of: string;
  established_days: number | null;
  required_years: number;
  required_days: number;
  established: boolean | null;
};
export function round1(value: number) { return Math.round(value * 10) / 10; }
export function criterionWeight(c: Criterion) { return c.importance === "essential" ? 2 : 1; }
