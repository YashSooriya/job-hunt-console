import { normalizeJobListingUrl } from "../job-url-inspection.ts";
import { parseJobUrlInspectionResponse, type JobUrlInspectionExtraction } from "../job-url-inspection-response.ts";
import { parseJobPoolSnapshotProof, type ExpectedJobPoolSnapshot } from "../job-pool-sheet-contract.ts";

export type ManualSearchResult = {
  position: number;
  status: "found" | "unavailable" | "not_a_job_listing";
  source_url: string | null;
  reason: string | null;
  extraction: JobUrlInspectionExtraction | null;
};

export type ManualSearchResponse = {
  run_id: string;
  job_pool_snapshot?: ExpectedJobPoolSnapshot;
  jobs_checked: number;
  summary: string;
  results: ManualSearchResult[];
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function parseJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200_000) throw new Error("The job-search response is empty or too large to import.");
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try { return JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { throw new Error("The job-search response was not one valid JSON object. The original ChatGPT message was not resent."); }
}

function boundedText(value: unknown, label: string, max: number, required = false) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${label} is too long.`);
  if (!result && required) throw new Error(`${label} is required.`);
  return result || null;
}

function sourceUrl(value: unknown, required: boolean) {
  const raw = boundedText(value, "source_url", 2000, required);
  if (!raw) return null;
  try { return normalizeJobListingUrl(raw); }
  catch { throw new Error("Every job result source_url must be a complete HTTP or HTTPS listing URL."); }
}

/**
 * Parse a strictly run-bound ChatGPT search response. The nested job fields
 * share the exact allow-list and validation used by URL imports so searches
 * and link imports create the same listing shape.
 */
export function parseManualSearchResponse(text: string, expectedRunId: string, expectedPoolSnapshot?: ExpectedJobPoolSnapshot): ManualSearchResponse {
  const response = record(parseJson(text), "The job-search response");
  const allowedEnvelopeKeys = new Set(["run_id", "job_pool_snapshot", "jobs_checked", "summary", "results"]);
  for (const key of Object.keys(response)) if (!allowedEnvelopeKeys.has(key)) throw new Error(`The job-search response included unsupported field ${key}.`);
  if (response.run_id !== expectedRunId) throw new Error("The job-search result did not belong to this manual search. No vacancy was saved.");
  let poolProof: ExpectedJobPoolSnapshot | undefined;
  if (expectedPoolSnapshot) {
    poolProof = parseJobPoolSnapshotProof(response.job_pool_snapshot, expectedPoolSnapshot);
  } else if (response.job_pool_snapshot !== undefined) {
    throw new Error("The search run has no stored Job Pool Sheet snapshot to validate. No vacancy was saved.");
  }
  if (!Number.isInteger(response.jobs_checked) || Number(response.jobs_checked) < 0 || Number(response.jobs_checked) > 1000) {
    throw new Error("jobs_checked must be a whole number from 0 to 1,000.");
  }
  const summary = boundedText(response.summary, "summary", 2000, true)!;
  if (!Array.isArray(response.results) || response.results.length > 10) throw new Error("results must be an array of no more than 10 jobs.");
  if (Number(response.jobs_checked) < response.results.length) throw new Error("jobs_checked cannot be lower than the number of returned results.");

  const results = response.results.map((raw, index): ManualSearchResult => {
    const item = record(raw, `results[${index}]`);
    const allowedResultKeys = new Set(["status", "source_url", "reason", "job"]);
    for (const key of Object.keys(item)) if (!allowedResultKeys.has(key)) throw new Error(`results[${index}] included unsupported field ${key}.`);
    const status = item.status;
    if (status !== "found" && status !== "unavailable" && status !== "not_a_job_listing") {
      throw new Error(`results[${index}].status must be found, unavailable, or not_a_job_listing.`);
    }
    const url = sourceUrl(item.source_url, status === "found");
    if (status === "found") {
      const job = record(item.job, `results[${index}].job`);
      // A synthetic id satisfies the shared listing parser's request-binding
      // field. The actual run and dispatch are independently bound above.
      const inspectionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const extraction = parseJobUrlInspectionResponse(JSON.stringify({ ...job, request_id: inspectionId }), inspectionId);
      return { position: index + 1, status, source_url: url, reason: boundedText(item.reason, `results[${index}].reason`, 1000), extraction };
    }
    const reason = boundedText(item.reason, `results[${index}].reason`, 1000, true)!;
    if (item.job !== undefined) throw new Error(`results[${index}] must not include job data unless status is found.`);
    return { position: index + 1, status, source_url: url, reason, extraction: null };
  });

  return { run_id: expectedRunId, ...(poolProof ? { job_pool_snapshot: poolProof } : {}), jobs_checked: Number(response.jobs_checked), summary, results };
}
