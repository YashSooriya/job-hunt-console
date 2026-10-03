import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { exactMemoryFitDispatchMatches } from "../../../apps/web/lib/job-fit-memory-v4/dispatch-contract.ts";
import { buildMemoryFitChunkPersistence, isMemoryFitPersistenceIntegrityFailure } from "../../../apps/web/lib/job-fit-memory-v4/worker.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = SUPABASE_URL && SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const size = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < size; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function memoryFitWorkerRpc(name: string, args: Record<string, unknown>) {
  if (!supabase) throw new Error("The job-pool scheduler is not configured.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

function terminalMemoryFitDispatch(state: unknown) {
  return ["failed", "expired", "cancelled", "user_required"].includes(String(state));
}

async function processMemoryFitClaim(claim: Record<string, unknown>) {
  const userId = claim.user_id;
  const batchId = claim.batch_id;
  const leaseToken = claim.lease_token;
  if (!uuid(userId) || !uuid(batchId) || !uuid(leaseToken)) throw new Error("The Memory-fit worker claim is invalid.");
  const lease = { p_user_id: userId, p_batch_id: batchId, p_lease_token: leaseToken };
  let outcome: Record<string, unknown> = { state: "idle" };
  const readContext = async () => record(await memoryFitWorkerRpc("job_fit_memory_v4_worker_context", lease));
  const requireChunk = (context: Record<string, unknown>) => {
    const chunk = record(context.chunk);
    if (!uuid(chunk.id)) return null;
    return chunk;
  };
  const markNeedsUser = async (chunk: Record<string, unknown>, message: string) => {
    await memoryFitWorkerRpc("job_fit_memory_v4_worker_needs_user", {
      ...lease, p_chunk_id: chunk.id, p_error: message.slice(0, 1000),
    });
  };
  const dispatchQueued = async (chunk: Record<string, unknown>) => {
    const result = record(await memoryFitWorkerRpc("job_fit_memory_v4_worker_dispatch", {
      ...lease, p_chunk_id: chunk.id,
    }));
    return { state: String(result.state || "queued"), ...(result.dispatch_id ? { dispatch_id: result.dispatch_id } : {}) };
  };

  try {
    let context = await readContext();
    let chunk = requireChunk(context);
    if (!chunk) return { state: "idle" };

    if (chunk.state === "waiting_for_bridge") {
      const dispatch = record(context.dispatch);
      if (!exactMemoryFitDispatchMatches(dispatch, chunk)) {
        await markNeedsUser(chunk, "The saved Website Bridge request no longer matches this exact Memory-only job group. No replacement message was sent.");
        context = await readContext();
        chunk = requireChunk(context);
        if (!chunk) return { state: "needs_user" };
      } else if (dispatch.state === "completed") {
        const capture = await supabase!.rpc("job_fit_memory_v4_worker_capture", {
          ...lease, p_chunk_id: chunk.id, p_dispatch_id: dispatch.id,
        });
        if (capture.error) {
          const exactCaptureFailure = capture.error.code === "P0001"
            && /^(The dispatch is not the exact completed Memory-fit request|The dispatch lacks exact sent-user-turn and finished-assistant-turn provenance)/.test(capture.error.message || "");
          if (!exactCaptureFailure) throw capture.error;
          await markNeedsUser(chunk, `${capture.error.message} The captured dispatch was not resent.`);
          context = await readContext();
          chunk = requireChunk(context);
          if (!chunk) return { state: "needs_user" };
        } else {
          context = await readContext();
          chunk = requireChunk(context);
          if (!chunk) return { state: "captured" };
        }
      } else if (terminalMemoryFitDispatch(dispatch.state)) {
        const error = record(dispatch.error_json);
        await markNeedsUser(chunk, String(error.message || "ChatGPT could not finish this exact saved request. Review its Bridge status; the message was not resent."));
        context = await readContext();
        chunk = requireChunk(context);
        if (!chunk) return { state: "needs_user" };
      } else {
        return { state: "waiting_for_bridge" };
      }
    }

    if (chunk.state === "saving") {
      const contextItems = Array.isArray(context.items) ? context.items.map(record) : [];
      const expectedCount = Array.isArray(chunk.job_ids) ? chunk.job_ids.length : 0;
      if (!expectedCount || contextItems.length !== expectedCount) {
        await markNeedsUser(chunk, "The saved job group no longer has all of its original job records. No ChatGPT message was sent or resent.");
        context = await readContext();
        chunk = requireChunk(context);
        if (!chunk) return { state: "needs_user" };
      } else {
        const savingChunk = chunk;
        try {
          const prepared = buildMemoryFitChunkPersistence({
            batch: record(context.batch), chunk: savingChunk,
            items: contextItems.map((row) => record(row.item)),
            contextRows: contextItems,
            preferences: record(context.preferences),
          });
          await memoryFitWorkerRpc("job_fit_memory_v4_worker_save", {
            ...lease, p_chunk_id: savingChunk.id, p_results: prepared.results,
          });
          outcome = { state: prepared.malformedEnvelope ? "captured_invalid_response_saved" : "captured_result_saved" };
          context = await readContext();
          chunk = requireChunk(context);
          if (!chunk) return outcome;
        } catch (error) {
          if (!isMemoryFitPersistenceIntegrityFailure(error)) throw error;
          const message = error instanceof Error ? error.message : "The captured response integrity check failed.";
          await markNeedsUser(savingChunk, `${message} The captured response was not resent.`);
          context = await readContext();
          chunk = requireChunk(context);
          if (!chunk) return { state: "needs_user" };
        }
      }
    }

    if (chunk.state === "queued") {
      const dispatchOutcome = await dispatchQueued(chunk);
      return outcome.state === "idle" ? dispatchOutcome : { ...outcome, next_dispatch_state: dispatchOutcome.state, dispatch_id: dispatchOutcome.dispatch_id };
    }
    if (chunk.state === "waiting_for_bridge") return { ...outcome, state: "waiting_for_bridge" };
    if (chunk.state === "saving") return { ...outcome, state: "saving" };
    if (chunk.state === "needs_user") return { ...outcome, state: "needs_user" };
    return { ...outcome, state: String(chunk.state || "idle") };
  } finally {
    const { error } = await supabase!.rpc("job_fit_memory_v4_worker_release", {
      p_batch_id: batchId, p_user_id: userId, p_lease_token: leaseToken,
    });
    if (error) console.warn("Memory-fit worker lease will expire and be reclaimed.", { batchId });
  }
}

async function runMemoryFitWorker(limit: number) {
  const data = await memoryFitWorkerRpc("job_fit_memory_v4_worker_claim", { p_limit: limit });
  const claims = Array.isArray(data) ? data.slice(0, limit).map(record) : [];
  const outcomes: Array<Record<string, unknown>> = [];
  for (const claim of claims) {
    const batchId = typeof claim.batch_id === "string" ? claim.batch_id : null;
    try {
      outcomes.push({ batch_id: batchId, ...(await processMemoryFitClaim(claim)) });
    } catch (error) {
      console.warn("Memory-fit worker could not advance a saved batch; it will retry from durable progress.", { batchId });
      if (uuid(claim.user_id) && uuid(claim.batch_id) && uuid(claim.lease_token)) {
        await supabase!.rpc("job_fit_memory_v4_worker_release", {
          p_batch_id: claim.batch_id, p_user_id: claim.user_id, p_lease_token: claim.lease_token,
        });
      }
      outcomes.push({ batch_id: batchId, state: "retryable_error", error: error instanceof Error ? error.message.slice(0, 500) : "Temporary worker error." });
    }
  }
  return { ok: true, claimed: claims.length, outcomes };
}

const CHECK_ERRORS = new Set([
  "google_reconnect_required",
  "google_sheet_not_accessible",
  "google_sheet_check_unavailable",
]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  if (!supabase) return json({ ok: false, error: "The job-pool scheduler is not configured." }, 503);
  const { data: configuredSecret, error: secretError } = await supabase.rpc("get_job_pool_scheduler_secret");
  if (secretError || typeof configuredSecret !== "string" || configuredSecret.length < 32) {
    return json({ ok: false, error: "The job-pool scheduler is not configured." }, 503);
  }
  const suppliedSecret = request.headers.get("x-job-pool-scheduler-secret") ?? "";
  if (!constantTimeEqual(suppliedSecret, configuredSecret)) return json({ ok: false, error: "Not authorized." }, 401);

  let body: Record<string, unknown>;
  try { body = record(await request.json()); }
  catch { return json({ ok: false, error: "The scheduler request is invalid." }, 400); }

  if (body.action === "fit_create") {
    const userId = body.user_id;
    const requestId = body.request_id;
    const mode = body.mode;
    const jobIds = body.job_ids;
    const tasks = body.tasks;
    if (!uuid(userId) || !uuid(requestId) || !["pending", "selected", "outdated", "retry"].includes(String(mode))
      || !Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > 100 || jobIds.some((id) => !uuid(id))
      || new Set(jobIds).size !== jobIds.length || !Array.isArray(tasks) || tasks.length !== jobIds.length || tasks.length > 100
      || new TextEncoder().encode(JSON.stringify(tasks)).byteLength > 8 * 1024 * 1024) {
      return json({ ok: false, error: "The trusted fit-analysis batch is invalid or too large." }, 400);
    }
    const { data, error } = await supabase.rpc("job_fit_v3_worker_create_batch", {
      p_user_id: userId, p_request_id: requestId, p_mode: mode, p_job_ids: jobIds, p_tasks: tasks,
    });
    if (error) {
      console.error("V3 fit batch creation was rejected by its database boundary.");
      return json({ ok: false, error: "Unable to save the validated fit-analysis batch." }, 409);
    }
    return json({ ok: true, data });
  }

  if (body.action === "memory_fit_advance") {
    const limit = Number(body.limit ?? 5);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) return json({ ok: false, error: "The Memory-fit scheduler claim limit is invalid." }, 400);
    try { return json(await runMemoryFitWorker(limit)); }
    catch {
      console.error("Memory-only fit scheduler could not claim durable work.");
      return json({ ok: false, error: "Unable to advance saved Memory-only fit work." }, 503);
    }
  }

  if (body.action === "fit_claim" || body.action === "fit_kick") {
    const requestedLimit = body.action === "fit_kick" ? 1 : Number(body.limit ?? 5);
    // fit_kick has always been user-scoped. Interactive progress wakes may
    // also scope fit_claim to the authenticated caller; cron omits user_id
    // and retains its existing global, bounded claim behavior.
    const targetUserId = body.action === "fit_kick" ? body.user_id : body.user_id ?? null;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5
      || (body.action === "fit_kick" && !uuid(targetUserId))
      || (targetUserId !== null && !uuid(targetUserId))) {
      return json({ ok: false, error: "The fit scheduler claim request is invalid." }, 400);
    }
    const { data, error } = await supabase.rpc("job_fit_v3_worker_claim", {
      p_limit: requestedLimit, p_user_id: targetUserId,
    });
    if (error) {
      console.error("V3 fit scheduler could not claim work.");
      return json({ ok: false, error: "Unable to claim V3 fit-analysis work." }, 503);
    }
    const tasks = Array.isArray(data) ? data.slice(0, requestedLimit).map(record) : [];
    if (body.action === "fit_claim") return json({ ok: true, tasks });
    const outcomes: Array<Record<string, unknown>> = [];
    for (const task of tasks) {
      if (task.state !== "queued" || !uuid(task.id) || !uuid(task.user_id) || !uuid(task.lease_token)) {
        if (uuid(task.id) && uuid(task.user_id) && uuid(task.lease_token)) {
          await supabase.rpc("job_fit_v3_worker_release", {
            p_user_id: task.user_id, p_task_id: task.id, p_lease_token: task.lease_token,
          });
        }
        outcomes.push({ state: task.state, dispatched: false });
        continue;
      }
      const result = await supabase.rpc("job_fit_v3_worker_dispatch", {
        p_user_id: task.user_id, p_task_id: task.id, p_lease_token: task.lease_token,
      });
      if (result.error) {
        await supabase.rpc("job_fit_v3_worker_release", {
          p_user_id: task.user_id, p_task_id: task.id, p_lease_token: task.lease_token,
        });
        outcomes.push({ state: "queued", dispatched: false });
        continue;
      }
      const data = record(result.data);
      outcomes.push({ state: data.state, dispatched: data.state === "waiting_for_bridge", dispatch_id: data.dispatch_id ?? null });
    }
    return json({ ok: true, claimed: tasks.length, outcomes });
  }

  if (body.action === "fit_dispatch") {
    if (!uuid(body.user_id) || !uuid(body.task_id) || !uuid(body.lease_token)) return json({ ok: false, error: "A fit scheduler reference is invalid." }, 400);
    const { data, error } = await supabase.rpc("job_fit_v3_worker_dispatch", {
      p_user_id: body.user_id, p_task_id: body.task_id, p_lease_token: body.lease_token,
    });
    if (error) {
      console.error("V3 fit scheduler could not dispatch a saved step.");
      return json({ ok: false, error: "Unable to dispatch the saved fit-analysis step." }, 409);
    }
    return json({ ok: true, data });
  }

  if (body.action === "fit_status") {
    if (!uuid(body.user_id) || !uuid(body.task_id) || !uuid(body.dispatch_id) || !uuid(body.lease_token)) return json({ ok: false, error: "A fit scheduler status reference is invalid." }, 400);
    const { data, error } = await supabase.rpc("job_fit_v3_worker_status", {
      p_user_id: body.user_id, p_task_id: body.task_id, p_dispatch_id: body.dispatch_id, p_lease_token: body.lease_token,
    });
    if (error) {
      console.error("V3 fit scheduler could not read the exact generic Bridge status.");
      return json({ ok: false, error: "Unable to read exact fit-analysis Bridge progress." }, 409);
    }
    return json({ ok: true, dispatch: data });
  }

  if (body.action === "fit_captures") {
    if (!uuid(body.user_id) || !uuid(body.task_id) || !uuid(body.lease_token)) return json({ ok: false, error: "A fit scheduler capture reference is invalid." }, 400);
    const { data, error } = await supabase.rpc("job_fit_v3_worker_captures", {
      p_user_id: body.user_id, p_task_id: body.task_id, p_lease_token: body.lease_token,
    });
    if (error) {
      console.error("V3 fit scheduler could not read saved criterion captures.");
      return json({ ok: false, error: "Unable to read the saved criterion-preparation captures." }, 409);
    }
    return json({ ok: true, captures: Array.isArray(data) ? data.slice(0, 200) : [] });
  }

  if (body.action === "fit_release") {
    if (!uuid(body.user_id) || !uuid(body.task_id) || !uuid(body.lease_token)) return json({ ok: false, error: "A fit scheduler lease reference is invalid." }, 400);
    const { data, error } = await supabase.rpc("job_fit_v3_worker_release", {
      p_user_id: body.user_id, p_task_id: body.task_id, p_lease_token: body.lease_token,
    });
    if (error) return json({ ok: false, error: "Unable to release the fit scheduler lease." }, 409);
    return json({ ok: true, data });
  }

  if (body.action === "fit_transition") {
    const taskId = body.task_id;
    const userId = body.user_id;
    const expectedState = body.expected_state;
    const expectedStepIndex = body.expected_step_index;
    const dispatchId = body.dispatch_id ?? null;
    const action = body.transition;
    const allowedStates = new Set(["queued", "waiting_for_bridge", "saving", "needs_user", "failed"]);
    const allowedActions = new Set(["attach", "mark_waiting", "needs_user", "failed", "capture_context", "capture_criteria", "capture_assessment"]);
    if (!uuid(taskId) || !uuid(userId) || typeof expectedState !== "string" || !allowedStates.has(expectedState)
      || !Number.isInteger(expectedStepIndex) || Number(expectedStepIndex) < 0 || Number(expectedStepIndex) > 500
      || (dispatchId !== null && !uuid(dispatchId)) || typeof action !== "string" || !allowedActions.has(action)
      || (body.error !== null && body.error !== undefined && (typeof body.error !== "string" || body.error.length > 1000))) {
      return json({ ok: false, error: "The trusted fit-analysis transition is invalid." }, 400);
    }
    const inputPayload = body.input_payload;
    const steps = body.steps;
    const inputHash = body.input_hash;
    const resultJson = body.result_json;
    const capture = body.capture;
    const leaseToken = body.lease_token;
    if ((inputPayload !== null && inputPayload !== undefined && (typeof inputPayload !== "object" || Array.isArray(inputPayload)))
      || (steps !== null && steps !== undefined && !Array.isArray(steps))
      || (inputHash !== null && inputHash !== undefined && (typeof inputHash !== "string" || !/^[0-9a-f]{64}$/.test(inputHash)))
      || (resultJson !== null && resultJson !== undefined && (typeof resultJson !== "object" || Array.isArray(resultJson)))
      || (capture !== null && capture !== undefined && (typeof capture !== "object" || Array.isArray(capture)))
      || (leaseToken !== null && leaseToken !== undefined && !uuid(leaseToken))
      || new TextEncoder().encode(JSON.stringify({ inputPayload, steps, resultJson, capture })).byteLength > 4 * 1024 * 1024) {
      return json({ ok: false, error: "The fit-analysis transition payload is invalid or too large." }, 400);
    }
    const { data, error } = await supabase.rpc("job_fit_v3_worker_transition", {
      p_user_id: userId, p_task_id: taskId, p_expected_state: expectedState,
      p_expected_step_index: expectedStepIndex, p_dispatch_id: dispatchId, p_action: action,
      p_error: typeof body.error === "string" ? body.error : null,
      p_input_payload: inputPayload ?? null, p_steps: steps ?? null, p_input_hash: inputHash ?? null,
      p_result_json: resultJson ?? null, p_capture: capture ?? null, p_lease_token: leaseToken ?? null,
    });
    if (error) {
      console.error("V3 fit transition was rejected by its database boundary.");
      return json({ ok: false, error: "Unable to save the validated fit-analysis progress." }, 409);
    }
    return json({ ok: true, data });
  }

  if (body.action === "fit_save") {
    if (!uuid(body.user_id) || !uuid(body.task_id) || !uuid(body.lease_token)) return json({ ok: false, error: "A fit task scheduler lease is invalid." }, 400);
    const { data, error } = await supabase.rpc("job_fit_v3_worker_save_result", {
      p_user_id: body.user_id, p_task_id: body.task_id, p_lease_token: body.lease_token,
    });
    if (error) {
      console.error("V3 fit result save was rejected by its database boundary.");
      return json({ ok: false, error: "Unable to save the captured fit result." }, 409);
    }
    return json({ ok: true, data });
  }

  if (body.action === "claim") {
    const { data, error } = await supabase.rpc("claim_due_job_pool_sheet_checks");
    if (error) {
      console.error("Job-pool scheduler could not claim due checks.");
      return json({ ok: false, error: "Unable to claim due Job Pool Sheet checks." }, 503);
    }
    const claims = Array.isArray(data) ? data : [];
    return json({ ok: true, checks: claims });
  }

  if (body.action === "finish") {
    const rawResults = Array.isArray(body.results) ? body.results : null;
    const results = rawResults?.slice(0, 25) ?? [];
    if (!results.length || results.length !== rawResults?.length) return json({ ok: false, error: "The scheduler result batch is invalid." }, 400);
    const outcomes: Array<{ ok: boolean; reason?: string }> = [];
    for (const raw of results) {
      const result = record(raw);
      const userId = result.user_id;
      const leaseId = result.lease_id;
      const sourceRevision = result.source_revision;
      const observedVersion = result.observed_version;
      const errorCode = result.error;
      if (!uuid(userId) || !uuid(leaseId) || !Number.isSafeInteger(sourceRevision)
        || (observedVersion !== null && observedVersion !== undefined && (typeof observedVersion !== "string" || observedVersion.length > 100))
        || (errorCode !== null && errorCode !== undefined && (typeof errorCode !== "string" || !CHECK_ERRORS.has(errorCode)))) {
        return json({ ok: false, error: "A Drive-check result failed validation." }, 400);
      }
      const { data, error } = await supabase.rpc("finish_job_pool_sheet_drive_check", {
        p_user_id: userId,
        p_lease_id: leaseId,
        p_source_revision: sourceRevision,
        p_observed_version: typeof observedVersion === "string" ? observedVersion : null,
        p_error: typeof errorCode === "string" ? errorCode : null,
      });
      if (error) {
        outcomes.push({ ok: false, reason: "lease_or_database_error" });
        continue;
      }
      const outcome = record(data);
      outcomes.push({ ok: outcome.ok === true, ...(typeof outcome.reason === "string" ? { reason: outcome.reason } : {}) });
    }
    return json({ ok: true, recorded: outcomes.length, outcomes });
  }

  if (body.action === "analysis_claim") {
    const requestedLimit = Number(body.limit ?? 5);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5) {
      return json({ ok: false, error: "The analysis claim size is invalid." }, 400);
    }
    const { data, error } = await supabase.rpc("claim_job_analysis_tasks", { p_limit: requestedLimit });
    if (error) {
      console.error("Job-analysis scheduler could not claim work.");
      return json({ ok: false, error: "Unable to claim job-analysis work." }, 503);
    }
    return json({ ok: true, tasks: Array.isArray(data) ? data : [] });
  }

  if (body.action === "analysis_finish") {
    const rawResults = Array.isArray(body.results) ? body.results : null;
    const results = rawResults?.slice(0, 5) ?? [];
    if (!results.length || results.length !== rawResults?.length) {
      return json({ ok: false, error: "The analysis result batch is invalid." }, 400);
    }
    const outcomes: Array<{ ok: boolean; state?: string; reason?: string }> = [];
    for (const raw of results) {
      const result = record(raw);
      const errorMessage = result.error;
      if (!uuid(result.task_id) || !uuid(result.lease_token)
        || (result.input_hash !== null && result.input_hash !== undefined && (typeof result.input_hash !== "string" || !/^[0-9a-f]{64}$/.test(result.input_hash)))
        || (result.engine_version !== null && result.engine_version !== undefined && result.engine_version !== "job-fit-v2")
        || (errorMessage !== null && errorMessage !== undefined && (typeof errorMessage !== "string" || errorMessage.length > 1000))
        || (result.analysis !== null && result.analysis !== undefined && (typeof result.analysis !== "object" || Array.isArray(result.analysis)))) {
        return json({ ok: false, error: "An analysis result failed validation." }, 400);
      }
      const { data, error } = await supabase.rpc("finish_job_analysis_task", {
        p_task_id: result.task_id,
        p_lease_token: result.lease_token,
        p_analysis: record(result.analysis),
        p_input_hash: typeof result.input_hash === "string" ? result.input_hash : "",
        p_engine_version: typeof result.engine_version === "string" ? result.engine_version : "job-fit-v2",
        p_error: typeof errorMessage === "string" ? errorMessage : null,
      });
      if (error) {
        outcomes.push({ ok: false, reason: "lease_or_database_error" });
        continue;
      }
      const outcome = record(data);
      outcomes.push({ ok: true, ...(typeof outcome.state === "string" ? { state: outcome.state } : {}) });
    }
    return json({ ok: true, recorded: outcomes.length, outcomes });
  }

  return json({ ok: false, error: "Unknown scheduler action." }, 400);
});
