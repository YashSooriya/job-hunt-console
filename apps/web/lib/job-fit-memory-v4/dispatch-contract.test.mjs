import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMemoryFitPrompt } from "./prompt.ts";
import { createdMemoryFitDispatchMatches, exactMemoryFitDispatchMatches, memoryFitDispatchWasSafelyRequeued, safeMemoryFitDispatchRetryAllowed, safeMemoryFitFreshDispatchAllowed } from "./dispatch-contract.ts";

const jobIds = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const chunk = {
  idempotency_key: "jobfit-memory-v4:22222222-2222-4222-8222-222222222222:1",
  job_ids: jobIds,
  instruction: "TEST ONLY — Assess these exact public job URLs using ChatGPT Memory.",
};
const persisted = {
  id: "55555555-5555-4555-8555-555555555555",
  action_type: "jobs.analyse_selected",
  idempotency_key: chunk.idempotency_key,
  subject_refs: { job_ids: jobIds },
  website_instruction: chunk.instruction,
};

test("the action-specific Website Bridge creation receipt is bound to an owner-scoped full dispatch read", () => {
  const created = { ...persisted };
  delete created.subject_refs; // The generic creation RPC deliberately omits subject_refs.
  assert.equal(exactMemoryFitDispatchMatches(created, chunk), false);
  assert.equal(createdMemoryFitDispatchMatches(created, persisted, chunk), true);
  assert.equal(createdMemoryFitDispatchMatches({ ...created, idempotency_key: "other" }, persisted, chunk), false);
  assert.equal(createdMemoryFitDispatchMatches(created, { ...persisted, subject_refs: { job_ids: [jobIds[1], jobIds[0]] } }, chunk), false);
  assert.equal(createdMemoryFitDispatchMatches(created, { ...persisted, website_instruction: "different prompt" }, chunk), false);
  assert.equal(exactMemoryFitDispatchMatches(persisted, { ...chunk, dispatch_id: null }), true, "a queued database row has a null dispatch id until its exact receipt is attached");
  assert.equal(exactMemoryFitDispatchMatches(persisted, { ...chunk, dispatch_id: "different" }), false);
  assert.equal(exactMemoryFitDispatchMatches(persisted, { ...chunk, dispatch_id: persisted.id }), true);
});

test("the batch server validates the receipt only after hydrating its full exact dispatch", async () => {
  const server = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const createIndex = server.indexOf('rpc("create_chatgpt_dispatch_request_with_website_instruction"');
  const hydrateIndex = server.indexOf('rpc("get_chatgpt_dispatch_request", { p_request_id: created.id })');
  const checkIndex = server.indexOf("createdMemoryFitDispatchMatches(created, dispatch, chunk)");
  assert.ok(createIndex >= 0 && hydrateIndex > createIndex && checkIndex > hydrateIndex);
});

test("request-id retries always return the durable batch id so the client clears its pending marker", async () => {
  const route = await readFile(new URL("../../app/api/jobs/analysis/memory/route.ts", import.meta.url), "utf8");
  const existingIndex = route.indexOf("if (existing?.id)");
  const createIndex = route.indexOf("const { data: jobsRaw", existingIndex);
  const retryBranch = route.slice(existingIndex, createIndex);
  assert.match(retryBranch, /batchId: String\(existing\.id\)/);
  assert.match(retryBranch, /if \(result\.status\) return respond\(\{ ok: false, error: result\.error, batchId: String\(existing\.id\) \}/);
});

test("Memory-fit safe retry requires the exact server-confirmed unsent V2 dispatch", () => {
  const unsent = { ...persisted, state: "user_required", protocol: "v2", retry_allowed: true,
    sent_at: null, send_attempted_at: null, sent_confirmed_at: null, delivery_turn_anchor: null,
    response_hash: null, bridge_response: null, idempotency_key: chunk.idempotency_key };
  const savedChunk = { ...chunk, dispatch_id: persisted.id };
  assert.equal(safeMemoryFitDispatchRetryAllowed(unsent, savedChunk), true);
  assert.equal(safeMemoryFitDispatchRetryAllowed({ ...unsent, send_attempted_at: "2026-10-01T20:00:00Z" }, savedChunk), false);
  assert.equal(safeMemoryFitDispatchRetryAllowed({ ...unsent, protocol: "v1" }, savedChunk), false);
  assert.equal(safeMemoryFitDispatchRetryAllowed({ ...unsent, subject_refs: { job_ids: [jobIds[1], jobIds[0]] } }, savedChunk), false);
  const requeued = { ...unsent, state: "queued", retry_allowed: false, progress: { stage: "requeued_by_user" } };
  assert.equal(memoryFitDispatchWasSafelyRequeued(requeued, savedChunk), true);
  assert.equal(memoryFitDispatchWasSafelyRequeued({ ...requeued, progress: { stage: "queued" } }, savedChunk), false);
  assert.equal(memoryFitDispatchWasSafelyRequeued({ ...requeued, delivery_turn_anchor: {} }, savedChunk), false);
});

test("fresh Memory-fit dispatch is allowed only after the exact V2 request exhausted retries without any Send or capture marker", () => {
  const savedChunk = { ...chunk, id: "chunk-1", dispatch_id: persisted.id, captured_response: null };
  const items = jobIds.map((job_id) => ({ job_id, state: "queued", analysis_id: null }));
  const exhausted = { ...persisted, state: "user_required", protocol: "v2", retry_allowed: false, attempt_count: 5,
    error: { code: "delivery_lease_expired" }, sent_at: null, send_attempted_at: null, sent_confirmed_at: null,
    has_delivery_turn_anchor: false, bridge_response: null, completed_at: null };
  assert.equal(safeMemoryFitFreshDispatchAllowed(exhausted, savedChunk, items), true);
  assert.equal(safeMemoryFitFreshDispatchAllowed(exhausted, savedChunk, items.map((item) => ({ ...item, state: "needs_user" }))), true,
    "a saved terminal delivery issue is a review state, but remains eligible only when the dispatch proves no Send was attempted");
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, sent_at: "2026-10-01T20:00:00Z" }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, send_attempted_at: "2026-10-01T20:00:00Z" }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, sent_confirmed_at: "2026-10-01T20:00:00Z" }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, has_delivery_turn_anchor: true }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, bridge_response: "captured" }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, error: { code: "response_capture_timeout" } }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, attempt_count: 4 }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed({ ...exhausted, protocol: "v1" }, savedChunk, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed(exhausted, { ...savedChunk, captured_response: "captured" }, items), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed(exhausted, savedChunk, items.map((item) => ({ ...item, state: "assessed" }))), false);
  assert.equal(safeMemoryFitFreshDispatchAllowed(exhausted, savedChunk, items.slice(0, 1)), false);
});

test("progress recovery exposes only an exact server-approved safe retry and reattaches only its queued V2 retry", async () => {
  const route = await readFile(new URL("../../app/api/jobs/analysis/memory/route.ts", import.meta.url), "utf8");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(get, /chunk\.state === "needs_user" && typeof chunk\.dispatch_id === "string"/);
  assert.match(get, /safeMemoryFitDispatchRetryAllowed\(dispatch, retryCandidate\)/);
  assert.match(get, /safeMemoryFitFreshDispatchAllowed\(dispatch, retryCandidate/);
  assert.doesNotMatch(get, /bridge_response|website_instruction|manual_instruction/);
  const restart = route.slice(route.indexOf("export async function POST"));
  assert.match(restart, /retryBatchId/);
  assert.match(restart, /safeMemoryFitFreshDispatchAllowed\(record\(dispatchData\), candidate, candidateItems\)/);
  assert.match(restart, /previous\.testing_mode === true/);
  assert.match(restart, /No new request was created/);
  const server = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const reattach = server.indexOf("memoryFitDispatchWasSafelyRequeued(retriedDispatch, record(retryCandidate))");
  const activeRead = server.indexOf('eq("state", "waiting_for_bridge").maybeSingle()', reattach);
  assert.ok(reattach >= 0 && activeRead > reattach);
  assert.match(server.slice(reattach, activeRead), /state: "waiting_for_bridge"/);
  const component = await readFile(new URL("../../components/job-fit-memory-controls.tsx", import.meta.url), "utf8");
  const uuidPattern = component.match(/const UUID = \/(.+)\/i;/)?.[1];
  assert.ok(uuidPattern, "the browser recovery controls must define their UUID validation pattern");
  const browserUuid = new RegExp(uuidPattern, "i");
  assert.equal(browserUuid.test("16c5c89d-3c86-4450-8bfb-f29b4073684f"), true, "valid 8-4-4-4-12 dispatch IDs must pass client validation");
  assert.equal(browserUuid.test("16c5c89d-3c8-4450-8bfb-f29b4073684f"), false, "malformed dispatch IDs must still fail client validation");
  assert.match(component, /safeRetryChunk = batch\?\.chunks\?\.find/);
  assert.match(component, /batchNeedsStatusCheck = Boolean\(batch\?\.state === "partial"/);
  assert.match(component, /Check safe retry status/);
  assert.match(component, /loadBatch\(batch\.id\)/);
  assert.match(component, /initiateDisabled = .*safeRetryCandidate \|\| batchNeedsStatusCheck/);
  assert.match(component, /safeRetryStatusNeedsRefresh = Boolean\(\(safeRetryCandidate \|\| batchNeedsStatusCheck\)/);
  assert.match(component, /safeRetryBatchId === batch\.id/);
  assert.match(component, /setSafeRetryBatchId\(exactBatchId && safeDispatch/);
  assert.match(component, /setSafeRetryBatchId\(retryAuthorized \? batch\.id : null\)/);
  assert.match(component, /!batchId \|\| value\.id === batchId/);
  assert.match(component, /candidate\.job_ids\?\.includes\(item\.job_id\)/);
  assert.match(component, /dispatch\.retry_allowed === true/);
  assert.match(component, /fetch\("\/api\/chatgpt-bridge\/dispatch\/retry"/);
  assert.match(component, /Retry safe Bridge delivery/);
  assert.match(component, /safeFreshRetryBatchId/);
  assert.match(component, /Retry this confirmed-unsent group/);
  assert.match(component, /retryBatchId: batch\.id/);
});

test("legitimate URL path/query words cannot trip the generic instruction safety guard", async () => {
  const prompt = buildMemoryFitPrompt({
    requestId: "11111111-1111-4111-8111-111111111111",
    batchId: "22222222-2222-4222-8222-222222222222",
    assessmentAsOf: "2026-10-01T12:00:00.000Z",
    jobs: [{ job_id: jobIds[0], listing_url: "https://example.com/jobs/MCP-engineer?campaign=jobhuntai" }],
    testingMode: true,
  });
  const withoutUrls = prompt.replace(/https?:\/\/[^\s]+/gi, "");
  assert.doesNotMatch(withoutUrls, /(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)/i);
  assert.match(prompt, /https:\/\/example\.com\/jobs\/MCP-engineer\?campaign=jobhuntai/);

  const migration = await readFile(new URL("../../../../database/migrations/20261001195925_website_bridge_url_text_guard.sql", import.meta.url), "utf8");
  assert.match(migration, /regexp_replace\(v_instruction, 'https\?:\/\/\[\^\[:space:\]\]\+', '', 'gi'\)/i);
  assert.match(migration, /v_instruction_without_urls ~\* '\(jobhuntai\|mcp\|dispatch request\|claim_dispatch\|chatgpt_bridge\)'/i);
});
