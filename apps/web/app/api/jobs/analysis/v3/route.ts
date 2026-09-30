import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { loadVerifiedBackground, loadVacancies, makeTaskSpec, isCurrentV3Analysis } from "@/lib/job-fit-v3/server";
import { callJobFitWorker, jobFitRuntimeBindings, jobFitV3Enabled } from "@/lib/job-fit-v3/worker-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["pending", "selected", "outdated", "retry"]);
const TERMINAL = new Set(["completed", "needs_user", "failed", "cancelled"]);

function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function response(body: Record<string, unknown>, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }
function configured() { return isSupabaseConfigured() && getDataMode() !== "local"; }
function safeError(error: unknown) {
  const value = record(error);
  if (value.code === "42P01" || value.code === "PGRST202") return "V3 fit analysis is not yet installed in the database. Apply the new job-fit migration before analysing listings.";
  return error instanceof Error ? error.message : typeof value.message === "string" ? value.message : "Unable to process fit analysis.";
}
function uniqueIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some((item) => typeof item !== "string" || !UUID.test(item))) return null;
  const ids = Array.from(new Set<string>(value as string[]));
  return ids.length === value.length ? ids : null;
}

async function loadRetryIds(supabase: any, userId: string): Promise<string[]> {
  const { data, error } = await supabase.from("job_fit_v3_tasks").select("job_id,created_at").eq("user_id", userId).eq("state", "failed").order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  const ids = (data || []).map((row: any) => row.job_id).filter((id: unknown): id is string => typeof id === "string");
  return Array.from(new Set<string>(ids)).slice(0, 100);
}

async function batchSummary(supabase: any, batchId: string) {
  const [{ data: batch, error: batchError }, { data: tasks, error: taskError }] = await Promise.all([
    supabase.from("job_fit_v3_batches").select("id,mode,requested_count,created_at").eq("id", batchId).maybeSingle(),
    supabase.from("job_fit_v3_tasks").select("id,job_id,state,current_step_index,error_message,active_dispatch_id,response_check_attempt_count,response_check_source_dispatch_id,response_check_last_requested_at").eq("batch_id", batchId).order("created_at").order("id"),
  ]);
  if (batchError) throw batchError;
  if (taskError) throw taskError;
  if (!batch) return null;
  const values = tasks || [];
  const counts = {
    total: values.length,
    completed: values.filter((task: any) => task.state === "completed").length,
    queued: values.filter((task: any) => task.state === "queued").length,
    running: values.filter((task: any) => task.state === "waiting_for_bridge" || task.state === "saving").length,
    failed: values.filter((task: any) => task.state === "failed" || task.state === "cancelled").length,
    needs_user: values.filter((task: any) => task.state === "needs_user").length,
  };
  const remaining = counts.queued + counts.running;
  const state = remaining ? counts.running ? "processing" : "queued" : counts.failed || counts.needs_user ? "partial" : "completed";
  return {
    batch_id: batch.id, mode: batch.mode, state, requested_count: Number(batch.requested_count) || values.length,
    counts,
    issues: values.filter((task: any) => TERMINAL.has(task.state) && task.state !== "completed").map((task: any) => ({
      task_id: task.id, job_id: task.job_id, state: task.state, message: task.error_message || null,
      dispatch_id: task.response_check_source_dispatch_id || task.active_dispatch_id || null,
      response_check_attempt_count: Number(task.response_check_attempt_count) || 0,
      response_check_last_requested_at: task.response_check_last_requested_at || null,
    })),
    tasks: values.map((task: any) => ({
      id: task.id, job_id: task.job_id, state: task.state, current_step_index: task.current_step_index,
      error_message: task.error_message || null, active_dispatch_id: task.active_dispatch_id || null,
      response_check_attempt_count: Number(task.response_check_attempt_count) || 0,
      response_check_source_dispatch_id: task.response_check_source_dispatch_id || null,
      response_check_last_requested_at: task.response_check_last_requested_at || null,
    })),
  };
}

export async function GET(request: Request) {
  try {
    if (!configured()) return response({ ok: false, error: "V3 job analysis requires your signed-in JobHuntAI account." }, 409);
    const { supabase, user } = await requireProfile();
    const params = new URL(request.url).searchParams;
    if (params.get("summary") === "1") {
      const { data, error } = await supabase.from("job_fit_v3_tasks").select("job_id").eq("user_id", user.id).eq("state", "failed");
      if (error) throw error;
      return response({ ok: true, retryableCount: new Set((data || []).map((item: any) => item.job_id)).size });
    }
    const requestId = params.get("requestId") || "";
    if (requestId) {
      if (!UUID.test(requestId)) return response({ ok: false, error: "A valid fit-analysis request is required." }, 400);
      const { data: saved, error } = await supabase.from("job_fit_v3_batches").select("id").eq("user_id", user.id).eq("request_id", requestId).maybeSingle();
      if (error) throw error;
      if (!saved) return response({ ok: false, error: "No saved fit-analysis batch exists for this request." }, 404);
      const batch = await batchSummary(supabase, saved.id);
      return batch ? response({ ok: true, batch }) : response({ ok: false, error: "Fit analysis batch not found." }, 404);
    }
    const taskId = params.get("taskId") || "";
    if (taskId) {
      if (!UUID.test(taskId)) return response({ ok: false, error: "A valid fit task is required." }, 400);
      const { data: task, error } = await supabase.from("job_fit_v3_tasks").select("id,batch_id,job_id,assessment_request_id,attempt_count,state,current_step_index,active_dispatch_id,steps,input_payload,error_message,result_json,captured_responses,testing_mode,response_check_attempt_count,response_check_source_dispatch_id,response_check_source_attempt_count,response_check_last_requested_at").eq("id", taskId).maybeSingle();
      if (error) throw error;
      if (!task) return response({ ok: false, error: "Fit task not found." }, 404);
      const step = Array.isArray(task.steps) ? task.steps[Number(task.current_step_index)] || null : null;
      return response({ ok: true, task: {
        id: task.id, batch_id: task.batch_id, job_id: task.job_id, assessment_request_id: task.assessment_request_id,
        attempt_count: task.attempt_count, state: task.state, current_step_index: task.current_step_index,
        active_dispatch_id: task.active_dispatch_id, step, error_message: task.error_message,
        response_check_attempt_count: Number(task.response_check_attempt_count) || 0,
        response_check_source_dispatch_id: task.response_check_source_dispatch_id || null,
        response_check_source_attempt_count: task.response_check_source_attempt_count === null ? null : Number(task.response_check_source_attempt_count),
        response_check_last_requested_at: task.response_check_last_requested_at || null,
      } });
    }
    const batchId = params.get("batchId") || "";
    if (!UUID.test(batchId)) return response({ ok: false, error: "A valid analysis batch is required." }, 400);
    const batch = await batchSummary(supabase, batchId);
    return batch ? response({ ok: true, batch }) : response({ ok: false, error: "Fit analysis batch not found." }, 404);
  } catch (error) {
    return response({ ok: false, error: safeError(error) }, statusCode(error));
  }
}

export async function POST(request: Request) {
  try {
    if (!configured()) return response({ ok: false, error: "V3 job analysis requires your signed-in JobHuntAI account." }, 409);
    const body = record(await request.json().catch(() => null));
    const mode = typeof body.mode === "string" ? body.mode : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!MODES.has(mode) || !UUID.test(requestId)) return response({ ok: false, error: "Choose a valid fit-analysis action and retry." }, 400);
    const { supabase, user, profile: profileRow } = await requireProfile();
    const rollout = jobFitRuntimeBindings();
    if (!jobFitV3Enabled(user.id, rollout.JOB_FIT_V3_MODE, rollout.JOB_FIT_V3_CANARY_USER_IDS)) {
      return response({ ok: false, error: rollout.JOB_FIT_V3_MODE === "canary"
        ? "V3 fit assessment is being enabled for a limited set of accounts. Your saved assessments remain available."
        : "V3 fit assessment is temporarily paused while its scoring and evidence safeguards are verified. Your saved assessments remain available." }, 503);
    }
    const suppliedIds: string[] | null = mode === "retry" ? await loadRetryIds(supabase, user.id) : uniqueIds(body.jobIds);
    if (!suppliedIds || suppliedIds.length < 1) return response({ ok: false, error: mode === "retry" ? "There are no failed fit assessments to retry." : "Select between 1 and 100 valid jobs to analyse." }, 400);

    const { data: profileState, error: profileError } = await supabase.from("candidate_profiles").select("id,analysis_revision").eq("user_id", user.id).single();
    if (profileError) throw profileError;
    const [background, vacancies] = await Promise.all([
      loadVerifiedBackground(supabase, profileRow.id),
      loadVacancies(supabase, user.id, suppliedIds),
    ]);
    const assessmentAsOf = new Date();
    const testingMode = await readChatGptTestingMode(supabase, user.id);
    const profile = { id: profileState.id, analysis_revision: Number(profileState.analysis_revision), ...background };
    const orderedVacancies = new Map<string, any>(vacancies.map((item: any) => [item.job.id, item] as [string, any]));
    const v3Rows = await supabase.from("job_analyses").select("job_id,engine_version,job_revision,profile_revision,input_hash,assessment_as_of,created_at").in("job_id", suppliedIds).eq("engine_version", "job-fit-v3").order("created_at", { ascending: false }).order("id", { ascending: false });
    if (v3Rows.error) throw v3Rows.error;
    const latestV3 = new Map<string, any>();
    for (const row of v3Rows.data || []) if (!latestV3.has(row.job_id)) latestV3.set(row.job_id, row);
    let jobIds = suppliedIds;
    if (mode === "pending") jobIds = suppliedIds.filter((id) => !latestV3.has(id));
    if (mode === "outdated") jobIds = suppliedIds.filter((id) => !isCurrentV3Analysis(latestV3.get(id) || null, Number(orderedVacancies.get(id)?.job.analysis_revision), profile.analysis_revision));
    if (jobIds.length === 0) return response({ ok: false, error: mode === "pending" ? "All selected jobs already have a V3 fit assessment." : "All selected V3 assessments are already current." }, 409);
    const specs = jobIds.map((id) => {
      const item = orderedVacancies.get(id);
      if (!item) throw new Error("One or more selected jobs are no longer available in your pool.");
      return makeTaskSpec({ userId: user.id, requestId, job: item.job, snapshot: item.snapshot, vacancy: item.vacancy, profile, testingMode, assessmentAsOf });
    });
    const worker = await callJobFitWorker({
      action: "fit_create", user_id: user.id, request_id: requestId, mode, job_ids: jobIds, tasks: specs,
    });
    const data = worker.data;
    const created = record(data);
    if (typeof created.batch_id !== "string" || !UUID.test(created.batch_id)) throw new Error("The fit-analysis queue did not return a valid batch reference.");
    let workerKickStarted = false;
    try {
      const kicked = await callJobFitWorker({ action: "fit_kick", user_id: user.id });
      workerKickStarted = Array.isArray(kicked.outcomes) && kicked.outcomes.some((outcome: unknown) => record(outcome).dispatched === true);
    } catch {
      // The batch is already durable. The minute scheduler is the recovery path;
      // the user must not receive a false failure or resubmit the batch.
      console.warn("V3 fit batch saved; the scheduled worker will start it.");
    }
    return response({ ok: true, batch: { id: created.batch_id, state: created.state || "queued", requestedCount: Number(created.requested_count) || specs.length, idempotent: created.idempotent === true }, workerKickStarted }, 202);
  } catch (error) {
    const message = safeError(error);
    const code = record(error).code;
    if (code) console.error("V3 fit batch request failed.", { code });
    const status = code === "42P01" || code === "PGRST202" ? 503 : /already have an active fit assessment/i.test(message) ? 409 : statusCode(error);
    return response({ ok: false, error: message }, status);
  }
}
