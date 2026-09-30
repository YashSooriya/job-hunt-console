import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { normalizeJobListingUrl, type JobUrlInspectionStatus } from "@/lib/job-url-inspection";
import { buildJobUrlInspectionPrompt } from "@/lib/job-url-inspection-prompt";
import { parseJobUrlInspectionBatchResponse, parseJobUrlInspectionResponse, type JobUrlInspectionBatchResult } from "@/lib/job-url-inspection-response";
import { applyChatGptTestingMode, readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";
import { recordJobPoolSheetSyncInBackground } from "@/lib/google-job-pool-sheet";

const MAX_BULK_URLS = 10;
const INSPECTION_SELECT = "id,source_url,status,attempt_count,error_json,job_id,provider,provider_response_id,completed_at,created_at,updated_at,batch_id,batch_position,dispatch_request_id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Inspection = {
  id: string;
  source_url: string;
  status: JobUrlInspectionStatus;
  attempt_count: number;
  error_json?: { message?: string } | null;
  job_id?: string | null;
  completed_at?: string | null;
  created_at?: string;
  batch_id?: string | null;
  batch_position?: number | null;
  dispatch_request_id?: string | null;
  reconciliation_error?: string | null;
  captured_result_retry_allowed?: boolean;
};
type SupabaseClient = any;

function validUuid(value: string | null) { return Boolean(value && UUID_RE.test(value)); }

async function authenticatedClient() {
  if (!isSupabaseConfigured() || getDataMode() === "local") throw new Error("LIVE_INSPECTION_REQUIRES_SUPABASE");
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  return { supabase, user: data.user };
}

function publicInspection(value: any): Inspection {
  return {
    id: String(value.id),
    source_url: String(value.source_url),
    status: value.status,
    attempt_count: Number(value.attempt_count || 0),
    error_json: value.error_json || null,
    job_id: value.job_id || null,
    completed_at: value.completed_at || null,
    created_at: value.created_at,
    batch_id: value.batch_id || null,
    batch_position: value.batch_position ?? null,
    dispatch_request_id: value.dispatch_request_id || null,
    reconciliation_error: value.reconciliation_error || null,
    captured_result_retry_allowed: value.captured_result_retry_allowed === true,
  };
}

async function readInspection(supabase: SupabaseClient, requestId: string, userId: string) {
  const { data, error } = await supabase.from("job_url_inspection_requests")
    .select(INSPECTION_SELECT).eq("id", requestId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as Inspection | null;
}

async function readDispatch(supabase: SupabaseClient, dispatchId: string) {
  const { data, error } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: dispatchId });
  if (error) throw error;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, any> : null;
}

async function markFailed(supabase: SupabaseClient, inspection: Inspection, message: string, needsUser = true) {
  const { error } = await supabase.rpc("mark_job_url_inspection_failed", {
    p_request_id: inspection.id,
    p_message: message.slice(0, 1800),
    p_user_required: needsUser,
  });
  if (error) throw error;
}

/**
 * Project the exact, v3-proven assistant turn into the existing authenticated
 * job-inspection persistence RPC. A database retry only repeats this idempotent
 * write; it never retries the ChatGPT dispatch or sends the prompt again.
 */
async function reconcileDispatchGroup(supabase: SupabaseClient, inspections: Inspection[], userId: string) {
  const dispatchId = inspections[0]?.dispatch_request_id;
  if (!dispatchId) return inspections;
  const dispatch = await readDispatch(supabase, dispatchId);
  if (!dispatch) return inspections;
  const state = typeof dispatch.state === "string" ? dispatch.state : "";
  const unfinished = inspections.filter((inspection) => inspection.status !== "completed");
  const reconciliationErrors = new Map<string, string>();
  const capturedResultRetries = new Set<string>();

  if (state === "completed" && unfinished.length) {
    if (dispatch.output_refs?.response_provenance_recorded !== true || typeof dispatch.bridge_response !== "string") {
      await Promise.all(unfinished.map((inspection) => markFailed(
        supabase,
        inspection,
        "ChatGPT completed without a verified exact-turn response. No listing was imported from this result.",
      )));
    } else {
      let parsed: Map<string, JobUrlInspectionBatchResult> | null = null;
      let parseError: string | null = null;
      try {
        parsed = parseJobUrlInspectionBatchResponse(dispatch.bridge_response, inspections.map((inspection) => inspection.id));
      } catch (cause) {
        parseError = cause instanceof Error ? cause.message : "The batch response was not valid structured JSON.";
        // A request sent before the batch UI was introduced may have the
        // original single-listing schema. Continue to accept that exact,
        // request-bound response for one-item legacy batches only.
        if (inspections.length === 1) {
          try {
            parsed = new Map([[inspections[0].id, {
              requestId: inspections[0].id,
              status: "found",
              extraction: parseJobUrlInspectionResponse(dispatch.bridge_response, inspections[0].id),
            }]]);
            parseError = null;
          } catch { /* retain the batch parsing error below */ }
        }
      }

      if (!parsed) {
        await Promise.all(unfinished.map((inspection) => markFailed(
          supabase,
          inspection,
          `${parseError || "ChatGPT did not return a valid batch result."} The original ChatGPT message was not resent.`,
        )));
      } else {
        await Promise.all(unfinished.map(async (inspection) => {
          const result = parsed!.get(inspection.id);
          if (!result || result.status !== "found") {
            const reason = result?.status === "unavailable" || result?.status === "not_a_job_listing"
              ? result.reason
              : "ChatGPT omitted a structured result for this listing.";
            await markFailed(supabase, inspection, `${reason} The original ChatGPT message was not resent.`, false);
            return;
          }
          try {
            const priorError = typeof inspection.error_json?.message === "string" ? inspection.error_json.message : "";
            if ((inspection.status === "failed" || inspection.status === "user_required")
              && priorError.startsWith("ChatGPT's listing response was not one valid JSON object.")) {
              capturedResultRetries.add(inspection.id);
              const { error } = await supabase.rpc("retry_captured_job_url_inspection", {
                p_request_id: inspection.id,
                p_dispatch_id: dispatchId,
              });
              if (error) throw error;
            }
            const { error } = await supabase.rpc("complete_job_url_inspection", {
              p_request_id: inspection.id,
              p_extraction: result.extraction,
              // The persisted provider name is accepted by the already-deployed
              // completion RPC. v3 response provenance above attests the origin.
              p_provider: "chatgpt_direct",
              p_provider_response_id: null,
            });
            if (error) throw error;
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "The structured listing could not be saved.";
            // Keep retrying this idempotent persistence operation from the
            // captured response; never dispatch the original ChatGPT message.
            reconciliationErrors.set(inspection.id, `${message} The captured ChatGPT response is retained and will be retried without resending the original message.`);
          }
        }));
      }
    }
  } else if (["failed", "user_required", "expired", "cancelled"].includes(state) && unfinished.length) {
    const dispatchError = dispatch.error && typeof dispatch.error === "object" ? dispatch.error as Record<string, unknown> : {};
    const message = typeof dispatchError.message === "string" ? dispatchError.message : "The Website Bridge stopped before a listing was imported.";
    await Promise.all(unfinished.map((inspection) => markFailed(supabase, inspection, message, state === "user_required")));
  }

  try {
    const refreshed = await Promise.all(inspections.map((inspection) => readInspection(supabase, inspection.id, userId)));
    let rows = inspections.map((inspection, index) => refreshed[index] || inspection);
    if (state === "queued") rows = rows.map((inspection) => inspection.status === "completed" ? inspection : { ...inspection, status: "queued" as JobUrlInspectionStatus });
    if (["sent", "acknowledged_by_mcp", "running"].includes(state)) rows = rows.map((inspection) => inspection.status === "completed" ? inspection : { ...inspection, status: "processing" as JobUrlInspectionStatus });
    if (state === "completed") rows = rows.map((inspection) => inspection.status === "completed" || inspection.status === "failed" || inspection.status === "user_required"
      ? inspection
      : { ...inspection, status: "processing" as JobUrlInspectionStatus });
    return rows.map((inspection) => {
      const message = reconciliationErrors.get(inspection.id);
      if (message) return {
        ...inspection,
        reconciliation_error: message,
        captured_result_retry_allowed: capturedResultRetries.has(inspection.id)
          && (inspection.status === "failed" || inspection.status === "user_required"),
      };
      if (state === "completed" && inspection.status === "processing") {
        return { ...inspection, reconciliation_error: "ChatGPT returned the listing. Saving the captured result into your job pool; the original message will not be resent." };
      }
      return inspection;
    });
  } catch {
    return inspections.map((inspection) => state === "completed" && inspection.status !== "completed"
      ? { ...inspection, status: "processing" as JobUrlInspectionStatus, reconciliation_error: "The captured ChatGPT result is ready, but its status could not be saved. Refresh to retry without resending the message." }
      : inspection);
  }
}

async function reconcileInspections(supabase: SupabaseClient, inspections: Inspection[], userId: string) {
  const groups = new Map<string, Inspection[]>();
  const withoutDispatch: Inspection[] = [];
  for (const inspection of inspections) {
    if (!inspection.dispatch_request_id) { withoutDispatch.push(inspection); continue; }
    const group = groups.get(inspection.dispatch_request_id) || [];
    group.push(inspection);
    groups.set(inspection.dispatch_request_id, group);
  }
  const reconciledGroups = await Promise.all([...groups.values()].map((group) => reconcileDispatchGroup(supabase, group, userId)));
  return [...reconciledGroups.flat(), ...withoutDispatch].sort((left, right) => (left.batch_position || 0) - (right.batch_position || 0));
}

function dispatchHint(dispatch: Record<string, any>) {
  const requestId = String(dispatch.id || "");
  if (!UUID_RE.test(requestId)) throw new Error("The Website Bridge did not return a valid dispatch request id.");
  return {
    version: 1,
    type: "JOBHUNT_DISPATCH_HINT",
    request_id: requestId,
    correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : requestId,
    nonce: crypto.randomUUID(),
  };
}

function stripPluginFields(dispatch: Record<string, unknown>) {
  const safe = { ...dispatch };
  delete safe.mcp_fallback_instruction;
  delete safe.required_mcp_tools;
  return safe;
}

export async function POST(request: Request) {
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = await request.json().catch(() => ({}));
    const candidates = Array.isArray(body?.sourceUrls)
      ? body.sourceUrls
      : typeof body?.sourceUrl === "string" ? [body.sourceUrl] : [];
    if (candidates.length < 1) throw new Error("Enter at least one public job listing URL.");
    if (candidates.length > MAX_BULK_URLS) throw new Error(`Import up to ${MAX_BULK_URLS} job URLs at a time.`);
    const normalized: string[] = candidates.map((candidate: unknown) => normalizeJobListingUrl(candidate));
    const sourceUrls: string[] = [...new Set<string>(normalized)];
    if (!sourceUrls.length) throw new Error("Enter at least one public job listing URL.");

    const { supabase, user } = await authenticatedClient();
    const testingModeEnabled = await readChatGptTestingMode(supabase, user.id);
    const batchId = crypto.randomUUID();
    const inspectionIds = sourceUrls.map(() => crypto.randomUUID());
    const instruction = applyChatGptTestingMode(
      buildJobUrlInspectionPrompt(sourceUrls.map((sourceUrl, index) => ({ sourceUrl, requestId: inspectionIds[index] }))),
      testingModeEnabled,
    );
    operationId = await beginChatGptOperation(supabase, `Inspect ${sourceUrls.length} job listing${sourceUrls.length === 1 ? "" : "s"}`);
    const insertRows = sourceUrls.map((sourceUrl, index) => ({
      id: inspectionIds[index],
      user_id: user.id,
      source_url: sourceUrl,
      batch_id: batchId,
      batch_position: index + 1,
    }));
    const { data: inserted, error: insertError } = await supabase.from("job_url_inspection_requests")
      .insert(insertRows).select(INSPECTION_SELECT);
    if (insertError) throw insertError;
    const inspections = (inserted || []).map(publicInspection).sort((left: Inspection, right: Inspection) => (left.batch_position || 0) - (right.batch_position || 0));
    if (inspections.length !== sourceUrls.length) throw new Error("The inspection service did not return every import row.");
    let dispatch: Record<string, any> | null = null;
    let hint: Record<string, unknown> | null = null;
    let dispatchFailure: string | null = null;
    try {
      const { data: rawDispatch, error: dispatchError } = await supabase.rpc("create_chatgpt_dispatch_request_with_website_instruction", {
        p_action_type: "job.inspect_url",
        // The generic bridge contract allows only inspection_id for this
        // action. Batch grouping stays application-owned in the inspection
        // rows linked below through the shared dispatch_request_id.
        p_subject_refs: { inspection_id: inspections[0].id },
        p_origin: "user_click",
        p_display_title: `Inspect ${inspections.length} job listing${inspections.length === 1 ? "" : "s"}`,
        p_idempotency_key: `job.inspect_url.batch:${batchId}`,
        p_priority: 70,
        p_website_instruction: instruction,
      });
      if (dispatchError) throw dispatchError;
      dispatch = stripPluginFields(rawDispatch as Record<string, any>) as Record<string, any>;
      hint = dispatchHint(dispatch);
      await trackChatGptOperation(supabase, operationId, [String(dispatch.id)]);
      operationTracked = true;
      const { data: linkedRows, error: linkError } = await supabase.from("job_url_inspection_requests")
        .update({ dispatch_request_id: dispatch.id }).eq("batch_id", batchId).eq("user_id", user.id).select("id");
      if (linkError) throw linkError;
      if (!Array.isArray(linkedRows) || linkedRows.length !== inspections.length) throw new Error("The Website Bridge request could not be linked to every listing in this batch.");
    } catch (cause) {
      dispatchFailure = cause instanceof Error ? cause.message : "Unable to queue this batch with the Website Bridge.";
      await Promise.all(inspections.map((inspection) => markFailed(supabase, inspection, `${dispatchFailure} No ChatGPT message was sent for this batch.`, false)));
    }

    const currentInspections = await Promise.all(inspections.map(async (inspection) =>
      (await readInspection(supabase, inspection.id, user.id)) || inspection));
    const items = currentInspections.map((inspection) => ({
      inspection: publicInspection(inspection),
      dispatch,
      ...(dispatchFailure ? { error: dispatchFailure } : {}),
    }));
    const first = items[0] as Record<string, any>;
    const responseBody = {
      ok: true,
      batchId,
      duplicateCount: normalized.length - sourceUrls.length,
      execution: "chatgpt_browser_bridge",
      items,
      bridge_hints: hint ? [hint] : [],
      // Keep the existing single-import response fields for older pages/links.
      requestId: first?.inspection?.id,
      inspection: first?.inspection,
      dispatch: first?.dispatch,
      bridge_hint: hint,
      error: dispatchFailure,
    };
    return NextResponse.json(responseBody, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to queue the job listing URLs.";
    if (message === "AUTH_REQUIRED") return NextResponse.json({ ok: false, error: "Sign in with an active JobHuntAI Console membership before importing a live listing." }, { status: 401 });
    if (message === "LIVE_INSPECTION_REQUIRES_SUPABASE") return NextResponse.json({ ok: false, error: "Live ChatGPT URL inspection is available after the hosted Supabase connection is enabled." }, { status: 503 });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  } finally {
    if (operationId && !operationTracked) {
      try { const { createClient } = await import("@/lib/supabase/server"); await releaseChatGptOperation(await createClient(), operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}

async function dispatchSummary(supabase: SupabaseClient, inspection: Inspection) {
  if (!inspection.dispatch_request_id) return null;
  try {
    const dispatch = await readDispatch(supabase, inspection.dispatch_request_id);
    if (!dispatch) return null;
    const progress = dispatch.progress && typeof dispatch.progress === "object" ? dispatch.progress : {};
    const lifecycle = progress.lifecycle && typeof progress.lifecycle === "object" ? progress.lifecycle : {};
    return {
      id: dispatch.id,
      state: dispatch.state,
      progress: {
        stage: typeof progress.stage === "string" ? progress.stage : undefined,
        answer_captured: progress.answer_captured === true,
        result_pending: progress.result_pending === true,
        lifecycle: {
          response_detected_at: typeof lifecycle.response_detected_at === "string" ? lifecycle.response_detected_at : undefined,
          response_uploaded_at: typeof lifecycle.response_uploaded_at === "string" ? lifecycle.response_uploaded_at : undefined,
        },
      },
      retry_allowed: dispatch.retry_allowed === true,
      manual_review_required: dispatch.manual_review_required === true,
      response_provenance_recorded: dispatch.output_refs?.response_provenance_recorded === true,
      captured_result_retry_allowed: inspection.captured_result_retry_allowed === true,
    };
  } catch {
    return null;
  }
}

function errorResponse(message: string) {
  if (message === "AUTH_REQUIRED") return NextResponse.json({ ok: false, error: "Sign in with an active JobHuntAI Console membership before viewing an inspection." }, { status: 401 });
  if (message === "LIVE_INSPECTION_REQUIRES_SUPABASE") return NextResponse.json({ ok: false, error: "Live ChatGPT URL inspection is available after the hosted Supabase connection is enabled." }, { status: 503 });
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    const requestId = search.get("id");
    const batchId = search.get("batchId");
    if ((!requestId || !validUuid(requestId)) && (!batchId || !validUuid(batchId))) {
      return NextResponse.json({ ok: false, error: "A valid inspection id or batch id is required." }, { status: 400 });
    }
    const { supabase, user } = await authenticatedClient();
    let inspections: Inspection[];
    if (batchId) {
      const { data, error } = await supabase.from("job_url_inspection_requests").select(INSPECTION_SELECT)
        .eq("batch_id", batchId).eq("user_id", user.id).order("batch_position", { ascending: true });
      if (error) throw error;
      inspections = (data || []) as Inspection[];
      if (!inspections.length) return NextResponse.json({ ok: false, error: "Import batch not found." }, { status: 404 });
    } else {
      const inspection = await readInspection(supabase, requestId!, user.id);
      if (!inspection) return NextResponse.json({ ok: false, error: "Inspection request not found." }, { status: 404 });
      inspections = [inspection];
    }

    const reconciled = await reconcileInspections(supabase, inspections, user.id);
    if (reconciled.some((inspection) => inspection.status === "completed" && Boolean(inspection.job_id))) {
      await recordJobPoolSheetSyncInBackground(supabase, user.id);
    }
    const items = await Promise.all(reconciled.map(async (inspection) => ({
      inspection: publicInspection(inspection),
      dispatch: await dispatchSummary(supabase, inspection),
    })));
    if (!batchId) return NextResponse.json({ ok: true, inspection: items[0].inspection, dispatch: items[0].dispatch }, { headers: { "Cache-Control": "private, no-store" } });
    const counts = items.reduce((summary, item) => {
      summary[item.inspection.status] = (summary[item.inspection.status] || 0) + 1;
      return summary;
    }, {} as Record<string, number>);
    return NextResponse.json({ ok: true, batchId, items, counts }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to read the job listing inspections.");
  }
}
