import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { statusCode } from "@/lib/onboarding/server";
import { readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { buildMemoryFitPromptChunks } from "@/lib/job-fit-memory-v4/prompt";
import { advanceMemoryFitBatch, loadMemoryFitBatch } from "@/lib/job-fit-memory-v4/server";
import { safeMemoryFitDispatchRetryAllowed, safeMemoryFitFreshDispatchAllowed } from "@/lib/job-fit-memory-v4/dispatch-contract";
import { MAX_MEMORY_FIT_JOBS } from "@/lib/job-fit-memory-v4/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function respond(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
async function identity() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  return { supabase, user: data.user };
}

export async function GET(request: Request) {
  try {
    const { supabase, user } = await identity();
    const params = new URL(request.url).searchParams;
    const batchId = params.get("batchId");
    const requestId = params.get("requestId");
    let query = supabase.from("job_fit_memory_v4_batches").select("id").eq("user_id", user.id);
    if (batchId) {
      if (!UUID.test(batchId)) return respond({ ok: false, error: "A valid Memory-only analysis batch is required." }, 400);
      query = query.eq("id", batchId);
    } else if (requestId) {
      if (!UUID.test(requestId)) return respond({ ok: false, error: "A valid Memory-only request ID is required." }, 400);
      query = query.eq("request_id", requestId);
    } else {
      query = query.order("created_at", { ascending: false }).limit(1);
    }
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data?.id) return respond({ ok: true, batch: null });
    const batch = await loadMemoryFitBatch(supabase, user.id, String(data.id));
    let safeRetry: Record<string, unknown> | null = null;
    let safeFreshRetry = false;
    const retryCandidate = batch?.chunks.find((chunk) => chunk.state === "needs_user" && typeof chunk.dispatch_id === "string");
    if (retryCandidate) {
      const { data: dispatchData, error: dispatchError } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: retryCandidate.dispatch_id });
      if (dispatchError) throw dispatchError;
      const dispatch = record(dispatchData);
      if (safeMemoryFitDispatchRetryAllowed(dispatch, retryCandidate)) {
        safeRetry = { id: String(dispatch.id), state: String(dispatch.state), retry_allowed: true, attempt_count: Number(dispatch.attempt_count || 0) };
      } else if (safeMemoryFitFreshDispatchAllowed(dispatch, retryCandidate,
        (batch?.items || []).filter((item) => retryCandidate.job_ids?.includes(item.job_id)))) {
        safeFreshRetry = true;
      }
    }
    return respond({ ok: true, batch, ...(safeRetry ? { dispatch: safeRetry } : {}), ...(safeFreshRetry ? { safe_fresh_retry: true } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read Memory-only analysis progress.";
    return respond({ ok: false, error: message }, statusCode(error));
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await identity();
    const body = record(await request.json().catch(() => null));
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const retryBatchId = typeof body.retryBatchId === "string" ? body.retryBatchId : "";
    let mode = typeof body.mode === "string" ? body.mode : "";
    let suppliedIds: unknown[] = Array.isArray(body.jobIds) ? body.jobIds : [];
    let retryTestingMode: boolean | null = null;

    if (retryBatchId) {
      if (!UUID.test(retryBatchId) || !UUID.test(requestId) || mode !== "selected"
        || suppliedIds.length < 1 || suppliedIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
        return respond({ ok: false, error: "A valid saved analysis and new request ID are required for this safe retry." }, 400);
      }
      const previous = await loadMemoryFitBatch(supabase, user.id, retryBatchId);
      if (!previous) return respond({ ok: false, error: "The saved Memory-only analysis was not found." }, 404);
      const candidates = previous.chunks.filter((chunk) => chunk.state === "needs_user" && typeof chunk.dispatch_id === "string");
      if (candidates.length !== 1) return respond({ ok: false, error: "This saved analysis does not have exactly one recoverable unsent group." }, 409);
      const candidate = candidates[0];
      const candidateJobIds: string[] = Array.isArray(candidate.job_ids)
        ? candidate.job_ids.filter((id: unknown): id is string => typeof id === "string")
        : [];
      if (candidateJobIds.length !== suppliedIds.length || candidateJobIds.some((id, index) => id !== suppliedIds[index])) {
        return respond({ ok: false, error: "The requested retry job IDs do not match the exact saved unsent group." }, 409);
      }
      const candidateItems = (previous.items || []).filter((item) => candidate.job_ids?.includes(item.job_id));
      const { data: dispatchData, error: dispatchError } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: candidate.dispatch_id });
      if (dispatchError) throw dispatchError;
      if (!safeMemoryFitFreshDispatchAllowed(record(dispatchData), candidate, candidateItems)) {
        return respond({ ok: false, error: "The server cannot prove that the previous exact request remained entirely before Send. No new request was created." }, 409);
      }
      // This creates a separate immutable batch and generic Website Bridge
      // dispatch. The previous record remains intact; the new dispatch is
      // allowed only because the server proved that it had no Send boundary
      // and no captured result. Preserve the old test-mode fence.
      suppliedIds = candidateJobIds;
      mode = "selected";
      retryTestingMode = previous.testing_mode === true;
    }

    if (!UUID.test(requestId) || !["pending", "selected", "outdated"].includes(mode)
      || suppliedIds.length < 1 || suppliedIds.length > MAX_MEMORY_FIT_JOBS
      || suppliedIds.some((id: unknown) => typeof id !== "string" || !UUID.test(id))
      || new Set(suppliedIds).size !== suppliedIds.length) {
      return respond({ ok: false, error: `Select 1–${MAX_MEMORY_FIT_JOBS} unique saved jobs and choose a valid analysis action.` }, 400);
    }
    const requestedJobIds = suppliedIds as string[];

    const { data: existing, error: existingError } = await supabase.from("job_fit_memory_v4_batches")
      .select("id").eq("user_id", user.id).eq("request_id", requestId).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.id) {
      const result = await advanceMemoryFitBatch(supabase, user.id, String(existing.id));
      if (!result.ok) return respond({ ok: false, error: result.error, batchId: String(existing.id) }, result.status);
      return respond({ ...result, batchId: String(existing.id) }, 202);
    }

    const { data: jobsRaw, error: jobsError } = await supabase.from("jobs")
      .select("id,title,industry,source_url,application_url,analysis_revision,current_snapshot_id,location_text,work_mode,employment_type,salary_min,salary_max,salary_currency,salary_text,posted_at,closes_at,ats_provider,discovery_source")
      .eq("user_id", user.id).in("id", requestedJobIds);
    if (jobsError) throw jobsError;
    const jobs = Array.isArray(jobsRaw) ? jobsRaw.map(record) : [];
    if (jobs.length !== requestedJobIds.length) return respond({ ok: false, error: "One or more selected listings no longer exist in your job pool." }, 404);
    const orderedJobs = requestedJobIds.map((id) => jobs.find((job) => job.id === id))
      .filter((job): job is Record<string, any> => Boolean(job));
    const analysisRead = await supabase.from("job_analyses").select("job_id,engine_version,job_revision,input_hash,assessment_as_of,created_at")
      .in("job_id", requestedJobIds).eq("engine_version", "job-fit-memory-v4").order("created_at", { ascending: false }).order("id", { ascending: false });
    if (analysisRead.error) throw analysisRead.error;
    const latestMemoryAnalysis = new Map<string, Record<string, any>>();
    for (const analysis of analysisRead.data || []) if (!latestMemoryAnalysis.has(analysis.job_id)) latestMemoryAnalysis.set(analysis.job_id, record(analysis));
    let selectedJobs = orderedJobs;
    if (mode === "pending") selectedJobs = orderedJobs.filter((job) => !latestMemoryAnalysis.has(job.id));
    if (mode === "outdated") selectedJobs = orderedJobs.filter((job) => {
      const analysis = latestMemoryAnalysis.get(job.id);
      return !analysis || Number(analysis.job_revision) !== Number(job.analysis_revision)
        || !/^[0-9a-f]{64}$/.test(String(analysis.input_hash || "")) || !analysis.assessment_as_of;
    });
    if (!selectedJobs.length) return respond({ ok: false, error: mode === "pending" ? "All selected jobs already have a Memory-based fit analysis." : "All selected Memory-based assessments are current." }, 409);

    const testingMode = retryTestingMode ?? await readChatGptTestingMode(supabase, user.id);
    const requestBatchId = crypto.randomUUID();
    const assessmentAsOf = new Date().toISOString();
    const requestJobs = selectedJobs.map((job) => ({ job_id: job.id, listing_url: String(job.source_url || job.application_url || "") }));
    const promptChunks = buildMemoryFitPromptChunks({ requestId, batchId: requestBatchId, assessmentAsOf, jobs: requestJobs, testingMode });
    const chunks = promptChunks.map((chunk, index) => {
      const ordinal = index + 1;
      return {
        ordinal,
        job_ids: chunk.jobs.map((job) => job.job_id),
        idempotency_key: `jobfit-memory-v4:${requestBatchId}:${ordinal}`,
        instruction: chunk.instruction,
      };
    });
    const selectedById = new Map(selectedJobs.map((job) => [String(job.id), job]));
    const jobsForDatabase = promptChunks.flatMap((chunk, index) => chunk.jobs.map((job) => ({
      job_id: job.job_id,
      listing_url: job.listing_url,
      job_revision: Number(selectedById.get(job.job_id)?.analysis_revision),
      chunk_ordinal: index + 1,
    })));
    const { data: created, error: createError } = await supabase.rpc("create_job_fit_memory_v4_batch", {
      p_batch_id: requestBatchId,
      p_request_id: requestId,
      p_mode: mode,
      p_assessment_as_of: assessmentAsOf,
      p_testing_mode: testingMode,
      p_jobs: jobsForDatabase,
      p_chunks: chunks,
    });
    if (createError) throw createError;
    const createdBatch = record(created);
    if (typeof createdBatch.batch_id !== "string" || !UUID.test(createdBatch.batch_id)) throw new Error("The Memory-only analysis batch was not durably created.");
    const advanced = await advanceMemoryFitBatch(supabase, user.id, createdBatch.batch_id);
    if (!advanced.ok) return respond({ ok: false, error: advanced.error, batchId: createdBatch.batch_id }, advanced.status);
    return respond({ ...advanced, batchId: createdBatch.batch_id, idempotent: createdBatch.idempotent === true }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start Memory-only job analysis.";
    const code = record(error).code;
    const status = code === "42P01" || code === "PGRST202" ? 503 : /already have an active|active ChatGPT|operation.*active/i.test(message) ? 409 : statusCode(error);
    return respond({ ok: false, error: message }, status);
  }
}
