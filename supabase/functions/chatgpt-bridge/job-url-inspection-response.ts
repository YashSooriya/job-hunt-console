import { parseMemoryFitJobResponse, type ExpectedMemoryFitJob } from "../../../apps/web/lib/job-fit-memory-v4/response.ts";
import type { MemoryFitResponseJob } from "../../../apps/web/lib/job-fit-memory-v4/contract.ts";

const STRING_FIELDS = [
  "industry", "application_url", "external_job_id", "location", "work_mode", "salary_text", "salary_currency",
  "salary_confidence", "employment_type", "ats_provider", "summary", "application_instructions", "company_website",
] as const;
const NUMBER_FIELDS = ["salary_min", "salary_max"] as const;
const ARRAY_FIELDS = [
  "salary_basis", "responsibilities", "essential_requirements", "desirable_requirements", "skills", "benefits", "identity_match_fields",
] as const;
const ALLOWED_FIELDS = new Set([
  "request_id", "source_url", "resolved_listing_url", "identity_evidence", "company", "title", "description", ...STRING_FIELDS, ...NUMBER_FIELDS, "salary_source", ...ARRAY_FIELDS,
  "posted_at", "closes_at", "raw_metadata",
]);

export type JobUrlInspectionExtraction = {
  request_id: string;
  source_url: string | null;
  resolved_listing_url: string | null;
  identity_match_fields: string[];
  identity_evidence: string | null;
  company: string;
  title: string;
  industry: string | null;
  description: string;
  application_url: string | null;
  external_job_id: string | null;
  location: string | null;
  work_mode: string | null;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_source: "advertised" | "chatgpt_estimate" | "not_available";
  salary_confidence: "high" | "medium" | "low" | null;
  salary_basis: string[];
  posted_at: string | null;
  closes_at: string | null;
  employment_type: string | null;
  ats_provider: string | null;
  summary: string | null;
  responsibilities: string[];
  essential_requirements: string[];
  desirable_requirements: string[];
  skills: string[];
  benefits: string[];
  application_instructions: string | null;
  company_website: string | null;
  raw_metadata: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ChatGPT did not return a JSON object.");
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, key: string, maxLength = 4000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string or null.`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${key} is too long.`);
  return text || null;
}

function httpUrl(value: string | null, key: string): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a complete HTTP or HTTPS URL.`); }
  if (!(["https:", "http:"].includes(url.protocol))) throw new Error(`${key} must be a complete HTTP or HTTPS URL.`);
  url.hash = "";
  return url.toString();
}

function canonicalResolvedListingUrl(value: string | null) {
  if (!value) return null;
  const parsed = new URL(value);
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function optionalDate(value: unknown, key: string): string | null {
  const input = optionalText(value, key, 100);
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error(`${key} must be an ISO 8601 date or null.`);
  return date.toISOString();
}

function stringArray(value: unknown, key: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${key} must be an array of up to 100 strings.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length > 1000) throw new Error(`${key}[${index}] must be a string of at most 1,000 characters.`);
    return entry.trim();
  }).filter(Boolean);
}

function nullableNumber(value: unknown, key: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) throw new Error(`${key} must be a non-negative number or null.`);
  return number;
}

const CHATGPT_CONTENT_REFERENCE = /:chatgpt-content-reference\{index="\d+"\}/g;

function parseJsonCandidate(text: string) {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

function parsedJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200_000) throw new Error("ChatGPT returned an empty or oversized listing result.");
  try { return parseJsonCandidate(trimmed); }
  catch {
    // ChatGPT can render source citations as a component marker whose quoted
    // index is not JSON-escaped when the Bridge captures rendered text. Remove
    // only that exact known marker from a working copy, then keep the normal
    // strict JSON and schema validation below. The stored assistant response
    // remains unchanged for provenance and future recovery.
    const citationCleaned = trimmed.replace(CHATGPT_CONTENT_REFERENCE, "");
    if (citationCleaned !== trimmed) {
      try { return parseJsonCandidate(citationCleaned); }
      catch { /* Reject all other malformed response shapes. */ }
    }
    throw new Error("ChatGPT's listing response was not one valid JSON object.");
  }
}

export function parseJobUrlInspectionResponse(text: string, requestId: string, expectedSourceUrl?: string): JobUrlInspectionExtraction {
  const value = record(parsedJson(text));
  for (const key of Object.keys(value)) if (!ALLOWED_FIELDS.has(key)) throw new Error(`ChatGPT returned an unsupported listing field: ${key}.`);
  if (value.request_id !== requestId) throw new Error("The listing result did not match this import request. No job was saved.");

  const company = optionalText(value.company, "company", 300);
  const title = optionalText(value.title, "title", 500);
  const description = optionalText(value.description, "description", 60_000);
  if (!company || !title || !description || description.length < 40) {
    throw new Error("ChatGPT could not verify the exact public listing well enough to save a vacancy.");
  }

  for (const key of STRING_FIELDS) {
    if (key === "salary_confidence" && value[key] != null && !["high", "medium", "low"].includes(String(value[key]))) {
      throw new Error("salary_confidence must be high, medium, low, or null.");
    }
  }
  const salarySource = value.salary_source;
  if (!["advertised", "chatgpt_estimate", "not_available"].includes(String(salarySource))) {
    throw new Error("salary_source must be advertised, chatgpt_estimate, or not_available.");
  }
  const rawMetadata = value.raw_metadata === undefined ? {} : record(value.raw_metadata);
  if (JSON.stringify(rawMetadata).length > 20_000) throw new Error("raw_metadata is too large.");
  const arrays = Object.fromEntries(ARRAY_FIELDS.map((key) => [key, stringArray(value[key], key)]));
  const salaryBasis = arrays.salary_basis as string[];
  if (salarySource === "chatgpt_estimate" && salaryBasis.length === 0) throw new Error("A salary estimate must include its evidence basis.");
  const salaryText = optionalText(value.salary_text, "salary_text", 500);
  const salaryMin = nullableNumber(value.salary_min, "salary_min");
  const salaryMax = nullableNumber(value.salary_max, "salary_max");
  if (salarySource === "chatgpt_estimate" && (!salaryText || !/estimated/i.test(salaryText) || !/not employer-advertised/i.test(salaryText))) {
    throw new Error("An estimated salary must be clearly labelled as estimated and not employer-advertised.");
  }
  if (salarySource === "advertised" && !salaryText && salaryMin === null && salaryMax === null) {
    throw new Error("An advertised salary needs an amount stated by the employer.");
  }
  if (salarySource === "not_available" && (salaryText || salaryMin !== null || salaryMax !== null)) {
    throw new Error("An unavailable salary must not include an amount or salary text.");
  }
  const sourceUrl = httpUrl(optionalText(value.source_url, "source_url", 2_000), "source_url");
  const resolvedListingUrl = canonicalResolvedListingUrl(httpUrl(
    optionalText(value.resolved_listing_url, "resolved_listing_url", 2_000), "resolved_listing_url",
  ));
  const identityEvidence = optionalText(value.identity_evidence, "identity_evidence", 1_000);
  const identityMatchFields = arrays.identity_match_fields as string[];
  if (expectedSourceUrl) {
    if (sourceUrl !== expectedSourceUrl) throw new Error("The extracted listing did not echo the exact requested source URL.");
    if (resolvedListingUrl && resolvedListingUrl !== expectedSourceUrl) {
      const matches = new Set(identityMatchFields.map((field) => field.toLowerCase()));
      const sufficientlyMatched = matches.has("company") && matches.has("title")
        && (matches.has("external_job_id") || matches.has("location"));
      if (!sufficientlyMatched || !identityEvidence || identityEvidence.length < 20) {
        throw new Error("The alternate listing URL did not include sufficient same-vacancy identity evidence.");
      }
    }
    for (const [field, sourceField, evidenceField] of [
      ["posted_at", "posted_at_source_url", "posted_at_evidence"],
      ["closes_at", "closes_at_source_url", "closes_at_evidence"],
    ]) {
      if (value[field] != null && value[field] !== "") {
        const evidenceUrl = httpUrl(optionalText(rawMetadata[sourceField], sourceField, 2_000), sourceField);
        const evidenceText = optionalText(rawMetadata[evidenceField], evidenceField, 500);
        if (!evidenceUrl || !evidenceText || evidenceText.length < 4) throw new Error(`${field} requires source URL and supporting date evidence.`);
      }
    }
  }

  const result: JobUrlInspectionExtraction = {
    request_id: requestId,
    source_url: sourceUrl,
    resolved_listing_url: resolvedListingUrl,
    identity_match_fields: identityMatchFields,
    identity_evidence: identityEvidence,
    company,
    title,
    industry: optionalText(value.industry, "industry", 300),
    description,
    application_url: httpUrl(optionalText(value.application_url, "application_url"), "application_url"),
    external_job_id: optionalText(value.external_job_id, "external_job_id", 300),
    location: optionalText(value.location, "location", 500),
    work_mode: optionalText(value.work_mode, "work_mode", 200),
    salary_text: salaryText,
    salary_min: salaryMin,
    salary_max: salaryMax,
    salary_currency: optionalText(value.salary_currency, "salary_currency", 10),
    salary_source: salarySource as JobUrlInspectionExtraction["salary_source"],
    salary_confidence: optionalText(value.salary_confidence, "salary_confidence", 10) as JobUrlInspectionExtraction["salary_confidence"],
    salary_basis: salaryBasis,
    posted_at: optionalDate(value.posted_at, "posted_at"),
    closes_at: optionalDate(value.closes_at, "closes_at"),
    employment_type: optionalText(value.employment_type, "employment_type", 200),
    ats_provider: optionalText(value.ats_provider, "ats_provider", 200),
    summary: optionalText(value.summary, "summary", 4000),
    responsibilities: arrays.responsibilities as string[],
    essential_requirements: arrays.essential_requirements as string[],
    desirable_requirements: arrays.desirable_requirements as string[],
    skills: arrays.skills as string[],
    benefits: arrays.benefits as string[],
    application_instructions: optionalText(value.application_instructions, "application_instructions", 4000),
    company_website: httpUrl(optionalText(value.company_website, "company_website"), "company_website"),
    raw_metadata: rawMetadata,
  };
  if (result.salary_min !== null && result.salary_max !== null && result.salary_max < result.salary_min) {
    throw new Error("The returned salary maximum is below the minimum.");
  }
  return result;
}

export type JobUrlInspectionBatchResult =
  | { requestId: string; status: "found"; extraction: JobUrlInspectionExtraction }
  | { requestId: string; status: "unavailable" | "not_a_job_listing"; reason: string };

export type CombinedJobUrlInspectionResult =
  | { requestId: string; status: "found"; extraction: JobUrlInspectionExtraction; fit: MemoryFitResponseJob | null; fitIssue: "missing_result" | "invalid_response" | "wrong_listing" | "listing_unavailable" | null; fitError: string | null }
  | { requestId: string; status: "unavailable" | "not_a_job_listing" | "wrong_listing"; reason: string };
export type CombinedJobUrlInspectionExpectation = {
  batchId: string;
  assessmentAsOf: string;
  items: Array<{ requestId: string; sourceUrl: string }>;
};
export type ParsedCombinedJobUrlInspection = { results: Map<string, CombinedJobUrlInspectionResult>; warnings: string[] };

/** Validate the one-turn extraction + Memory-fit response, retaining independent siblings. */
export function parseCombinedJobUrlInspectionResponse(text: string, expected: CombinedJobUrlInspectionExpectation): ParsedCombinedJobUrlInspection {
  const expectedIds = expected.items.map((item) => item.requestId);
  if (!expectedIds.length || expectedIds.length > 10 || new Set(expectedIds).size !== expectedIds.length) {
    throw new Error("The combined inspection batch has an invalid set of request IDs.");
  }
  const envelope = record(parsedJson(text));
  const envelopeKeys = ["schema_version", "batch_id", "assessment_as_of", "results"];
  if (Object.keys(envelope).length !== envelopeKeys.length || envelopeKeys.some((key) => !Object.hasOwn(envelope, key))) {
    throw new Error("The combined response envelope has missing or unsupported fields.");
  }
  if (envelope.schema_version !== "job-url-memory-fit-batch-v1" || envelope.batch_id !== expected.batchId) {
    throw new Error("The combined response does not match the exact URL-import batch.");
  }
  if (typeof envelope.assessment_as_of !== "string" || Date.parse(envelope.assessment_as_of) !== Date.parse(expected.assessmentAsOf)) {
    throw new Error("The combined response assessment time does not match the dispatched batch.");
  }
  if (!Array.isArray(envelope.results) || envelope.results.length > expectedIds.length + 5) {
    throw new Error("The combined response results list is invalid or oversized.");
  }
  const byId = new Map(expected.items.map((item) => [item.requestId, item]));
  const counts = new Map<string, number>();
  const warnings: string[] = [];
  for (const raw of envelope.results) {
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const id = typeof row.request_id === "string" ? row.request_id : "";
    if (!byId.has(id)) { warnings.push("The assistant returned an extra result that was not in this batch; it was ignored."); continue; }
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const results = new Map<string, CombinedJobUrlInspectionResult>();
  for (const raw of envelope.results) {
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const id = typeof row.request_id === "string" ? row.request_id : "";
    const request = byId.get(id);
    if (!request || results.has(id)) continue;
    if ((counts.get(id) || 0) > 1) {
      results.set(id, { requestId: id, status: "unavailable", reason: "The assistant returned this request more than once. No result was applied." });
      continue;
    }
    const allowed = ["request_id", "source_url", "status", "reason", "job", "fit"];
    if (Object.keys(row).length !== allowed.length || allowed.some((key) => !Object.hasOwn(row, key))) {
      results.set(id, { requestId: id, status: "unavailable", reason: "The assistant returned an incomplete result envelope for this listing." });
      continue;
    }
    if (row.source_url !== request.sourceUrl) {
      results.set(id, { requestId: id, status: "wrong_listing", reason: "The result URL did not match the exact URL requested." });
      continue;
    }
    if (row.status === "unavailable" || row.status === "not_a_job_listing" || row.status === "wrong_listing") {
      // A malformed sibling explanation is an entry-level defect. Keep it
      // bounded and isolated so a valid sibling in the same exact response
      // can still be saved. The batch identity/envelope checks above remain
      // fatal because they cannot be safely attributed to one request.
      const reason = typeof row.reason === "string" && row.reason.trim().length <= 1_800
        ? row.reason.trim() || null
        : null;
      if (!reason || row.job !== null || row.fit !== null) {
        results.set(id, { requestId: id, status: "unavailable", reason: "The unavailable result did not include a safe, bounded explanation." });
      } else results.set(id, { requestId: id, status: row.status, reason });
      continue;
    }
    if (row.status !== "found" || row.reason !== null || !row.job || typeof row.job !== "object" || Array.isArray(row.job)) {
      results.set(id, { requestId: id, status: "unavailable", reason: "The extracted listing result was incomplete or unsupported." });
      continue;
    }
    let extraction: JobUrlInspectionExtraction;
    try {
      extraction = parseJobUrlInspectionResponse(JSON.stringify(row.job), id, request.sourceUrl);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The extracted listing result was invalid.";
      results.set(id, { requestId: id, status: /identity|requested source URL|same-vacancy/i.test(message) ? "wrong_listing" : "unavailable", reason: `The listing could not be saved safely: ${message}` });
      continue;
    }

    let fit: MemoryFitResponseJob | null = null;
    let fitIssue: "missing_result" | "invalid_response" | "wrong_listing" | "listing_unavailable" | null = null;
    let fitError: string | null = null;
    if (!row.fit || typeof row.fit !== "object" || Array.isArray(row.fit)) {
      fitIssue = "missing_result";
      fitError = "The listing was extracted, but its initial Memory-fit result was missing.";
    } else {
      try {
        fit = parseMemoryFitJobResponse(row.fit, { job_id: id, listing_url: request.sourceUrl } satisfies ExpectedMemoryFitJob);
        if (fit.status === "listing_unavailable" || fit.status === "wrong_listing") {
          fitIssue = fit.status;
          fitError = fit.summary || "The fit result could not confirm the exact listing.";
        }
      } catch (cause) {
        fitIssue = "invalid_response";
        fitError = cause instanceof Error ? cause.message : "The initial Memory-fit result was malformed.";
      }
    }
    results.set(id, { requestId: id, status: "found", extraction, fit, fitIssue, fitError });
  }
  for (const request of expected.items) if (!results.has(request.requestId)) {
    results.set(request.requestId, { requestId: request.requestId, status: "unavailable", reason: "The assistant omitted this listing result. The original message was not resent." });
  }
  return { results, warnings };
}

/**
 * Parse one assistant response for a whole URL batch. Every supplied request
 * id is accounted for, and each extraction is independently validated so one
 * inaccessible listing does not discard valid results for its siblings.
 */
export function parseJobUrlInspectionBatchResponse(text: string, expectedRequestIds: string[]): Map<string, JobUrlInspectionBatchResult> {
  if (!expectedRequestIds.length || expectedRequestIds.length > 10 || new Set(expectedRequestIds).size !== expectedRequestIds.length) {
    throw new Error("The inspection batch has an invalid set of request IDs.");
  }
  const expected = new Set(expectedRequestIds);
  const envelope = record(parsedJson(text));
  if (Object.keys(envelope).some((key) => key !== "results") || !Array.isArray(envelope.results) || envelope.results.length > 10) {
    throw new Error("ChatGPT's batch response must contain only a results array of at most ten entries.");
  }

  const results = new Map<string, JobUrlInspectionBatchResult>();
  for (const raw of envelope.results) {
    const item = record(raw);
    const allowed = new Set(["request_id", "status", "reason", "job"]);
    for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`ChatGPT returned an unsupported batch result field: ${key}.`);
    if (typeof item.request_id !== "string" || !expected.has(item.request_id)) {
      throw new Error("ChatGPT returned a result for an unrequested listing.");
    }
    const requestId = item.request_id;
    if (results.has(requestId)) throw new Error("ChatGPT returned duplicate results for one listing.");

    if (item.status === "found") {
      if (item.reason !== null || !item.job || typeof item.job !== "object" || Array.isArray(item.job)) {
        results.set(requestId, { requestId, status: "unavailable", reason: "ChatGPT returned an incomplete result envelope for this listing." });
        continue;
      }
      try {
        const extraction = parseJobUrlInspectionResponse(JSON.stringify(item.job), requestId);
        results.set(requestId, { requestId, status: "found", extraction });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "The structured listing result was invalid.";
        results.set(requestId, { requestId, status: "unavailable", reason: `This listing's result could not be saved safely: ${message}` });
      }
      continue;
    }

    if (item.status !== "unavailable" && item.status !== "not_a_job_listing") {
      throw new Error("Each batch result must be found, unavailable, or not_a_job_listing.");
    }
    if (item.job !== null) throw new Error("A listing marked unavailable must not include extracted job data.");
    const reason = optionalText(item.reason, "reason", 1800);
    if (!reason) throw new Error("ChatGPT must explain why an unavailable listing was not imported.");
    results.set(requestId, { requestId, status: item.status, reason });
  }

  for (const requestId of expectedRequestIds) {
    if (!results.has(requestId)) results.set(requestId, {
      requestId,
      status: "unavailable",
      reason: "ChatGPT omitted a structured result for this listing. The original message was not resent.",
    });
  }
  return results;
}
