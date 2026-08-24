export type CvFamily = "simulation_cae" | "scientific_software" | "quantitative_data" | "motorsport";
export type JobTriage = "auto_prepare" | "recommend" | "maybe" | "reject";
export type EligibilityState = "eligible" | "eligible_with_concerns" | "unknown" | "ineligible";

export type EvidenceLike = {
  id?: string;
  evidenceKey: string;
  category: string;
  claim: string;
  detail?: string | null;
  tags: string[];
  strength: number;
  status: "verified" | "needs_review" | "rejected";
};

export type CandidateProfileLike = {
  facts: Array<{ factKey: string; value: unknown; status: string }>;
  evidence: EvidenceLike[];
  preferences: Record<string, unknown>;
};

export type JobInput = {
  company: string;
  title: string;
  description: string;
  externalJobId?: string | null;
  sourceUrl?: string | null;
  applicationUrl?: string | null;
  location?: string | null;
  workMode?: string | null;
  salaryText?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  postedAt?: string | null;
  closesAt?: string | null;
  employmentType?: string | null;
  atsProvider?: string | null;
  discoverySource?: string | null;
};

export type RequirementAnalysis = {
  text: string;
  type: "essential" | "desirable" | "context" | "eligibility";
  category: string;
  matchScore: number;
  evidenceIds: string[];
};

export type JobAnalysis = {
  contractVersion: "1.0.0";
  analysisSource: "deterministic_v1";
  eligibility: EligibilityState;
  eligibilityNotes: string[];
  fitScore: number;
  priorityScore: number;
  fitComponents: Record<string, number>;
  priorityComponents: Record<string, number>;
  recommendedCvFamily: CvFamily;
  strengths: Array<{ description: string; evidenceIds: string[] }>;
  weaknesses: Array<{ description: string; severity: "low" | "medium" | "high" }>;
  requirements: RequirementAnalysis[];
  applicationStrategy: string;
  coverLetterValue: "high" | "medium" | "low" | "not_accepted";
  evidenceIds: string[];
  triage: JobTriage;
  triageReason: string;
};

export function analyseJob(input: JobInput, profile: CandidateProfileLike, now?: Date): JobAnalysis;
export function calculateFitScore(components: Record<string, number>): number;
export function calculatePriorityScore(fitScore: number, components: Record<string, number>): number;
export function createJobDedupeKey(input: JobInput): string;
export function extractRequirements(description: string): Array<{ text: string; type: RequirementAnalysis["type"]; category: string }>;
