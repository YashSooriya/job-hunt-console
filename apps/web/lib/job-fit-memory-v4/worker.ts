import { createHash } from "node:crypto";
import type { Preferences } from "../job-fit-v3/priority.ts";
import { buildMemoryFitAnalysis, type LocalVacancy } from "./analysis.ts";
import { MEMORY_FIT_RUBRIC_VERSION } from "./contract.ts";
import { parseMemoryFitResponse, type ExpectedMemoryFitJob } from "./response.ts";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function rows(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.map(record) : [];
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isMemoryFitPersistenceIntegrityFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.startsWith("The saved captured response hash does not match.")
    || message.startsWith("The saved Memory-fit assessment date is invalid.");
}

/**
 * Convert one database-captured exact Bridge turn to its persisted job results.
 * The same pure builder is used by the foreground route and the minute worker,
 * so both paths validate the same envelope and compute fit/priority locally.
 */
export function buildMemoryFitChunkPersistence(input: {
  batch: Record<string, any>;
  chunk: Record<string, any>;
  items: Array<Record<string, any>>;
  jobs?: Array<Record<string, any>>;
  preferences?: Record<string, any>;
  contextRows?: Array<Record<string, any>>;
}) {
  const { batch, chunk } = input;
  const capturedResponse = typeof chunk.captured_response === "string" ? chunk.captured_response : "";
  if (!capturedResponse || typeof chunk.captured_response_hash !== "string"
    || sha256(capturedResponse) !== chunk.captured_response_hash) {
    throw new Error("The saved captured response hash does not match. No ChatGPT message was sent.");
  }

  const items = rows(input.items).sort((a, b) => (chunk.job_ids || []).indexOf(a.job_id) - (chunk.job_ids || []).indexOf(b.job_id));
  const expected: ExpectedMemoryFitJob[] = items.map((item) => ({ job_id: item.job_id, listing_url: item.listing_url }));
  const expectedEnvelope = {
    requestId: String(batch.request_id),
    batchId: String(batch.id),
    rubricVersion: MEMORY_FIT_RUBRIC_VERSION,
    assessmentAsOf: String(batch.assessment_as_of),
    jobs: expected,
  };

  let parsed: ReturnType<typeof parseMemoryFitResponse>;
  try {
    parsed = parseMemoryFitResponse(capturedResponse, expectedEnvelope);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The captured ChatGPT response could not be parsed.";
    return {
      malformedEnvelope: true,
      error: message,
      results: expected.map((item) => ({ job_id: item.job_id, state: "invalid_response", error_message: message })),
    };
  }

  const contextByJob = new Map<string, Record<string, any>>();
  for (const context of rows(input.contextRows)) {
    const item = record(context.item);
    if (typeof item.job_id === "string") contextByJob.set(item.job_id, context);
  }
  const jobsById = new Map(rows(input.jobs).map((job) => [job.id, job]));
  const resultsById = new Map(parsed.results.map((result) => [result.job_id, result]));
  const issuesById = new Map(parsed.issues.map((issue) => [issue.job_id, issue]));
  const preferences = record(input.preferences) as Preferences;
  const assessmentAsOf = new Date(String(batch.assessment_as_of));
  if (!Number.isFinite(assessmentAsOf.getTime())) throw new Error("The saved Memory-fit assessment date is invalid.");
  const persistence: Array<Record<string, any>> = [];

  for (const item of items) {
    const result = resultsById.get(item.job_id);
    if (!result) {
      const issue = issuesById.get(item.job_id);
      persistence.push({ job_id: item.job_id, state: issue?.state || "missing_result", error_message: issue?.message || "ChatGPT omitted this job result." });
      continue;
    }

    const context = contextByJob.get(item.job_id);
    const job = context ? record(context.job) : jobsById.get(item.job_id) || {};
    const snapshot = context ? record(context.snapshot) : record(input.contextRows?.find((row) => record(row.job).id === item.job_id)?.snapshot);
    const expectedJob = expected.find((candidate) => candidate.job_id === item.job_id);
    const currentUrl = job.source_url || job.application_url;
    if (!job.id || !expectedJob || Number(job.analysis_revision) !== Number(item.job_revision) || currentUrl !== item.listing_url) {
      persistence.push({ job_id: item.job_id, state: "invalid_response", error_message: "This saved listing changed while ChatGPT was analysing it. Run a fresh Memory-only analysis; this result was not applied." });
      continue;
    }

    const extracted = record(record(snapshot.raw_metadata).listing_extraction || snapshot.listing_extraction);
    const vacancy: LocalVacancy = {
      id: job.id,
      jobRevision: Number(job.analysis_revision),
      title: job.title,
      description: String(snapshot.description_text || ""),
      sourceUrl: item.listing_url,
      industry: job.industry || null,
      location: job.location_text || null,
      workMode: job.work_mode || null,
      employmentType: job.employment_type || null,
      salaryMin: job.salary_min == null ? null : Number(job.salary_min),
      salaryMax: job.salary_max == null ? null : Number(job.salary_max),
      salaryCurrency: job.salary_currency || "GBP",
      salaryPeriod: extracted.salary_period || "unknown",
      salaryHoursPerWeek: extracted.salary_hours_per_week == null ? null : Number(extracted.salary_hours_per_week),
      salaryDaysPerWeek: extracted.salary_days_per_week == null ? null : Number(extracted.salary_days_per_week),
      salarySource: extracted.salary_source || (job.salary_text || job.salary_min != null || job.salary_max != null ? "advertised" : "not_available"),
      postedAt: job.posted_at || null,
      closesAt: job.closes_at || null,
      applicationInstructions: extracted.application_instructions || null,
    };
    const built = buildMemoryFitAnalysis({ result, vacancy, preferences, assessmentAsOf });
    persistence.push({ job_id: item.job_id, state: result.status === "insufficient_memory" ? "insufficient_memory" : "assessed", result: built.item_result, analysis: built.analysis });
  }

  return { malformedEnvelope: false, results: persistence };
}
