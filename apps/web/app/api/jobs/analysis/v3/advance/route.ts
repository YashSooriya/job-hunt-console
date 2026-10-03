import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import {
  assessmentDispatchKey,
  responseCheckEligibility,
} from "@/lib/job-fit-v3/workflow";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";
import { runJobFitV3Scheduler } from "@/lib/job-fit-v3-scheduler";
import { callJobFitWorker, jobFitRuntimeBindings, jobFitV3Enabled } from "@/lib/job-fit-v3/worker-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FitTask = Record<string, any> & {
  id: string;
  user_id: string;
  job_id: string;
  attempt_count: number;
  current_step_index: number;
  state: string;
  active_dispatch_id: string | null;
  safe_unsent_retry_count: number;
  response_check_attempt_count: number;
  response_check_source_dispatch_id: string | null;
  response_check_source_attempt_count: number | null;
  response_check_last_requested_at: string | null;
  steps: Array<Record<string, any>>;
  input_payload: Record<string, any>;
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function dispatchHint(dispatch: Record<string, any>) {
  return {
    version: 1,
    type: "JOBHUNT_DISPATCH_HINT",
    request_id: String(dispatch.id),
    correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : String(dispatch.id),
    nonce: crypto.randomUUID(),
  };
}

function taskDispatchMatches(task: FitTask, dispatch: Record<string, any>, dispatchId: string, expectedAttempt = task.attempt_count) {
  const step = Array.isArray(task.steps) ? record(task.steps[task.current_step_index]) : {};
  const subjectJobIds = dispatch.subject_refs?.job_ids;
  return dispatch.id === dispatchId
    && task.active_dispatch_id === dispatchId
    && dispatch.action_type === "jobs.analyse_selected"
    && dispatch.idempotency_key === assessmentDispatchKey(task.id, expectedAttempt, Number(step.ordinal))
    && Array.isArray(subjectJobIds)
    && subjectJobIds.length === 1
    && subjectJobIds[0] === task.job_id
    && (dispatch.website_instruction ?? dispatch.manual_instruction) === step.text;
}

/**
 * A pre-delivery retry is safe only while the immutable input still describes
 * the current saved listing and profile. A newer edit must be re-analysed from
 * a newly frozen request instead of reviving a stale prompt.
 */
async function frozenInputIsCurrent(supabase: any, userId: string, task: FitTask) {
  const fitInput = record(task.input_payload?.fit_input);
  if (fitInput.job_id !== task.job_id
    || fitInput.profile_id === undefined
    || !Number.isSafeInteger(Number(task.job_revision))
    || !Number.isSafeInteger(Number(task.profile_revision))) return false;

  const [jobResult, profileResult] = await Promise.all([
    supabase.from("jobs").select("id,user_id,analysis_revision,current_snapshot_id").eq("id", task.job_id).eq("user_id", userId).maybeSingle(),
    supabase.from("candidate_profiles").select("id,user_id,analysis_revision").eq("user_id", userId).maybeSingle(),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (profileResult.error) throw profileResult.error;
  const job = record(jobResult.data);
  const profile = record(profileResult.data);
  return Boolean(job.id && profile.id
    && fitInput.profile_id === profile.id
    && fitInput.job_snapshot_id === job.current_snapshot_id
    && Number(job.analysis_revision) === Number(task.job_revision)
    && Number(profile.analysis_revision) === Number(task.profile_revision)
    && Number(fitInput.job_revision) === Number(task.job_revision)
    && Number(fitInput.profile_revision) === Number(task.profile_revision));
}

async function getOwnedTask(supabase: any, taskId: string, userId: string): Promise<FitTask | null> {
  const { data, error } = await supabase.from("job_fit_v3_tasks")
    .select("id,user_id,job_id,attempt_count,current_step_index,state,active_dispatch_id,safe_unsent_retry_count,response_check_attempt_count,response_check_source_dispatch_id,response_check_source_attempt_count,response_check_last_requested_at,steps,input_payload,job_revision,profile_revision")
    .eq("id", taskId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data ? data as FitTask : null;
}

async function getOwnedDispatch(supabase: any, dispatchId: string) {
  const { data, error } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: dispatchId });
  if (error) throw error;
  return record(data);
}

export async function POST(request: Request) {
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = record(await request.json().catch(() => null));
    const action = body.action;
    const taskId = body.taskId;
    const dispatchId = body.dispatchId;
    const validTaskId = typeof taskId === "string" && UUID.test(taskId);
    const validDispatchId = typeof dispatchId === "string" && UUID.test(dispatchId);
    const validAction = action === "wake_progress"
      ? validTaskId
      : ["check_pre_delivery", "check_response"].includes(String(action)) && validTaskId && validDispatchId;
    if (!validAction) {
      if (action === "retry_pre_delivery") {
        return response({ ok: false, error: "Profile-bearing V3 sends are retired. Run a fresh Memory-only analysis; this legacy message was not resent." }, 410);
      }
      return response({ ok: false, error: "Choose a valid safe-recovery action and saved fit dispatch." }, 400);
    }

    const { supabase, user } = await requireProfile();
    const task = await getOwnedTask(supabase, taskId, user.id);
    if (!task) return response({ ok: false, error: "Fit task not found." }, 404);

    if (action === "check_pre_delivery") {
      return response({ ok: true, safe: false, retired: true, dispatchId,
        message: "Profile-bearing V3 prompts are retired and cannot be re-sent. Start a fresh Memory-only analysis." });
    }

    if (action === "wake_progress") {
      // The browser may ask for a prompt-free scheduler wake only for a task
      // owned by the signed-in member and still in a durable active state.
      // The scheduler re-reads authoritative task/dispatch state and claims
      // at most one task for this user. It cannot replay a sent step.
      if (!["queued", "waiting_for_bridge", "saving"].includes(task.state)) {
        return response({ ok: true, advanced: false, state: task.state });
      }
      const runtime = jobFitRuntimeBindings();
      if (!jobFitV3Enabled(user.id, runtime.JOB_FIT_V3_MODE, runtime.JOB_FIT_V3_CANARY_USER_IDS)) {
        return response({ ok: false, error: "V3 fit analysis is temporarily paused. Saved progress remains available." }, 503);
      }
      const counts = await runJobFitV3Scheduler(runtime, fetch, { userId: user.id });
      return response({ ok: true, advanced: counts.claimed > 0, counts }, 202);
    }

    if (action === "check_response") {
      const step = Array.isArray(task.steps) ? record(task.steps[task.current_step_index]) : {};
      const eligibility = responseCheckEligibility({
        state: task.state,
        attemptCount: task.response_check_attempt_count,
        sourceDispatchId: task.response_check_source_dispatch_id,
        activeDispatchId: task.active_dispatch_id,
        requestedSourceDispatchId: dispatchId,
        lastRequestedAt: task.response_check_last_requested_at,
      });
      const recoveredAlready = task.response_check_attempt_count > 0
        && task.response_check_source_dispatch_id === dispatchId
        && task.state === "waiting_for_bridge"
        && typeof task.active_dispatch_id === "string";
      if (recoveredAlready) {
        const ticket = await getOwnedDispatch(supabase, task.active_dispatch_id as string);
        if (ticket.action_type !== "jobs.analyse_selected"
          || ticket.id !== task.active_dispatch_id
          || ticket.idempotency_key !== assessmentDispatchKey(task.id, task.attempt_count, Number(step.ordinal))
          || ticket.subject_refs?.response_check_for !== dispatchId
          || ticket.progress?.response_check_only !== true
          || !taskDispatchMatches(task, ticket, String(task.active_dispatch_id))) {
          return response({ ok: false, error: "The saved read-only recovery ticket no longer matches its exact fit step." }, 409);
        }
        return response({ ok: true, state: "waiting_for_bridge", dispatchId: ticket.id, responseCheckOnly: true, idempotent: true, bridge_hint: dispatchHint(ticket) }, 202);
      }
      if (!eligibility.allowed) {
        if (eligibility.reason === "rate_limited") return response({ ok: false, error: `Wait ${eligibility.retryAfterSeconds} seconds before checking this saved response again. No ChatGPT message was sent.`, retryAfterSeconds: eligibility.retryAfterSeconds }, 429);
        if (eligibility.reason === "exhausted") return response({ ok: false, error: "The four read-only checks for this saved response have been used. Refresh the fit analysis to start a new attempt; the original prompt will not be resent." }, 409);
        return response({ ok: false, error: "This fit step is no longer eligible for a read-only response check." }, 409);
      }
      if (!step.text || !await frozenInputIsCurrent(supabase, user.id, task)) {
        return response({ ok: false, error: "The frozen profile or listing changed, or the exact saved fit step is missing. Queue a fresh fit analysis; no message was resent." }, 409);
      }
      const source = await getOwnedDispatch(supabase, dispatchId);
      const sourceAttempt = task.response_check_source_attempt_count ?? task.attempt_count;
      // After an unsuccessful read-only check, active_dispatch_id points at
      // that check ticket. Validate the immutable original against its own
      // saved identity, not against the currently active reader ticket.
      const sourceTask = { ...task, active_dispatch_id: dispatchId };
      if (!taskDispatchMatches(sourceTask, source, dispatchId, sourceAttempt)) {
        return response({ ok: false, error: "The source dispatch does not match the exact saved fit step. No message was resent." }, 409);
      }

      operationId = await beginChatGptOperation(supabase, "Check an existing fit response without resending");
      const { data: receipt, error: recoveryError } = await supabase.rpc("job_fit_v3_create_response_check", {
        p_task_id: task.id,
        p_source_dispatch_id: dispatchId,
      });
      if (recoveryError) {
        const message = typeof recoveryError.message === "string" ? recoveryError.message : "";
        const cooldown = /wait\s+(\d+)\s+seconds/i.exec(message);
        if (cooldown) return response({ ok: false, error: `Wait ${cooldown[1]} seconds before checking this saved response again. No ChatGPT message was sent.`, retryAfterSeconds: Number(cooldown[1]) }, 429);
        if (/four read-only checks/i.test(message)) return response({ ok: false, error: "The four read-only checks for this saved response have been used. Refresh the fit analysis to start a new attempt; the original prompt will not be resent." }, 409);
        throw recoveryError;
      }
      const created = record(receipt);
      const ticketId = typeof created.dispatch_id === "string" ? created.dispatch_id : "";
      if (!UUID.test(ticketId) || created.state !== "waiting_for_bridge") {
        throw new Error("The read-only recovery ticket was not durably attached to the saved fit step.");
      }
      const ticket = await getOwnedDispatch(supabase, ticketId);
      // Re-read after the locking RPC. This also covers simultaneous clicks:
      // a losing request may receive the already-created ticket after the
      // winner committed, and must validate against that durable task state.
      const recoveredTask = await getOwnedTask(supabase, task.id, user.id);
      if (!recoveredTask || recoveredTask.state !== "waiting_for_bridge" || recoveredTask.active_dispatch_id !== ticketId) {
        throw new Error("The read-only recovery ticket is not the active saved step. No message was resent.");
      }
      if (ticket.progress?.response_check_only !== true
        || ticket.subject_refs?.response_check_for !== dispatchId
        || !taskDispatchMatches(recoveredTask, ticket, ticketId, recoveredTask.attempt_count)) {
        throw new Error("The generic Website Bridge recovery ticket failed its exact-step validation. No message was resent.");
      }
      await trackChatGptOperation(supabase, operationId, [ticketId]);
      operationTracked = true;
      return response({
        ok: true, state: "waiting_for_bridge", dispatchId: ticketId,
        responseCheckOnly: true, idempotent: created.idempotent === true,
        responseCheckAttemptCount: recoveredTask.response_check_attempt_count,
        bridge_hint: dispatchHint(ticket),
      }, 202);
    }

    return response({ ok: false, error: "Profile-bearing V3 sends are retired. Only prompt-free response checks are permitted." }, 400);


  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : "Unable to safely recover the saved fit step." }, statusCode(error));
  } finally {
    if (operationId && !operationTracked) {
      try { const { createClient } = await import("@/lib/supabase/server"); await releaseChatGptOperation(await createClient(), operationId); }
      catch { /* The active dispatch remains visible to the server-side lock reconciliation. */ }
    }
  }
}
