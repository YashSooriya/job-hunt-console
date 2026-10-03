export const MEMORY_FIT_ENGINE_VERSION = "job-fit-memory-v4" as const;
export const MEMORY_FIT_REQUEST_VERSION = "job-fit-memory-request-v1" as const;
export const MEMORY_FIT_RESPONSE_VERSION = "job-fit-memory-response-v1" as const;
export const MEMORY_FIT_RUBRIC_VERSION = "job-fit-memory-rubric-v1" as const;
export const MEMORY_FIT_CONTRACT_VERSION = "4.0.0" as const;

export const MAX_MEMORY_FIT_JOBS = 100;
export const MAX_MEMORY_FIT_JOBS_PER_MESSAGE = 5;
// Keep enough room below the bridge's 6,000-character hard maximum for the
// mandatory Testing Mode prefix and small future envelope changes.
export const MAX_MEMORY_FIT_MESSAGE_CHARS = 5_800;
export const MEMORY_FIT_WEIGHTS = {
  technical: 30,
  evidence: 20,
  seniority: 15,
  domain: 15,
  role_type: 10,
  qualification: 10,
} as const;
export type MemoryFitDimension = keyof typeof MEMORY_FIT_WEIGHTS;
export const MEMORY_FIT_DIMENSIONS = Object.keys(MEMORY_FIT_WEIGHTS) as MemoryFitDimension[];
export type MemoryComponentState = "assessed" | "not_applicable" | "insufficient_memory" | "listing_data_missing";
export type MemoryComponent = { score: number | null; state: MemoryComponentState; explanation: string };
export type MemoryFitRequestJob = { job_id: string; listing_url: string };
export type MemoryFitResponseJob = {
  job_id: string;
  listing_url: string;
  status: "assessed" | "insufficient_memory" | "listing_unavailable" | "wrong_listing";
  memory_status: "sufficient" | "partial" | "insufficient" | "unknown";
  components: Record<MemoryFitDimension, MemoryComponent>;
  eligibility: { state: "possible_conflict" | "no_conflict_identified" | "needs_confirmation"; explanation: string };
  summary: string;
  strengths: string[];
  limitations: string[];
};
