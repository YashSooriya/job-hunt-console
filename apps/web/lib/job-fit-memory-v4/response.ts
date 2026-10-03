import {
  MEMORY_FIT_DIMENSIONS,
  MEMORY_FIT_RESPONSE_VERSION,
  MEMORY_FIT_RUBRIC_VERSION,
  type MemoryComponentState,
  type MemoryComponent,
  type MemoryFitDimension,
  type MemoryFitResponseJob,
} from "./contract.ts";

export type ExpectedMemoryFitJob = { job_id: string; listing_url: string };
export type MemoryFitItemIssue = { job_id: string; listing_url: string; state: "missing_result" | "invalid_response" | "wrong_listing" | "listing_unavailable"; message: string };
export type ParsedMemoryFitResponse = { results: MemoryFitResponseJob[]; issues: MemoryFitItemIssue[] };

type ExpectedEnvelope = { requestId: string; batchId: string; rubricVersion: string; assessmentAsOf: string; jobs: ExpectedMemoryFitJob[] };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has missing or unsupported fields.`);
  }
}
function boundedText(value: unknown, label: string, max: number, allowEmpty = false) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`${label} is missing or too long.`);
  return value.trim();
}
function stringList(value: unknown, label: string, maxItems: number, maxText: number) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be a list of at most ${maxItems} items.`);
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, maxText));
}
function escapeUnescapedStringQuotes(value: string) {
  let inString = false;
  let escaped = false;
  let changed = false;
  let output = "";
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      let next = i + 1;
      while (next < value.length && /\s/.test(value[next])) next++;
      let afterContainer = next + 1;
      while (afterContainer < value.length && /\s/.test(value[afterContainer])) afterContainer++;
      const closesContainer = ["}", "]"].includes(value[next]);
      const containerHasValidJsonFollower = afterContainer >= value.length || [",", "}", "]"].includes(value[afterContainer]);
      const embeddedQuoteBeforeLiteralContainer = closesContainer && !containerHasValidJsonFollower;
      const delimiter = next >= value.length || [",", ":", "}", "]"].includes(value[next]);
      if (!delimiter || embeddedQuoteBeforeLiteralContainer) {
        // Adjacent quotes after an otherwise complete JSON string are just as
        // likely to signal a missing comma as a literal quote. Fail closed
        // instead of silently repairing structurally ambiguous JSON.
        if (!embeddedQuoteBeforeLiteralContainer
          && (value[next] === '"' || !/[A-Za-z0-9]/.test(value[next] || ""))) return null;
        // ChatGPT occasionally includes a literal quote in free text instead
        // of escaping it. Repair only quotes that cannot close a JSON string;
        // the complete envelope and strict schema are validated afterwards.
        output += "\\\"";
        changed = true;
      } else {
        output += character;
        inString = false;
      }
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 0x20) {
      output += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      changed = true;
      continue;
    }
    output += character;
  }
  return changed ? output : null;
}
function parseObject(raw: string) {
  if (raw.length > 100_000) throw new Error("The captured Memory-fit response is too large to process.");
  const text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = fence ? fence[1].trim() : text;
  try { return object(JSON.parse(candidate), "The ChatGPT response"); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("The ChatGPT response")) throw error;
    const repaired = escapeUnescapedStringQuotes(candidate);
    if (repaired) {
      try { return object(JSON.parse(repaired), "The ChatGPT response"); }
      catch (repairError) {
        if (repairError instanceof Error && repairError.message.startsWith("The ChatGPT response")) throw repairError;
      }
    }
    throw new Error("ChatGPT's Memory-fit response was not one valid JSON object. The captured turn was retained; the original message was not resent.");
  }
}

function component(value: unknown, dimension: MemoryFitDimension): MemoryComponent {
  const row = object(value, `Component ${dimension}`);
  exactKeys(row, ["score", "state", "explanation"], `Component ${dimension}`);
  const score = row.score;
  const state = row.state;
  const explanation = boundedText(row.explanation, `${dimension} explanation`, 400);
  if (!(["assessed", "not_applicable", "insufficient_memory", "listing_data_missing"] as unknown[]).includes(state)) throw new Error(`Component ${dimension} has an unsupported state.`);
  if (state === "assessed") {
    if (typeof score !== "number" || ![0, 25, 50, 75, 100].includes(score)) throw new Error(`Component ${dimension} needs a calibrated score.`);
    return { score, state, explanation };
  }
  if (score !== null) throw new Error(`Component ${dimension} must use null when its state is ${String(state)}.`);
  return { score: null, state: state as MemoryComponentState, explanation };
}

function validateRow(value: unknown, expected: ExpectedMemoryFitJob): MemoryFitResponseJob {
  const row = object(value, "A job result");
  exactKeys(row, ["job_id", "listing_url", "status", "memory_status", "components", "eligibility", "summary", "strengths", "limitations"], "A job result");
  const status = row.status;
  const memoryStatus = row.memory_status;
  if (row.job_id !== expected.job_id || row.listing_url !== expected.listing_url) {
    return {
      job_id: expected.job_id, listing_url: expected.listing_url, status: "wrong_listing", memory_status: "unknown",
      components: Object.fromEntries(MEMORY_FIT_DIMENSIONS.map((key) => [key, { score: null, state: "listing_data_missing", explanation: "The returned listing identity did not match the requested URL." }])) as Record<MemoryFitDimension, MemoryComponent>,
      eligibility: { state: "needs_confirmation", explanation: "The exact requested vacancy could not be confirmed." },
      summary: "The returned result did not match this saved vacancy URL.", strengths: [], limitations: ["No analysis was applied because the result URL did not exactly match the dispatched URL."],
    };
  }
  if (!(status === "assessed" || status === "insufficient_memory" || status === "listing_unavailable" || status === "wrong_listing")) throw new Error("The job result has an unsupported status.");
  if (!(memoryStatus === "sufficient" || memoryStatus === "partial" || memoryStatus === "insufficient" || memoryStatus === "unknown")) throw new Error("The job result has an unsupported Memory status.");
  const validatedStatus = status as MemoryFitResponseJob["status"];
  const validatedMemoryStatus = memoryStatus as MemoryFitResponseJob["memory_status"];
  const rawComponents = object(row.components, "The component scores");
  exactKeys(rawComponents, [...MEMORY_FIT_DIMENSIONS], "The component scores");
  const components = Object.fromEntries(MEMORY_FIT_DIMENSIONS.map((key) => [key, component(rawComponents[key], key)])) as Record<MemoryFitDimension, MemoryComponent>;
  const eligibilityRow = object(row.eligibility, "Eligibility caution");
  exactKeys(eligibilityRow, ["state", "explanation"], "Eligibility caution");
  if (!(eligibilityRow.state === "possible_conflict" || eligibilityRow.state === "no_conflict_identified" || eligibilityRow.state === "needs_confirmation")) throw new Error("The eligibility caution state is unsupported.");
  const summary = boundedText(row.summary, "The overall summary", 1_200, validatedStatus === "listing_unavailable" || validatedStatus === "wrong_listing");
  const strengths = stringList(row.strengths, "Strengths", 5, 300);
  const limitations = stringList(row.limitations, "Limitations", 8, 300);
  const eligibility = { state: eligibilityRow.state as MemoryFitResponseJob["eligibility"]["state"], explanation: boundedText(eligibilityRow.explanation, "The eligibility explanation", 400, true) };

  if (validatedStatus === "insufficient_memory" && (validatedMemoryStatus !== "insufficient" || MEMORY_FIT_DIMENSIONS.some((key) => components[key].state !== "insufficient_memory"))) {
    throw new Error("The insufficient-memory result must mark every category as unsupported by Memory.");
  }
  if ((validatedStatus === "listing_unavailable" || validatedStatus === "wrong_listing")
    && MEMORY_FIT_DIMENSIONS.some((key) => components[key].score !== null || components[key].state !== "listing_data_missing")) {
    throw new Error("Unavailable or mismatched listings cannot include fit scores.");
  }
  if (validatedStatus === "assessed" && (validatedMemoryStatus === "unknown" || validatedMemoryStatus === "insufficient")) throw new Error("An assessed result needs at least partial usable Memory.");
  for (const key of ["technical", "evidence", "role_type"] as const) if (components[key].state === "not_applicable") throw new Error(`Required fit category ${key} cannot be omitted.`);
  return { job_id: expected.job_id, listing_url: expected.listing_url, status: validatedStatus, memory_status: validatedMemoryStatus, components, eligibility, summary, strengths, limitations };
}

export function parseMemoryFitResponse(raw: string, expected: ExpectedEnvelope): ParsedMemoryFitResponse {
  const response = parseObject(raw);
  exactKeys(response, ["schema_version", "request_id", "batch_id", "rubric_version", "assessment_as_of", "jobs"], "The response envelope");
  for (const [key, value] of Object.entries({
    schema_version: MEMORY_FIT_RESPONSE_VERSION,
    request_id: expected.requestId,
    batch_id: expected.batchId,
    rubric_version: expected.rubricVersion || MEMORY_FIT_RUBRIC_VERSION,
  })) if (response[key] !== value) throw new Error(`ChatGPT's response ${key} does not match the exact dispatched request.`);
  if (typeof response.assessment_as_of !== "string" || !Number.isFinite(Date.parse(response.assessment_as_of))
    || Date.parse(response.assessment_as_of) !== Date.parse(expected.assessmentAsOf)) {
    throw new Error("ChatGPT's assessment date does not match the exact dispatched request.");
  }
  if (!Array.isArray(response.jobs) || response.jobs.length > expected.jobs.length + 4) throw new Error("The response jobs list is invalid or too large.");
  const expectedById = new Map(expected.jobs.map((job) => [job.job_id, job]));
  const counts = new Map<string, number>();
  for (const rawJob of response.jobs) {
    const row = rawJob && typeof rawJob === "object" && !Array.isArray(rawJob) ? rawJob as Record<string, unknown> : {};
    const id = typeof row.job_id === "string" ? row.job_id : "";
    if (id && !expectedById.has(id)) throw new Error("ChatGPT returned a job ID that was not in the exact dispatched group. No job result was applied.");
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const results: MemoryFitResponseJob[] = [];
  const issues: MemoryFitItemIssue[] = [];
  const expectedIds = new Set<string>();
  for (const rawJob of response.jobs) {
    const row = rawJob && typeof rawJob === "object" && !Array.isArray(rawJob) ? rawJob as Record<string, unknown> : {};
    const id = typeof row.job_id === "string" ? row.job_id : "";
    const expectedJob = expectedById.get(id);
    if (!expectedJob) continue;
    if (expectedIds.has(id)) continue;
    expectedIds.add(id);
    if (counts.get(id) !== 1) {
      issues.push({ job_id: id, listing_url: expectedJob.listing_url, state: "invalid_response", message: "ChatGPT returned this job more than once. Re-select it for a new analysis; no response was resent." });
      continue;
    }
    try {
      const parsed = validateRow(rawJob, expectedJob);
      if (parsed.status === "listing_unavailable" || parsed.status === "wrong_listing") {
        issues.push({ job_id: id, listing_url: expectedJob.listing_url, state: parsed.status, message: parsed.summary || "The exact listing could not be verified." });
      } else results.push(parsed);
    } catch (error) {
      issues.push({ job_id: id, listing_url: expectedJob.listing_url, state: "invalid_response", message: error instanceof Error ? error.message : "This one job result was malformed." });
    }
  }
  for (const job of expected.jobs) if (!expectedIds.has(job.job_id)) {
    issues.push({ job_id: job.job_id, listing_url: job.listing_url, state: "missing_result", message: "ChatGPT omitted this job result. The captured response was retained; no message was resent." });
  }
  return { results, issues };
}
