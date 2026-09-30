import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import {
  assessmentDispatchKey,
  isRequeuedUnsentDispatch,
  isSafeUnsentPreDeliveryV2Dispatch,
} from "@/lib/job-fit-v3/workflow";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";
import { callJobFitWorker } from "@/lib/job-fit-v3/worker-client";

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

function taskDispatchMatches(task: FitTask, dispatch: Record<string, any>, dispatchId: string) {
  const step = Array.isArray(task.steps) ? record(task.steps[task.current_step_index]) : {};
  const subjectJobIds = dispatch.subject_refs?.job_ids;
  return dispatch.id === dispatchId
    && task.active_dispatch_id === dispatchId
    && dispatch.action_type === "jobs.analyse_selected"
    && dispatch.idempotency_key === assessmentDispatchKey(task.id, task.attempt_count, Number(step.ordinal))
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
    .select("id,user_id,job_id,attempt_count,current_step_index,state,active_dispatch_id,safe_unsent_retry_count,response_check_attempt_count,response_check_source_dispatch_id,steps,input_payload,job_revision,profile_revision")
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
    if (!(["check_pre_delivery", "retry_pre_delivery", "check_response"].includes(String(action))
      && typeof taskId === "string" && UUID.test(taskId)
      && typeof dispatchId === "string" && UUID.test(dispatchId))) {
      return response({ ok: false, error: "Choose a valid safe-recovery action and saved fit dispatch." }, 400);
    }

    const { supabase, user } = await requireProfile();
    const task = await getOwnedTask(supabase, taskId, user.id);
    if (!task) return response({ ok: false, error: "Fit task not found." }, 404);

    if (action === "check_response") {
      const step = Array.isArray(task.steps) ? record(task.steps[task.current_step_index]) : {};
      const recoveredAlready = task.response_check_attempt_count === 1
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
      if (task.state !== "needs_user" || task.active_dispatch_id !== dispatchId || task.response_check_attempt_count !== 0) {
        return response({ ok: false, error: "This fit step is no longer eligible for its one read-only response check." }, 409);
      }
      if (!step.text || !await frozenInputIsCurrent(supabase, user.id, task)) {
        return response({ ok: false, error: "The frozen profile or listing changed, or the exact saved fit step is missing. Queue a fresh fit analysis; no message was resent." }, 409);
      }
      const source = await getOwnedDispatch(supabase, dispatchId);
      if (!taskDispatchMatches(task, source, dispatchId)) {
        return response({ ok: false, error: "The source dispatch does not match the exact saved fit step. No message was resent." }, 409);
      }

      operationId = await beginChatGptOperation(supabase, "Check an existing fit response without resending");
      const { data: receipt, error: recoveryError } = await supabase.rpc("job_fit_v3_create_response_check", {
        p_task_id: task.id,
        p_source_dispatch_id: dispatchId,
      });
      if (recoveryError) throw recoveryError;
      const created = record(receipt);
      const ticketId = typeof created.dispatch_id === "string" ? created.dispatch_id : "";
      if (!UUID.test(ticketId) || created.state !== "waiting_for_bridge") {
        throw new Error("The read-only recovery ticket was not durably attached to the saved fit step.");
      }
      const ticket = await getOwnedDispatch(supabase, ticketId);
      const recoveredTask = { ...task, attempt_count: task.attempt_count + 1, active_dispatch_id: ticketId };
      if (ticket.progress?.response_check_only !== true
        || ticket.subject_refs?.response_check_for !== dispatchId
        || !taskDispatchMatches(recoveredTask, ticket, ticketId)) {
        throw new Error("The generic Website Bridge recovery ticket failed its exact-step validation. No message was resent.");
      }
      await trackChatGptOperation(supabase, operationId, [ticketId]);
      operationTracked = true;
      return response({
        ok: true, state: "waiting_for_bridge", dispatchId: ticketId,
        responseCheckOnly: true, idempotent: created.idempotent === true,
        bridge_hint: dispatchHint(ticket),
      }, 202);
    }

    if (task.state !== "needs_user" || task.active_dispatch_id !== dispatchId) {
      return response({ ok: false, error: "This fit step is no longer waiting for safe pre-delivery recovery." }, 409);
    }
    if (!Array.isArray(task.steps) || !record(task.steps[task.current_step_index]).text) {
      return response({ ok: false, error: "The exact saved fit step is missing. No ChatGPT message was resent." }, 409);
    }

    let dispatch = await getOwnedDispatch(supabase, dispatchId);
    if (!taskDispatchMatches(task, dispatch, dispatchId)) {
      return response({ ok: false, error: "The dispatch does not match the exact saved fit step. No ChatGPT message was resent." }, 409);
    }
    if (!await frozenInputIsCurrent(supabase, user.id, task)) {
      return response({ ok: false, error: "The saved profile or job listing changed. Queue a fresh fit analysis; this old step was not resent." }, 409);
    }

    const alreadyRequeued = isRequeuedUnsentDispatch(dispatch);
    const safeUnsent = isSafeUnsentPreDeliveryV2Dispatch(dispatch);
    const retryBudgetAvailable = Number(task.safe_unsent_retry_count || 0) < 1;
    if (action === "check_pre_delivery") {
      return response({ ok: true, safe: retryBudgetAvailable && (alreadyRequeued || safeUnsent), alreadyRequeued, dispatchId });
    }

    if (!retryBudgetAvailable) {
      return response({ ok: false, error: "The one safe pre-Send retry for this exact fit step has already been used. Start a fresh fit analysis instead; no sent message was repeated." }, 409);
    }
    if (!alreadyRequeued && !safeUnsent) {
      return response({ ok: false, error: "The server cannot confirm that this exact request is still unsent. No message was resent." }, 409);
    }

    if (!alreadyRequeued) {
      operationId = await beginChatGptOperation(supabase, "Resume a confirmed-unsent fit assessment");
      const { data: retried, error: retryError } = await supabase.rpc("retry_chatgpt_dispatch_request", { p_request_id: dispatchId });
      if (retryError) throw retryError;
      const retryReceipt = record(retried);
      if (retryReceipt.id !== dispatchId || retryReceipt.state !== "queued") {
        throw new Error("The generic Bridge retry did not return the same confirmed-unsent dispatch. No fit progress was advanced.");
      }
      await trackChatGptOperation(supabase, operationId, [dispatchId]);
      operationTracked = true;
      // The retry RPC receipt deliberately contains no response body or turn
      // anchor. Re-read the owner's authoritative status and verify its
      // durable pre-Send marker before resuming the fit task.
      dispatch = await getOwnedDispatch(supabase, dispatchId);
      if (!taskDispatchMatches(task, dispatch, dispatchId) || !isRequeuedUnsentDispatch(dispatch)) {
        throw new Error("The exact dispatch was requeued, but its authoritative status does not confirm a safe unsent retry. No fit progress was advanced.");
      }
    }

    // The worker wrapper only transitions this saved task back to waiting. It
    // never creates a second dispatch and accepts no browser-supplied content.
    const transitioned = await callJobFitWorker({
      action: "fit_transition",
      user_id: user.id,
      task_id: task.id,
      expected_state: "needs_user",
      expected_step_index: task.current_step_index,
      dispatch_id: dispatchId,
      transition: "mark_waiting",
      error: null,
    });
    const data = record(transitioned.data);
    if (data.state !== "waiting_for_bridge") {
      throw new Error("The same saved fit step was requeued, but its durable progress could not be resumed.");
    }
    return response({ ok: true, state: "waiting_for_bridge", dispatchId, bridge_hint: dispatchHint(dispatch) }, 202);
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : "Unable to safely recover the saved fit step." }, statusCode(error));
  } finally {
    if (operationId && !operationTracked) {
      try { const { createClient } = await import("@/lib/supabase/server"); await releaseChatGptOperation(await createClient(), operationId); }
      catch { /* The active dispatch remains visible to the server-side lock reconciliation. */ }
    }
  }
}
