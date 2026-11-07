import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MEMORY_FIT_DIMENSIONS,
  MEMORY_FIT_RESPONSE_VERSION,
  MEMORY_FIT_RUBRIC_VERSION,
  MAX_MEMORY_FIT_MESSAGE_CHARS,
} from "./contract.ts";
import { buildMemoryFitPrompt, buildMemoryFitPromptChunks } from "./prompt.ts";
import { parseMemoryFitResponse } from "./response.ts";
import { buildMemoryFitAnalysis } from "./analysis.ts";
import { findRequestedCapturedRepair } from "./recovery.ts";
import { buildMemoryFitChunkPersistence } from "./worker.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const jobA = { job_id: "33333333-3333-4333-8333-333333333333", listing_url: "https://example.com/jobs/a" };
const jobB = { job_id: "44444444-4444-4444-8444-444444444444", listing_url: "https://example.com/jobs/b" };
const assessmentAsOf = "2026-10-01T12:00:00.000Z";

test("captured response reprocessing is explicit and cannot starve a later queued group", () => {
  const chunks = [
    { id: "bad-capture", state: "completed", captured_response: "saved", captured_response_hash: "abc" },
    { id: "later-group", state: "queued", captured_response: null, captured_response_hash: null },
  ];
  const items = [{ chunk_id: "bad-capture", state: "invalid_response" }];
  assert.equal(findRequestedCapturedRepair(chunks, items), undefined, "ordinary progress must advance queued groups without reparsing a terminal capture");
  assert.equal(findRequestedCapturedRepair(chunks, items, "later-group"), undefined, "a queued group is never treated as a captured result");
  assert.equal(findRequestedCapturedRepair(chunks, items, "bad-capture")?.id, "bad-capture", "only an explicit request may locally reprocess this exact capture");
});

function components(overrides = {}) {
  return Object.fromEntries(MEMORY_FIT_DIMENSIONS.map((key) => [key, {
    score: key === "qualification" ? null : 75,
    state: key === "qualification" ? "not_applicable" : "assessed",
    explanation: key === "qualification" ? "No qualification is stated." : `Relevant remembered evidence for ${key}.`,
    ...(overrides[key] || {}),
  }]));
}
function responseJob(job, overrides = {}) {
  return {
    job_id: job.job_id,
    listing_url: job.listing_url,
    status: "assessed",
    memory_status: "sufficient",
    components: components(),
    eligibility: { state: "needs_confirmation", explanation: "Verify any eligibility requirements yourself." },
    summary: "The remembered background appears relevant to this role.",
    strengths: ["Relevant role experience."],
    limitations: [],
    ...overrides,
  };
}
function responseEnvelope(jobs) {
  return {
    schema_version: MEMORY_FIT_RESPONSE_VERSION,
    request_id: requestId,
    batch_id: batchId,
    rubric_version: MEMORY_FIT_RUBRIC_VERSION,
    assessment_as_of: assessmentAsOf,
    jobs,
  };
}
function expected(jobs = [jobA, jobB]) {
  return { requestId, batchId, rubricVersion: MEMORY_FIT_RUBRIC_VERSION, assessmentAsOf, jobs };
}

test("request is a short URL-and-ID-only Memory assessment, with the Testing Mode warning first", () => {
  const message = buildMemoryFitPrompt({ requestId, batchId, assessmentAsOf, jobs: [jobA], testingMode: true });
  assert.ok(message.length <= MAX_MEMORY_FIT_MESSAGE_CHARS);
  assert.match(message, /^TEST ONLY — The following message is a test\./);
  assert.match(message, /request contains only IDs\/URLs—never a profile, background, CV, preferences, or profile hash/);
  assert.doesNotMatch(message.replace(/https?:\/\/[^\s]+/gi, ""), /(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)/i,
    "the plain-language instruction must not trip the generic Bridge safety guard");
  assert.match(message, /Open each exact public vacancy URL using ChatGPT Memory/i);
  assert.match(message, /"jobs":\[\{"job_id":"33333333-3333-4333-8333-333333333333","listing_url":"https:\/\/example\.com\/jobs\/a"\}\]/);
  for (const forbidden of ["CANDIDATE_SENTINEL", "candidate_background", "profile_snapshot_hash", "candidate_facts", "email@example.com"]) {
    assert.equal(message.includes(forbidden), false, `the outgoing request must not contain ${forbidden}`);
  }
});

test("each message is limited to five jobs and the complete final prompt is checked against the bridge budget", () => {
  const jobs = Array.from({ length: 6 }, (_, i) => ({ job_id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`, listing_url: `https://example.com/${i}` }));
  assert.throws(() => buildMemoryFitPrompt({ requestId, batchId, assessmentAsOf, jobs, testingMode: false }), /1–5 jobs/);
  const oversizedButValidGroup = Array.from({ length: 5 }, (_, i) => ({
    job_id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
    listing_url: `https://example.com/jobs/${i}?${"x".repeat(350)}`,
  }));
  assert.throws(() => buildMemoryFitPrompt({ requestId, batchId, assessmentAsOf, jobs: oversizedButValidGroup, testingMode: true }), /5800-character limit/);
  assert.throws(() => buildMemoryFitPrompt({ requestId, batchId, assessmentAsOf, jobs: [{ ...jobA, extra: "profile" }], testingMode: false }), /invalid listing URL/);
  assert.throws(() => buildMemoryFitPrompt({ requestId, batchId, assessmentAsOf, jobs: [{ job_id: jobA.job_id, listing_url: "http://127.0.0.1/private" }], testingMode: false }), /invalid listing URL/);
});

test("long exact URLs are split into the largest safe groups, including 100-message worst case", () => {
  const jobs = Array.from({ length: 100 }, (_, i) => ({
    job_id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
    listing_url: `https://example.com/jobs/${i}?${"x".repeat(1_972)}`,
  }));
  const chunks = buildMemoryFitPromptChunks({ requestId, batchId, assessmentAsOf, jobs, testingMode: true });
  assert.equal(chunks.length, 100);
  assert.ok(chunks.every((chunk) => chunk.jobs.length === 1));
  assert.ok(chunks.every((chunk) => chunk.instruction.length <= MAX_MEMORY_FIT_MESSAGE_CHARS));
  assert.ok(chunks.every((chunk) => chunk.instruction.startsWith("TEST ONLY — The following message is a test.")));
  assert.deepEqual(chunks.flatMap((chunk) => chunk.jobs.map((job) => job.job_id)), jobs.map((job) => job.job_id));

  const trackableJobs = Array.from({ length: 5 }, (_, i) => ({
    job_id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
    listing_url: `https://example.com/jobs/${i}?${"x".repeat(350)}`,
  }));
  const packed = buildMemoryFitPromptChunks({ requestId, batchId, assessmentAsOf, jobs: trackableJobs, testingMode: true });
  assert.ok(packed.length > 1 && packed.length < trackableJobs.length);
  assert.ok(packed.every((chunk) => chunk.jobs.length <= 5 && chunk.instruction.length <= MAX_MEMORY_FIT_MESSAGE_CHARS));
  assert.deepEqual(packed.flatMap((chunk) => chunk.jobs.map((job) => job.job_id)), trackableJobs.map((job) => job.job_id));
});

test("exact response envelope is validated and valid siblings survive a malformed item", () => {
  const raw = JSON.stringify(responseEnvelope([
    responseJob(jobA),
    { job_id: jobB.job_id, listing_url: jobB.listing_url, status: "assessed" },
  ]));
  const parsed = parseMemoryFitResponse(raw, expected());
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].job_id, jobA.job_id);
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.issues[0].state, "invalid_response");
});

test("captured JSON safely repairs an unescaped quote around a brace-delimited listing marker", () => {
  const explanations = [
    'The advert includes an index="0" marker.',
    'The page includes content-reference{index="0"}" in its generated text.',
  ];
  for (const explanation of explanations) {
    const raw = JSON.stringify(responseEnvelope([responseJob(jobA, {
      components: components({ evidence: { score: 75, state: "assessed", explanation } }),
    })]));
    const malformed = raw.replace(String.raw`index=\"0\"`, 'index="0"');
    assert.notEqual(malformed, raw);
    const parsed = parseMemoryFitResponse(malformed, expected([jobA]));
    assert.equal(parsed.results[0].components.evidence.explanation, explanation);
  }

  const missingComma = JSON.stringify(responseEnvelope([responseJob(jobA)])).replace('"status":"assessed"', '"status":"assessed""memory_status"');
  assert.throws(() => parseMemoryFitResponse(missingComma, expected([jobA])), /one valid JSON object/);
});

test("duplicate and missing results are attached to exact jobs without losing valid siblings", () => {
  const parsed = parseMemoryFitResponse(JSON.stringify(responseEnvelope([
    responseJob(jobA), responseJob(jobA),
  ])), expected());
  assert.equal(parsed.results.length, 0);
  assert.deepEqual(parsed.issues.map((issue) => issue.state), ["invalid_response", "missing_result"]);
  assert.deepEqual(parsed.issues.map((issue) => issue.job_id).sort(), [jobA.job_id, jobB.job_id].sort());
});

test("foreign IDs and request/hash mismatches invalidate the envelope", () => {
  assert.throws(() => parseMemoryFitResponse(JSON.stringify(responseEnvelope([responseJob({ job_id: "foreign", listing_url: jobA.listing_url })])), expected([jobA])), /not in the exact dispatched group/);
  const wrongBatch = responseEnvelope([responseJob(jobA)]);
  wrongBatch.batch_id = "foreign";
  assert.throws(() => parseMemoryFitResponse(JSON.stringify(wrongBatch), expected([jobA])), /batch_id/);
  const mismatchedUrl = responseJob(jobA, { listing_url: "https://example.com/jobs/other" });
  const parsed = parseMemoryFitResponse(JSON.stringify(responseEnvelope([mismatchedUrl])), expected([jobA]));
  assert.equal(parsed.issues[0].state, "wrong_listing");
  assert.equal(parsed.results.length, 0);
});

test("unavailable listing results cannot contain invented fit scores", () => {
  const invalid = responseJob(jobA, {
    status: "listing_unavailable",
    memory_status: "unknown",
    components: components(Object.fromEntries(MEMORY_FIT_DIMENSIONS.map((key) => [key, { score: null, state: "listing_data_missing" }]))),
  });
  const parsed = parseMemoryFitResponse(JSON.stringify(responseEnvelope([invalid])), expected([jobA]));
  assert.equal(parsed.results.length, 0);
  assert.equal(parsed.issues[0].state, "listing_unavailable");
  invalid.components.technical.score = 75;
  assert.equal(parseMemoryFitResponse(JSON.stringify(responseEnvelope([invalid])), expected([jobA])).issues[0].state, "invalid_response");
});

test("unknown Memory keeps every score and recalled strength unavailable", () => {
  const unknown = responseJob(jobA, {
    status: "insufficient_memory",
    memory_status: "unknown",
    components: components(Object.fromEntries(MEMORY_FIT_DIMENSIONS.map((key) => [key, {
      score: null, state: "insufficient_memory", explanation: "No candidate Memory was available for this synthetic test.",
    }]))),
    strengths: [],
    limitations: ["Candidate Memory was unavailable."],
  });
  const parsed = parseMemoryFitResponse(JSON.stringify(responseEnvelope([unknown])), expected([jobA]));
  assert.equal(parsed.results.length, 1);
  const built = buildMemoryFitAnalysis({
    result: parsed.results[0],
    vacancy: { id: jobA.job_id, jobRevision: 4, title: "Synthetic Analyst", sourceUrl: jobA.listing_url },
    preferences: {},
    assessmentAsOf: new Date(assessmentAsOf),
  });
  assert.equal(built.analysis.fit_score, null);
  assert.deepEqual(built.analysis.strengths, []);
  assert.match(built.analysis.assessment_limitations.join(" "), /No candidate Memory context was available/);
  const invalidStrength = parseMemoryFitResponse(JSON.stringify(responseEnvelope([{
    ...unknown, strengths: ["A claimed candidate strength"],
  }])), expected([jobA]));
  assert.equal(invalidStrength.results.length, 0);
  assert.equal(invalidStrength.issues[0].state, "invalid_response");
  assert.match(invalidStrength.issues[0].message, /cannot claim candidate strengths/);
});

test("weighted fit score and priority are computed locally and partial Memory withholds the aggregate", () => {
  const assessed = responseJob(jobA);
  const built = buildMemoryFitAnalysis({
    result: assessed,
    vacancy: { id: jobA.job_id, jobRevision: 4, title: "Engineer", sourceUrl: jobA.listing_url, salarySource: "not_available" },
    preferences: {},
    assessmentAsOf: new Date(assessmentAsOf),
  });
  assert.equal(built.analysis.engine_version, "job-fit-memory-v4");
  assert.equal(built.analysis.fit_score, 75);
  assert.equal(built.analysis.evidence_item_ids.length, 0);
  assert.equal(built.analysis.fit_component_details.technical.score, 75);
  assert.match(built.analysis.assessment_limitations.join(" "), /did not send your profile or background/);

  const partial = responseJob(jobA, {
    memory_status: "partial",
    components: components({ seniority: { score: null, state: "insufficient_memory", explanation: "Memory lacks seniority detail." } }),
  });
  const partialBuilt = buildMemoryFitAnalysis({
    result: partial,
    vacancy: { id: jobA.job_id, jobRevision: 4, title: "Engineer", sourceUrl: jobA.listing_url },
    preferences: {},
    assessmentAsOf: new Date(assessmentAsOf),
  });
  assert.equal(partialBuilt.analysis.fit_score, null);
  assert.equal(partialBuilt.analysis.assessment_completeness, "partial");
});

test("foreground and background recovery share the same exact captured-response persistence builder", () => {
  const raw = JSON.stringify(responseEnvelope([responseJob(jobA)]));
  const chunk = {
    id: "chunk-id", job_ids: [jobA.job_id], captured_response: raw,
    captured_response_hash: createHash("sha256").update(raw, "utf8").digest("hex"),
  };
  const item = { id: "item-id", job_id: jobA.job_id, listing_url: jobA.listing_url, job_revision: 4 };
  const job = {
    id: jobA.job_id, title: "Engineer", source_url: jobA.listing_url, application_url: null,
    analysis_revision: 4, location_text: "London", salary_currency: "GBP",
  };
  const prepared = buildMemoryFitChunkPersistence({
    batch: { id: batchId, request_id: requestId, assessment_as_of: assessmentAsOf },
    chunk, items: [item], preferences: {},
    contextRows: [{ item, job, snapshot: { description_text: "Build software systems", listing_extraction: {} } }],
  });
  const direct = buildMemoryFitAnalysis({
    result: responseJob(jobA),
    vacancy: { id: jobA.job_id, jobRevision: 4, title: "Engineer", description: "Build software systems", sourceUrl: jobA.listing_url, location: "London", salaryCurrency: "GBP", salarySource: "not_available" },
    preferences: {},
    assessmentAsOf: new Date(assessmentAsOf),
  });
  assert.equal(prepared.malformedEnvelope, false);
  assert.equal(prepared.results.length, 1);
  assert.equal(prepared.results[0].state, "assessed");
  assert.deepEqual(prepared.results[0].analysis, direct.analysis);
  assert.deepEqual(prepared.results[0].result, direct.item_result);
});

test("background persistence fails closed on a changed URL or corrupted captured hash without creating a dispatch", () => {
  const raw = JSON.stringify(responseEnvelope([responseJob(jobA)]));
  const chunk = {
    id: "chunk-id", job_ids: [jobA.job_id], captured_response: raw,
    captured_response_hash: createHash("sha256").update(raw, "utf8").digest("hex"),
  };
  const item = { id: "item-id", job_id: jobA.job_id, listing_url: jobA.listing_url, job_revision: 4 };
  const batch = { id: batchId, request_id: requestId, assessment_as_of: assessmentAsOf };
  const context = [{ item, job: { id: jobA.job_id, title: "Engineer", source_url: "https://example.com/jobs/changed", analysis_revision: 4 }, snapshot: {} }];
  const changed = buildMemoryFitChunkPersistence({ batch, chunk, items: [item], contextRows: context, preferences: {} });
  assert.equal(changed.results[0].state, "invalid_response");
  assert.match(changed.results[0].error_message, /listing changed/);
  assert.throws(() => buildMemoryFitChunkPersistence({ batch, chunk: { ...chunk, captured_response_hash: "0".repeat(64) }, items: [item], contextRows: context, preferences: {} }), /captured response hash/);
});

test("background processing keeps malformed captured turns local and marks every exact item for review", () => {
  const response = "not JSON";
  const chunk = {
    id: "chunk-id", job_ids: [jobA.job_id], captured_response: response,
    captured_response_hash: createHash("sha256").update(response, "utf8").digest("hex"),
  };
  const prepared = buildMemoryFitChunkPersistence({
    batch: { id: batchId, request_id: requestId, assessment_as_of: assessmentAsOf },
    chunk, items: [{ job_id: jobA.job_id, listing_url: jobA.listing_url, job_revision: 4 }],
    contextRows: [], preferences: {},
  });
  assert.equal(prepared.malformedEnvelope, true);
  assert.equal(prepared.results[0].state, "invalid_response");
  assert.match(prepared.results[0].error_message, /original message was not resent/i);
});
