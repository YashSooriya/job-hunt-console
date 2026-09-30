import test from "node:test";
import assert from "node:assert/strict";
import { runJobFitV3Scheduler } from "../job-fit-v3-scheduler.ts";

const task = {
  id: "10000000-0000-4000-8000-000000000001",
  user_id: "20000000-0000-4000-8000-000000000002",
  lease_token: "30000000-0000-4000-8000-000000000003",
  state: "queued",
};
const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-key",
  JOB_POOL_SCHEDULER_SECRET: "test-secret",
  JOB_FIT_V3_MODE: "enabled",
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function schedulerFetch(dispatchResponse) {
  const actions = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    actions.push(body.action);
    if (body.action === "fit_claim") return response({ ok: true, tasks: [task] });
    if (body.action === "fit_dispatch") return dispatchResponse;
    if (body.action === "fit_release") return response({ ok: true, data: { released: true } });
    throw new Error(`Unexpected worker action ${body.action}`);
  };
  return { actions, fetcher };
}

test("reports a real generic Bridge dispatch separately from a blocked ChatGPT operation lock", async () => {
  const blocked = schedulerFetch(response({ ok: true, data: { state: "queued", blocked: true, reason: "another_chatgpt_action_active" } }));
  const blockedCounts = await runJobFitV3Scheduler(env, blocked.fetcher);
  assert.deepEqual(blockedCounts, { claimed: 1, dispatched: 0, blocked: 1, completed: 0, waiting: 0, saving: 0, needsUser: 0, paused: 0, failed: 0 });
  assert.deepEqual(blocked.actions, ["fit_claim", "fit_dispatch"]);

  const dispatched = schedulerFetch(response({ ok: true, data: { state: "waiting_for_bridge", dispatch_id: "40000000-0000-4000-8000-000000000004" } }));
  const dispatchedCounts = await runJobFitV3Scheduler(env, dispatched.fetcher);
  assert.equal(dispatchedCounts.dispatched, 1);
  assert.equal(dispatchedCounts.blocked, 0);
});

test("pauses rollout without sending and releases the short database lease", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.action);
    if (body.action === "fit_claim") return response({ ok: true, tasks: [task] });
    if (body.action === "fit_release") return response({ ok: true, data: { released: true } });
    throw new Error(`Unexpected worker action ${body.action}`);
  };
  const counts = await runJobFitV3Scheduler({ ...env, JOB_FIT_V3_MODE: "paused" }, fetcher);
  assert.equal(counts.paused, 1);
  assert.deepEqual(calls, ["fit_claim", "fit_release"]);
});

test("a transient fit endpoint failure releases its lease and never invents a dispatch", async () => {
  const state = schedulerFetch(response({ ok: false, error: "temporarily unavailable" }, 503));
  const counts = await runJobFitV3Scheduler(env, state.fetcher);
  assert.equal(counts.failed, 1);
  assert.equal(counts.dispatched, 0);
  assert.deepEqual(state.actions, ["fit_claim", "fit_dispatch", "fit_release"]);
});

function completedContextTask() {
  const dispatchId = "40000000-0000-4000-8000-000000000004";
  const contextTask = {
    ...task,
    job_id: "50000000-0000-4000-8000-000000000005",
    state: "waiting_for_bridge",
    current_step_index: 0,
    attempt_count: 1,
    active_dispatch_id: dispatchId,
    assessment_as_of: "2026-09-30T00:00:00.000Z",
    input_payload: { fit_input: { job_id: "50000000-0000-4000-8000-000000000005" } },
    steps: [{ phase: "context", ordinal: 0, text: "Frozen context acknowledgement step." }],
  };
  const provenance = {
    conversationUrl: "https://chatgpt.com/c/exact-fit-conversation",
    userTurnFingerprint: "sent-user-turn-fingerprint",
    assistantMessageId: "assistant-turn-id",
    assistantFingerprint: "assistant-turn-fingerprint",
    source: "assistant_turn",
    generationFinished: true,
  };
  return {
    task: contextTask,
    dispatch: {
      id: dispatchId,
      action_type: "jobs.analyse_selected",
      idempotency_key: `jobfit-${contextTask.id}:1:0`,
      subject_refs: { job_ids: ["50000000-0000-4000-8000-000000000005"] },
      state: "completed",
      output_refs: { response_provenance_recorded: true },
      response_provenance: provenance,
      delivery_turn_anchor: { conversationUrl: provenance.conversationUrl },
      delivery_user_turn_fingerprint: provenance.userTurnFingerprint,
      bridge_response_at: "2026-09-30T00:01:00.000Z",
      bridge_response: "CONTEXT RECEIVED",
      response_hash: "sha256:exact-turn-response",
    },
  };
}

test("durably captured context immediately wakes the next saved step through the worker, after capture", async () => {
  const fixture = completedContextTask();
  const calls = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (body.action === "fit_claim") return response({ ok: true, tasks: [fixture.task] });
    if (body.action === "fit_status") return response({ ok: true, dispatch: fixture.dispatch });
    if (body.action === "fit_transition") return response({ ok: true, data: { state: "queued" } });
    if (body.action === "fit_kick") return response({ ok: true, claimed: 1, outcomes: [{ state: "waiting_for_bridge", dispatched: true }] });
    throw new Error(`Unexpected worker action ${body.action}`);
  };

  const counts = await runJobFitV3Scheduler(env, fetcher);

  assert.equal(counts.failed, 0);
  assert.deepEqual(calls.map((call) => call.action), ["fit_claim", "fit_status", "fit_transition", "fit_kick"]);
  assert.equal(calls[2].transition, "capture_context");
  assert.equal(calls[3].user_id, fixture.task.user_id);
  assert.equal(calls[2].dispatch_id, fixture.dispatch.id);
});

test("completed criterion capture freezes the complete prepared assessment before immediately kicking it", async () => {
  const fixture = completedContextTask();
  const sourceUnit = {
    reference: "source:one",
    text: "Experience implementing numerical algorithms.",
    importance: "essential",
    source_field: "essential_requirements",
    source_index: 0,
  };
  fixture.task.steps = [{ phase: "criteria", ordinal: 0, text: "Frozen criterion preparation step.", source_unit_reference: sourceUnit.reference }];
  fixture.task.input_payload.fit_input = {
    assessment_request_id: "fit-request",
    job_id: fixture.task.job_id,
    job_snapshot_id: "snapshot-id",
    profile_snapshot_hash: "profile-hash",
    vacancy_snapshot_hash: "vacancy-hash",
    rubric_version: "job-fit-rubric-v3.0",
    candidate_background: [],
    vacancy: { title: "Engineer", company: "Example", description: "A frozen listing description." },
    criteria_source_units: [sourceUnit],
    criteria: [],
  };
  const unitResponse = {
    schema_version: "job-fit-criteria-unit-v3.1",
    assessment_request_id: "fit-request",
    job_id: fixture.task.job_id,
    vacancy_snapshot_hash: "vacancy-hash",
    source_unit_reference: sourceUnit.reference,
    disposition: "criteria",
    criteria: [{ text: sourceUnit.text, dimension: "technical", importance: "essential" }],
    duplicate_of_source_unit_reference: null,
    reason: "The source states an essential job capability.",
  };
  fixture.dispatch.idempotency_key = `jobfit-${fixture.task.id}:1:0`;
  fixture.dispatch.bridge_response = JSON.stringify(unitResponse);

  const calls = [];
  let transitionBody;
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.action);
    if (body.action === "fit_claim") return response({ ok: true, tasks: [fixture.task] });
    if (body.action === "fit_status") return response({ ok: true, dispatch: fixture.dispatch });
    if (body.action === "fit_captures") return response({ ok: true, captures: [] });
    if (body.action === "fit_transition") {
      transitionBody = body;
      return response({ ok: true, data: { state: "queued" } });
    }
    if (body.action === "fit_kick") return response({ ok: true, claimed: 1, outcomes: [{ state: "waiting_for_bridge", dispatched: true }] });
    throw new Error(`Unexpected worker action ${body.action}`);
  };

  const counts = await runJobFitV3Scheduler(env, fetcher);

  assert.equal(counts.failed, 0);
  assert.deepEqual(calls, ["fit_claim", "fit_status", "fit_captures", "fit_transition", "fit_kick"]);
  assert.equal(transitionBody.transition, "capture_criteria");
  assert.equal(transitionBody.input_payload.fit_input.criteria.length, 1);
  assert.equal(transitionBody.steps.at(-1).phase, "assessment");
  assert.ok(transitionBody.steps.length > 1, "the complete prepared context and assessment are frozen before the kick");
});

test("immediate fit wake-up failure leaves the exact capture durable for the minute-cron fallback", async () => {
  const fixture = completedContextTask();
  const actions = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    actions.push(body.action);
    if (body.action === "fit_claim") return response({ ok: true, tasks: [fixture.task] });
    if (body.action === "fit_status") return response({ ok: true, dispatch: fixture.dispatch });
    if (body.action === "fit_transition") return response({ ok: true, data: { state: "queued" } });
    if (body.action === "fit_kick") return response({ ok: false, error: "temporarily unavailable" }, 503);
    if (body.action === "fit_release") return response({ ok: true, data: { released: true } });
    throw new Error(`Unexpected worker action ${body.action}`);
  };

  const counts = await runJobFitV3Scheduler(env, fetcher);

  assert.equal(counts.needsUser, 0);
  assert.deepEqual(actions, ["fit_claim", "fit_status", "fit_transition", "fit_kick"]);
});

test("a successful but lock-blocked wake-up leaves the queued step for cron without marking it failed", async () => {
  const fixture = completedContextTask();
  const actions = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    actions.push(body.action);
    if (body.action === "fit_claim") return response({ ok: true, tasks: [fixture.task] });
    if (body.action === "fit_status") return response({ ok: true, dispatch: fixture.dispatch });
    if (body.action === "fit_transition") return response({ ok: true, data: { state: "queued" } });
    if (body.action === "fit_kick") return response({ ok: true, claimed: 1, outcomes: [{ state: "queued", dispatched: false }] });
    throw new Error(`Unexpected worker action ${body.action}`);
  };

  const counts = await runJobFitV3Scheduler(env, fetcher);

  assert.equal(counts.failed, 0);
  assert.equal(counts.needsUser, 0);
  assert.deepEqual(actions, ["fit_claim", "fit_status", "fit_transition", "fit_kick"]);
});

test("paused rollout records a completed context but does not kick a subsequent prompt", async () => {
  const fixture = completedContextTask();
  const actions = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    actions.push(body.action);
    if (body.action === "fit_claim") return response({ ok: true, tasks: [fixture.task] });
    if (body.action === "fit_status") return response({ ok: true, dispatch: fixture.dispatch });
    if (body.action === "fit_transition") return response({ ok: true, data: { state: "queued" } });
    throw new Error(`Unexpected worker action ${body.action}`);
  };

  const counts = await runJobFitV3Scheduler({ ...env, JOB_FIT_V3_MODE: "paused" }, fetcher);

  assert.equal(counts.needsUser, 0);
  assert.deepEqual(actions, ["fit_claim", "fit_status", "fit_transition"]);
});
