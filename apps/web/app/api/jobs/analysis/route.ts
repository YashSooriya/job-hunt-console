import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["pending", "selected", "outdated", "retry"]);

function noStore(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function backendError(value: unknown) {
  const details = record(value);
  const code = typeof details.code === "string" ? details.code : null;
  const message = value instanceof Error
    ? value.message
    : typeof details.message === "string" && details.message.trim()
      ? details.message.trim()
      : null;
  return { code, message };
}

function liveSupabaseRequired() {
  return isSupabaseConfigured() && getDataMode() !== "local";
}

export async function POST(request: Request) {
  try {
    if (!liveSupabaseRequired()) {
      return noStore({ ok: false, error: "Background analysis batches require the connected JobHuntAI database. Switch from local demo data to your signed-in account." }, 409);
    }
    const body = record(await request.json().catch(() => null));
    const mode = typeof body.mode === "string" ? body.mode : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!MODES.has(mode) || !UUID.test(requestId)) {
      return noStore({ ok: false, error: "Choose a valid analysis action and retry the request." }, 400);
    }
    const rawIds = Array.isArray(body.jobIds) ? body.jobIds : [];
    if (mode === "selected" && (!rawIds.length || rawIds.length > 100 || rawIds.some((id) => typeof id !== "string" || !UUID.test(id)))) {
      return noStore({ ok: false, error: "Select between 1 and 100 valid jobs to analyse." }, 400);
    }
    const jobIds = mode === "selected" ? [...new Set(rawIds as string[])] : [];
    if (mode === "selected" && jobIds.length !== rawIds.length) {
      return noStore({ ok: false, error: "The selected job list contains duplicates. Refresh the page and try again." }, 400);
    }
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("create_job_analysis_batch", {
      p_request_id: requestId,
      p_mode: mode,
      p_job_ids: jobIds,
    });
    if (error) throw error;
    const batch = record(data);
    if (typeof batch.batch_id !== "string" || !UUID.test(batch.batch_id)) {
      throw new Error("The analysis queue did not return a valid batch reference.");
    }
    return noStore({ ok: true, batch: {
      id: batch.batch_id,
      state: batch.state,
      requestedCount: Number(batch.requested_count) || 0,
      queuedCount: Number(batch.queued_count) || 0,
      reusedCount: Number(batch.reused_count) || 0,
      idempotent: batch.idempotent === true,
    } });
  } catch (error) {
    const issue = backendError(error);
    const safeMessage = issue.code === "42703"
      ? "Analysis progress is temporarily unavailable. Your queued analysis is safe; retry shortly."
      : issue.message || "Unable to queue job analysis.";
    if (issue.code) console.error("Job analysis request failed.", { code: issue.code });
    const status = issue.code === "42703" ? 503 : statusCode(error);
    return noStore({ ok: false, error: safeMessage, errorCode: issue.code || "analysis_request_failed" }, status);
  }
}

export async function GET(request: Request) {
  try {
    if (!liveSupabaseRequired()) return noStore({ ok: false, error: "Background analysis status is unavailable for local demo data." }, 409);
    const searchParams = new URL(request.url).searchParams;
    const { supabase } = await requireProfile();
    if (searchParams.get("summary") === "1") {
      const { data, error } = await supabase.rpc("get_retryable_job_analysis_count");
      if (error) throw error;
      const retryableCount = Number(data);
      if (!Number.isSafeInteger(retryableCount) || retryableCount < 0) throw new Error("The analysis retry status was invalid.");
      return noStore({ ok: true, retryableCount });
    }
    const batchId = searchParams.get("batchId") || "";
    if (!UUID.test(batchId)) return noStore({ ok: false, error: "A valid analysis batch is required." }, 400);
    const { data, error } = await supabase.rpc("get_job_analysis_batch", { p_batch_id: batchId });
    if (error) throw error;
    const batch = record(data);
    if (typeof batch.batch_id !== "string") return noStore({ ok: false, error: "Analysis batch not found." }, 404);
    return noStore({ ok: true, batch });
  } catch (error) {
    const issue = backendError(error);
    const message = issue.code === "42703"
      ? "Analysis progress is temporarily unavailable. Your analysis results are safe; retry shortly."
      : issue.message || "Unable to read analysis progress.";
    if (issue.code) console.error("Job analysis progress read failed.", { code: issue.code });
    const status = issue.code === "42703" ? 503 : /not found/i.test(message) ? 404 : statusCode(error);
    return noStore({ ok: false, error: message, errorCode: issue.code || "analysis_progress_unavailable" }, status);
  }
}
