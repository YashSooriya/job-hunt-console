import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runJobFitMemoryV4Scheduler } from "../job-fit-memory-v4-scheduler.ts";

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-test-key",
  JOB_POOL_SCHEDULER_SECRET: "scheduler-test-secret",
};

test("minute scheduler wakes the Memory-only worker through the existing authenticated scheduler function", async () => {
  let captured;
  const result = await runJobFitMemoryV4Scheduler(env, async (input, init) => {
    captured = { url: String(input), init };
    return Response.json({ ok: true, claimed: 2, outcomes: [{ state: "waiting_for_bridge" }, { state: "captured_result_saved" }] });
  }, 4);
  assert.equal(captured.url, "https://project.supabase.co/functions/v1/job-pool-scheduler");
  assert.equal(new Headers(captured.init.headers).get("authorization"), "Bearer publishable-test-key");
  assert.equal(new Headers(captured.init.headers).get("x-job-pool-scheduler-secret"), "scheduler-test-secret");
  assert.deepEqual(JSON.parse(captured.init.body), { action: "memory_fit_advance", limit: 4 });
  assert.equal(result.claimed, 2);
  assert.deepEqual(result.outcomes.map((row) => row.state), ["waiting_for_bridge", "captured_result_saved"]);
});

test("scheduler rejects invalid limits, missing secrets and failed worker responses", async () => {
  await assert.rejects(() => runJobFitMemoryV4Scheduler(env, fetch, 6), /limit_invalid/);
  await assert.rejects(() => runJobFitMemoryV4Scheduler({ ...env, JOB_POOL_SCHEDULER_SECRET: "" }), /not_configured/);
  await assert.rejects(() => runJobFitMemoryV4Scheduler(env, async () => Response.json({ ok: false, error: "worker failed" }, { status: 503 })), /worker failed/);
});

test("background recovery shares the generic exact-turn Website Bridge and the live batch lease", async () => {
  const [worker, migration, scheduler, route, server, customWorker] = await Promise.all([
    readFile(new URL("../../../../supabase/functions/job-pool-scheduler/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../../database/migrations/20261003093708_job_fit_memory_v4_background_progress.sql", import.meta.url), "utf8"),
    readFile(new URL("../job-fit-memory-v4-scheduler.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/jobs/analysis/memory/advance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./server.ts", import.meta.url), "utf8"),
    readFile(new URL("../../custom-worker.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /buildMemoryFitChunkPersistence/);
  assert.match(worker, /exactMemoryFitDispatchMatches/);
  assert.match(worker, /job_fit_memory_v4_worker_capture/);
  assert.match(worker, /terminalMemoryFitDispatch/);
  assert.match(worker, /job_fit_memory_v4_worker_save/);
  assert.match(worker, /job_fit_memory_v4_worker_dispatch/);
  assert.match(worker, /isMemoryFitPersistenceIntegrityFailure/);
  assert.match(worker, /The captured response was not resent/);
  assert.match(worker, /No replacement message was sent/);
  assert.doesNotMatch(worker, /chrome\.tabs\.(?:update|activate)|tabs\.update\(/i);
  assert.match(migration, /advance_lease_token/);
  assert.match(migration, /for update of b skip locked/i);
  assert.match(migration, /public\.create_chatgpt_dispatch_request_with_website_instruction/);
  assert.match(migration, /public\.capture_job_fit_memory_v4_chunk/);
  assert.match(migration, /public\.save_job_fit_memory_v4_chunk_results/);
  assert.match(migration, /add constraint job_fit_memory_v4_items_state_check[\s\S]*?'needs_user'/);
  assert.match(migration, /security invoker/);
  assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete)[^;]*job_fit_memory_v4_[^;]*to service_role/i);
  assert.doesNotMatch(migration, /0101_chatgpt_bridge_v3_security_boundary|chatgpt_bridge_service_complete/i);
  assert.match(scheduler, /action: "memory_fit_advance"/);
  assert.match(customWorker, /runJobFitMemoryV4Scheduler/);
  assert.match(route, /advanceMemoryFitBatch/);
  assert.match(server, /advance_lease_expires_at/);
  assert.match(server, /progressOwnedElsewhere/);
  assert.match(server, /reprocessCapturedChunkId/);
});
