import test from "node:test";
import assert from "node:assert/strict";
import { runJobAnalysisScheduler } from "./job-analysis-scheduler.ts";

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://sgarcjiqkvlhldmrlsqo.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  JOB_POOL_SCHEDULER_SECRET: "scheduler-secret",
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const task = {
  task_id: "63d5a182-7be5-4fc2-b52f-fad259682f5e",
  batch_id: "43d5a182-7be5-4fc2-b52f-fad259682f5e",
  user_id: "25ee5122-c418-4f18-88f4-389194f86711",
  job_id: "c49f7dc5-9987-4c2f-b22f-930e9056fe91",
  lease_token: "b7f6eb33-4502-40d2-b1ca-042a61e7d96a",
  attempt_count: 1,
  job_revision: 3,
  profile_revision: 7,
  assessment_as_of: "2026-09-29T10:00:00.000Z",
  job: {
    company: "Example Engineering",
    title: "Simulation Engineer",
    industry: "Engineering",
    description: "Develop finite element simulation tools using Python, validate structural models and work with multidisciplinary engineering teams.",
    sourceUrl: "https://example.com/jobs/123",
    applicationUrl: "https://example.com/jobs/123/apply",
    location: "Reading",
    workMode: "hybrid",
    salaryMin: 50000,
    salaryMax: 60000,
    salaryCurrency: "GBP",
    postedAt: "2026-09-28T10:00:00.000Z",
    closesAt: null,
    employmentType: "Permanent",
  },
  profile: {
    displayName: "Test Candidate",
    facts: [{ id: "f5f4cb07-8d5d-4b81-8f70-d11b3b061a83", factKey: "degree", value: "Engineering", status: "verified" }],
    evidence: [{ id: "43f09c86-6b5a-4d9d-bc86-5e7713d1bd0a", evidenceKey: "sim", category: "simulation_cae", claim: "Developed finite element simulation tools", detail: null, tags: ["Python", "FEA"], strength: 5, status: "verified" }],
    preferences: { locations: ["Reading"], work_modes: ["hybrid"], salary: { minimum: 48000, target: 60000, currency: "GBP" }, target_seniority: "mid-level" },
    sources: [],
    structured: { employment: [], education: [], skills: [], projects: [], publications: [] },
  },
};

test("durable analysis scheduler calculates locally, authenticates the trusted worker, and stores the leased result once", async () => {
  const calls = [];
  const result = await runJobAnalysisScheduler(env, async (input, init = {}) => {
    calls.push({ url: String(input), init });
    assert.equal(String(input), `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/job-pool-scheduler`);
    assert.equal(new Headers(init.headers).get("x-job-pool-scheduler-secret"), "scheduler-secret");
    const request = JSON.parse(String(init.body));
    if (request.action === "analysis_claim") return response({ ok: true, tasks: [task] });
    assert.equal(request.action, "analysis_finish");
    assert.equal(request.results.length, 1);
    assert.equal(request.results[0].task_id, task.task_id);
    assert.equal(request.results[0].lease_token, task.lease_token);
    assert.match(request.results[0].input_hash, /^[0-9a-f]{64}$/);
    assert.equal(request.results[0].engine_version, "job-fit-v2");
    assert.equal(request.results[0].error, null);
    assert.ok(request.results[0].analysis.fitScore >= 0 && request.results[0].analysis.fitScore <= 100);
    assert.equal(request.results[0].analysis.analysisSource, "deterministic_v2");
    return response({ ok: true, outcomes: [{ ok: true, state: "completed" }] });
  });

  assert.deepEqual(result, { claimed: 1, completed: 1, needsUser: 0, failed: 0, retried: 0 });
  assert.equal(calls.length, 2);
});

test("incomplete imported listings are marked needs-user and are never resent to ChatGPT", async () => {
  let finish;
  const incomplete = { ...task, job: { ...task.job, description: "Short" } };
  const result = await runJobAnalysisScheduler(env, async (_input, init = {}) => {
    const request = JSON.parse(String(init.body));
    if (request.action === "analysis_claim") return response({ ok: true, tasks: [incomplete] });
    finish = request;
    return response({ ok: true, outcomes: [{ ok: true, state: "needs_user" }] });
  });

  assert.deepEqual(result, { claimed: 1, completed: 0, needsUser: 1, failed: 0, retried: 0 });
  assert.match(finish.results[0].error, /^needs_user:/);
  assert.equal(finish.results[0].analysis, null);
  assert.equal(finish.results[0].input_hash, null);
});

test("scheduler caps each database claim at five and never logs or forwards credentials in analysis data", async () => {
  let claims = 0;
  await runJobAnalysisScheduler(env, async (_input, init = {}) => {
    const request = JSON.parse(String(init.body));
    if (request.action === "analysis_claim") {
      assert.equal(request.limit, 5);
      claims += 1;
      return response({ ok: true, tasks: [] });
    }
    assert.fail("The scheduler must not finish tasks without a claim.");
  });
  assert.equal(claims, 1);
});

test("scheduler drains variable batch sizes and persists every claimed task before claiming the next wave", async () => {
  const remaining = Array.from({ length: 12 }, (_, index) => ({
    ...task,
    task_id: `63d5a182-7be5-4fc2-b52f-fad259682f${String(index).padStart(2, "0")}`,
    job_id: `c49f7dc5-9987-4c2f-b22f-930e9056f${String(index).padStart(3, "0")}`,
  }));
  const waveSizes = [];
  let finishCount = 0;
  const result = await runJobAnalysisScheduler(env, async (_input, init = {}) => {
    const request = JSON.parse(String(init.body));
    if (request.action === "analysis_claim") {
      assert.equal(finishCount, waveSizes.length, "A new wave must not start before its previous result batch is saved.");
      assert.equal(request.limit, 5);
      const claimed = remaining.splice(0, 5);
      waveSizes.push(claimed.length);
      return response({ ok: true, tasks: claimed });
    }
    assert.equal(request.action, "analysis_finish");
    assert.equal(request.results.length, waveSizes.at(-1));
    finishCount += 1;
    return response({ ok: true, outcomes: request.results.map(() => ({ ok: true, state: "completed" })) });
  });

  assert.deepEqual(waveSizes, [5, 5, 2]);
  assert.deepEqual(result, { claimed: 12, completed: 12, needsUser: 0, failed: 0, retried: 0 });
  assert.equal(finishCount, 3);
});

test("one cron run is bounded to fifty listings so large pools are drained across scheduled runs", async () => {
  let wave = 0;
  let finished = 0;
  const result = await runJobAnalysisScheduler(env, async (_input, init = {}) => {
    const request = JSON.parse(String(init.body));
    if (request.action === "analysis_claim") {
      wave += 1;
      return response({ ok: true, tasks: Array.from({ length: 5 }, (_, index) => ({
        ...task,
        task_id: `63d5a182-7be5-4fc2-b52f-fad259682f${String((wave - 1) * 5 + index).padStart(2, "0")}`,
        job_id: `c49f7dc5-9987-4c2f-b22f-930e9056f${String((wave - 1) * 5 + index).padStart(3, "0")}`,
      })) });
    }
    assert.equal(request.results.length, 5);
    finished += request.results.length;
    return response({ ok: true, outcomes: request.results.map(() => ({ ok: true, state: "completed" })) });
  });

  assert.equal(wave, 10, "A single cron invocation must not exceed ten claim waves.");
  assert.equal(finished, 50);
  assert.deepEqual(result, { claimed: 50, completed: 50, needsUser: 0, failed: 0, retried: 0 });
});

test("scheduler leaves the durable lease for expiry/recovery when its service endpoint is unavailable", async () => {
  await assert.rejects(
    runJobAnalysisScheduler(env, async () => response({ ok: false }, 503)),
    /job_analysis_scheduler_function_503/,
  );
});
