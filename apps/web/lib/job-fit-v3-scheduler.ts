import { buildPersistencePayload } from "./job-fit-v3/server.ts";
import { buildPreparedAssessmentSteps } from "./job-fit-v3/prompt.ts";
import type { AssessmentStep } from "./job-fit-v3/prompt.ts";
import { finalizePreparedCriteria, parseCriterionGroupResponse, parseCriterionUnitResponse, validateCriterionGroupResponse, validateCriterionUnitResponse } from "./job-fit-v3/criteria-preparation.ts";
import { snapshotHash } from "./job-fit-v3/input.ts";
import { processExactResponse } from "./job-fit-v3/workflow.ts";
import type { JobPoolSchedulerEnvironment } from "./job-pool-scheduler.ts";

type FitTask = Record<string, any> & {
  id: string;
  user_id: string;
  batch_id: string;
  job_id: string;
  lease_token: string;
  state: "queued" | "waiting_for_bridge" | "saving";
  current_step_index: number;
  attempt_count: number;
  input_payload: Record<string, any>;
  steps: AssessmentStep[];
};

type FitSchedulerEnvironment = JobPoolSchedulerEnvironment & {
  JOB_FIT_V3_MODE?: string;
  JOB_FIT_V3_CANARY_USER_IDS?: string;
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function rolloutAllowed(userId: string, env: FitSchedulerEnvironment) {
  if (env.JOB_FIT_V3_MODE === "enabled") return true;
  if (env.JOB_FIT_V3_MODE !== "canary") return false;
  return (env.JOB_FIT_V3_CANARY_USER_IDS || "").split(",").map((item) => item.trim()).filter(Boolean).includes(userId);
}

async function workerRequest(
  env: FitSchedulerEnvironment,
  fetcher: typeof fetch,
  action: string,
  payload: Record<string, unknown> = {},
) {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || !env.JOB_POOL_SCHEDULER_SECRET) {
    throw new Error("fit_scheduler_not_configured");
  }
  const response = await fetcher(new URL("/functions/v1/job-pool-scheduler", env.NEXT_PUBLIC_SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`,
      "content-type": "application/json",
      "x-job-pool-scheduler-secret": env.JOB_POOL_SCHEDULER_SECRET,
    },
    body: JSON.stringify({ action, ...payload }),
    cache: "no-store",
  });
  const body = record(await response.json().catch(() => null));
  if (!response.ok || body.ok !== true) throw new Error(typeof body.error === "string" ? body.error : `fit_scheduler_${action}_failed`);
  return body;
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "The exact saved fit step could not be validated.";
  return `${message.slice(0, 900)} The original ChatGPT message was not resent.`;
}

async function release(env: FitSchedulerEnvironment, fetcher: typeof fetch, task: FitTask) {
  await workerRequest(env, fetcher, "fit_release", {
    user_id: task.user_id, task_id: task.id, lease_token: task.lease_token,
  });
}

async function needsUser(
  env: FitSchedulerEnvironment,
  fetcher: typeof fetch,
  task: FitTask,
  dispatchId: string | null,
  message: string,
) {
  await workerRequest(env, fetcher, "fit_transition", {
    user_id: task.user_id,
    task_id: task.id,
    expected_state: task.state,
    expected_step_index: task.current_step_index,
    dispatch_id: dispatchId,
    transition: "needs_user",
    error: message.slice(0, 1000),
    lease_token: task.lease_token,
  });
}

/**
 * Capturing a context or criterion response makes the next immutable step
 * eligible. Start that step immediately when this user's rollout is enabled;
 * the minute cron remains the durable recovery path if the wake-up fails or
 * the shared ChatGPT-operation lock is still held. This only claims the next
 * saved step through the existing worker/Bridge flow and never replays the
 * response that was just captured.
 */
async function kickNextSavedStep(task: FitTask, env: FitSchedulerEnvironment, fetcher: typeof fetch) {
  if (!rolloutAllowed(task.user_id, env)) return;
  try {
    await workerRequest(env, fetcher, "fit_kick", { user_id: task.user_id });
  } catch {
    console.warn("V3 fit step was saved; the minute scheduler remains the recovery path.");
  }
}

async function advanceCompleted(task: FitTask, dispatch: Record<string, any>, env: FitSchedulerEnvironment, fetcher: typeof fetch) {
  const step: AssessmentStep | undefined = task.steps[task.current_step_index];
  const input = task.input_payload.fit_input;
  if (!step || !input || !dispatch.id) throw new Error("The saved fit input or active step is missing.");
  const processed = processExactResponse({
    input,
    taskId: task.id,
    attempt: task.attempt_count,
    step,
    dispatch,
    expectedDispatchId: dispatch.id,
    expectedConversationUrl: typeof task.conversation_url === "string" ? task.conversation_url : undefined,
    assessmentAsOf: new Date(task.assessment_as_of),
  });
  if (!processed.ready) return { state: "waiting_for_bridge" as const };

  const capture = {
    response_text: dispatch.bridge_response,
    response_hash: dispatch.response_hash,
    response_provenance: dispatch.response_provenance,
  };
  if (processed.phase === "context") {
    const saved = record((await workerRequest(env, fetcher, "fit_transition", {
      user_id: task.user_id, task_id: task.id, expected_state: task.state,
      expected_step_index: task.current_step_index, dispatch_id: dispatch.id,
      transition: "capture_context", capture, lease_token: task.lease_token,
    })).data);
    if (saved.state !== "queued") throw new Error("The exact context response was not recorded as durable progress.");
    await kickNextSavedStep(task, env, fetcher);
    return { state: "queued" as const };
  }

  if (processed.phase === "criteria") {
    const captureBody = await workerRequest(env, fetcher, "fit_captures", {
      user_id: task.user_id, task_id: task.id, lease_token: task.lease_token,
    });
    const priorCaptures = Array.isArray(captureBody.captures) ? captureBody.captures : [];
    const currentPrepared = Array.isArray(processed.result) ? processed.result : [processed.result];
    const prepared = priorCaptures.flatMap((raw: unknown) => {
      const row = record(raw);
      const sourceStep = task.steps[Number(row.step_index)];
      if (typeof row.bridge_response !== "string") throw new Error("A saved criterion capture no longer matches its frozen listing source.");
      if (Array.isArray(sourceStep?.source_unit_references) && typeof sourceStep.group_id === "string") {
        const units = sourceStep.source_unit_references.map((reference: unknown) => input.criteria_source_units.find((candidate: any) => candidate.reference === reference));
        if (units.some((unit: unknown) => !unit)) throw new Error("A saved criterion group no longer matches its frozen listing source.");
        return validateCriterionGroupResponse(parseCriterionGroupResponse(row.bridge_response), input, sourceStep.group_id, units);
      }
      const unit = input.criteria_source_units.find((candidate: any) => candidate.reference === sourceStep?.source_unit_reference);
      if (!unit) throw new Error("A saved criterion capture no longer matches its frozen listing source.");
      return [validateCriterionUnitResponse(parseCriterionUnitResponse(row.bridge_response), input, unit)];
    }).flat().filter((item: any) => !currentPrepared.some((current: any) => current.source_unit_reference === item.source_unit_reference));
    prepared.push(...currentPrepared);
    const nextIndex = task.current_step_index + 1;
    const allPrepared = input.criteria_source_units.every((unit: any) => prepared.some((item: any) => item.source_unit_reference === unit.reference));
    let nextInputPayload: Record<string, any> | null = null;
    let nextSteps: Array<Record<string, any>> | null = null;
    let nextInputHash: string | null = null;
    if (allPrepared) {
      const criteria = finalizePreparedCriteria(input, prepared);
      const finalInput = { ...input, criteria };
      nextSteps = [...task.steps, ...buildPreparedAssessmentSteps(finalInput, Boolean(task.testing_mode), nextIndex)];
      if (nextSteps.length > 200) throw new Error("This listing and profile need more than 200 safe fit-analysis steps. Shorten the source material and start a fresh analysis; no source was truncated.");
      nextInputPayload = { ...task.input_payload, fit_input: finalInput };
      nextInputHash = snapshotHash(finalInput);
    }
    const saved = record((await workerRequest(env, fetcher, "fit_transition", {
      user_id: task.user_id, task_id: task.id, expected_state: task.state,
      expected_step_index: task.current_step_index, dispatch_id: dispatch.id,
      transition: "capture_criteria", capture,
      input_payload: nextInputPayload, steps: nextSteps, input_hash: nextInputHash,
      lease_token: task.lease_token,
    })).data);
    if (saved.state !== "queued") throw new Error("The exact criterion response was not recorded as durable progress.");
    await kickNextSavedStep(task, env, fetcher);
    return { state: "queued" as const, preparedCount: prepared.length, totalUnits: input.criteria_source_units.length };
  }

  const persistence = buildPersistencePayload(input, processed.result, record(task.input_payload.priority_preferences), new Date(task.assessment_as_of));
  const resultJson = {
    response: processed.result.criteria,
    assessment: persistence.assessment,
    priority: persistence.priority,
    analysis: persistence.analysis,
    requirements: persistence.requirements,
  };
  const saved = record((await workerRequest(env, fetcher, "fit_transition", {
    user_id: task.user_id, task_id: task.id, expected_state: task.state,
    expected_step_index: task.current_step_index, dispatch_id: dispatch.id,
    transition: "capture_assessment", capture, result_json: resultJson,
    lease_token: task.lease_token,
  })).data);
  if (saved.state !== "saving") throw new Error("The exact assessment response was not saved for publication.");
  return { state: "saving" as const };
}

async function processTask(task: FitTask, env: FitSchedulerEnvironment, fetcher: typeof fetch) {
  if (!task.id || !task.user_id || !task.lease_token) throw new Error("The fit scheduler claim is malformed.");
  if (task.state === "queued") {
    if (!rolloutAllowed(task.user_id, env)) {
      await release(env, fetcher, task);
      return "paused" as const;
    }
    const dispatchBody = await workerRequest(env, fetcher, "fit_dispatch", {
      user_id: task.user_id, task_id: task.id, lease_token: task.lease_token,
    });
    const dispatch = record(dispatchBody.data);
    if (dispatch.state === "waiting_for_bridge") return "dispatched" as const;
    if (dispatch.state === "queued" && dispatch.blocked === true) return "blocked" as const;
    if (dispatch.state === "needs_user") return "needs_user" as const;
    throw new Error("The fit worker returned an unknown saved-step dispatch outcome.");
  }

  if (task.state === "saving") {
    const body = await workerRequest(env, fetcher, "fit_save", {
      user_id: task.user_id, task_id: task.id, lease_token: task.lease_token,
    });
    const state = record(body.data).state;
    return state === "completed" ? "completed" as const : state === "needs_user" ? "needs_user" as const : "saving" as const;
  }

  if (task.state !== "waiting_for_bridge" || typeof task.active_dispatch_id !== "string") {
    await needsUser(env, fetcher, task, null, "The saved task did not match its active Bridge dispatch. Review the batch; no message was resent.");
    return "needs_user" as const;
  }
  const statusBody = await workerRequest(env, fetcher, "fit_status", {
    user_id: task.user_id, task_id: task.id, dispatch_id: task.active_dispatch_id, lease_token: task.lease_token,
  });
  const dispatch = record(statusBody.dispatch);
  if (dispatch.state === "completed") {
    try {
      const result = await advanceCompleted(task, dispatch, env, fetcher);
      return result.state;
    } catch (error) {
      await needsUser(env, fetcher, task, task.active_dispatch_id, safeMessage(error));
      return "needs_user" as const;
    }
  }
  if (["user_required", "failed", "expired", "cancelled"].includes(String(dispatch.state))) {
    const reason = typeof dispatch.error?.message === "string" ? dispatch.error.message : "The Website Bridge stopped before confirming a complete assistant response.";
    await needsUser(env, fetcher, task, task.active_dispatch_id, `${reason} Review the exact saved request before retrying; no message was resent.`);
    return "needs_user" as const;
  }
  await release(env, fetcher, task);
  return "waiting" as const;
}

/** Advance durable exact-turn fit steps independently of an open browser page. */
export async function runJobFitV3Scheduler(env: FitSchedulerEnvironment, fetcher: typeof fetch = fetch) {
  const claimBody = await workerRequest(env, fetcher, "fit_claim", { limit: 5 });
  const tasks = Array.isArray(claimBody.tasks) ? claimBody.tasks.slice(0, 5).map((task: unknown) => record(task) as FitTask) : [];
  const counts = { claimed: tasks.length, dispatched: 0, blocked: 0, completed: 0, waiting: 0, saving: 0, needsUser: 0, paused: 0, failed: 0 };
  await Promise.all(tasks.map(async (task) => {
    try {
      const outcome = await processTask(task, env, fetcher);
      if (outcome === "dispatched") counts.dispatched += 1;
      else if (outcome === "blocked") counts.blocked += 1;
      else if (outcome === "completed") counts.completed += 1;
      else if (outcome === "waiting") counts.waiting += 1;
      else if (outcome === "saving") counts.saving += 1;
      else if (outcome === "needs_user") counts.needsUser += 1;
      else if (outcome === "paused") counts.paused += 1;
    } catch {
      counts.failed += 1;
      try { await release(env, fetcher, task); } catch { /* lease expiry is the final recovery path */ }
    }
  }));
  return counts;
}
