import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { normalizeResponseRecoveryCandidate } from "@/lib/job-fit-v3/recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "needs_user", "failed", "cancelled"]);

function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function response(body: Record<string, unknown>, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }
function configured() { return isSupabaseConfigured() && getDataMode() !== "local"; }
function safeError(error: unknown) {
  const value = record(error);
  if (value.code === "42P01" || value.code === "PGRST202") return "V3 fit analysis is not yet installed in the database. Apply the new job-fit migration before analysing listings.";
  return error instanceof Error ? error.message : typeof value.message === "string" ? value.message : "Unable to process fit analysis.";
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
    if (params.get("recoverable") === "1") {
      // Dispatch rows are intentionally inaccessible to direct client
      // queries. The authenticated SECURITY INVOKER RPC checks the exact
      // source dispatch and returns only a bounded recovery status and IDs.
      // It scans past invalid newer tasks so they cannot mask an older task
      // that is still safe to check.
      const { data: candidate, error } = await supabase.rpc("job_fit_v3_find_response_check_candidate");
      if (error) throw error;
      const recovery = normalizeResponseRecoveryCandidate(candidate);
      if (!recovery) return response({ ok: true, batch: null });
      const batch = await batchSummary(supabase, recovery.batch_id);
      if (!batch) return response({ ok: true, batch: null });
      (batch as any).recovery = recovery;
      (batch as any).issues = (batch as any).issues?.map((issue: any) => issue.task_id === recovery.task_id
        ? { ...issue, recovery_status: recovery.status, recovery_reason_code: recovery.reason_code, recovery_retry_after_seconds: recovery.retry_after_seconds }
        : issue);
      return response({ ok: true, batch, recovery });
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

export async function POST(_request: Request) {
  return response({ ok: false, code: "memory_only_required", error: "Profile-bearing V3 analysis is retired. Use the Memory-only analysis action; this legacy request was not sent." }, 410);
}
