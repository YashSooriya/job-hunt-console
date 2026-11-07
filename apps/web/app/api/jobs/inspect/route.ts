import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { normalizeJobListingUrl, type JobUrlInspectionStatus } from "@/lib/job-url-inspection";
import { buildJobUrlInspectionInstruction } from "@/lib/job-url-inspection-prompt";
import { parseCombinedJobUrlInspectionResponse, parseJobUrlInspectionBatchResponse, parseJobUrlInspectionResponse, type CombinedJobUrlInspectionResult, type JobUrlInspectionBatchResult } from "@/lib/job-url-inspection-response";
import { readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";
import { recordJobPoolSheetSyncInBackground } from "@/lib/google-job-pool-sheet";
import { buildMemoryFitChunkPersistence } from "@/lib/job-fit-memory-v4/worker";
import { MEMORY_FIT_RESPONSE_VERSION, MEMORY_FIT_RUBRIC_VERSION, type MemoryFitResponseJob } from "@/lib/job-fit-memory-v4/contract";

const MAX_BULK_URLS = 10;
const INSPECTION_SELECT = "id,source_url,original_source_url,status,attempt_count,error_json,job_id,provider,provider_response_id,completed_at,created_at,updated_at,batch_id,batch_position,dispatch_request_id,initial_fit_status,initial_fit_error,initial_fit_analysis_id,initial_fit_response_hash,initial_fit_assessment_as_of,initial_fit_testing_mode";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Inspection = {
  id: string;
  source_url: string;
  original_source_url?: string | null;
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
  initial_fit_status?: string | null;
  initial_fit_error?: string | null;
  initial_fit_analysis_id?: string | null;
  initial_fit_response_hash?: string | null;
  initial_fit_assessment_as_of?: string | null;
  initial_fit_testing_mode?: boolean;
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
    original_source_url: value.original_source_url || value.source_url,
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
    initial_fit_status: value.initial_fit_status || null,
    initial_fit_error: value.initial_fit_error || null,
    initial_fit_analysis_id: value.initial_fit_analysis_id || null,
    initial_fit_response_hash: value.initial_fit_response_hash || null,
    initial_fit_assessment_as_of: value.initial_fit_assessment_as_of || null,
    initial_fit_testing_mode: value.initial_fit_testing_mode === true,
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

async function readBatchDispatch(supabase: SupabaseClient, batchId: string) {
  const { data, error } = await supabase.rpc("get_job_url_inspection_batch_dispatch", { p_batch_id: batchId });
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

async function markInitialFitNeedsUser(supabase: SupabaseClient, inspection: Inspection, dispatchId: string | null | undefined, message: string) {
  const { error } = await supabase.rpc("mark_job_url_inspection_initial_fit_needs_user", {
    p_request_id: inspection.id,
    p_dispatch_id: dispatchId || null,
    p_fit_error: message.slice(0, 1800),
  });
  if (error) throw error;
}

async function saveTerminalInitialFitOutcome(
  supabase: SupabaseClient,
  inspection: Inspection,
  dispatchId: string,
  responseHash: string,
  status: "listing_unavailable" | "wrong_listing" | "invalid_response" | "missing_result" | "needs_user",
  message: string,
) {
  const { error } = await supabase.rpc("save_job_url_inspection_initial_fit_outcome", {
    p_request_id: inspection.id,
    p_dispatch_id: dispatchId,
    p_response_hash: responseHash,
    p_fit_status: status,
    p_fit_error: message.slice(0, 1800),
  });
  if (error) throw error;
}

function terminalFitOutcome(result: Extract<CombinedJobUrlInspectionResult, { status: "unavailable" | "not_a_job_listing" | "wrong_listing" }>) {
  if (result.status === "wrong_listing" || result.status === "not_a_job_listing") {
    return { status: "wrong_listing" as const, message: result.reason };
  }
  if (/omitted this listing result/i.test(result.reason)) return { status: "missing_result" as const, message: result.reason };
  if (/returned (?:an incomplete|this request more than once)|result was incomplete or unsupported|could not be saved safely/i.test(result.reason)) {
    return { status: "invalid_response" as const, message: result.reason };
  }
  return { status: "listing_unavailable" as const, message: result.reason };
}

function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function rows(value: unknown): Array<Record<string, any>> { return Array.isArray(value) ? value.map(record) : []; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function listingRevisionSignature(extraction: Record<string, any>) {
  const fields = [
    "company", "title", "industry", "description", "application_url", "external_job_id", "location", "work_mode",
    "salary_text", "salary_min", "salary_max", "salary_currency", "salary_source", "salary_confidence", "salary_basis",
    "posted_at", "closes_at", "employment_type", "ats_provider", "summary", "responsibilities",
    "essential_requirements", "desirable_requirements", "skills", "benefits", "application_instructions",
  ];
  return stableJson(Object.fromEntries(fields.map((field) => [field, extraction[field] ?? null])));
}

function persistedListingMatches(job: Record<string, any>, snapshot: Record<string, any>, extraction: Record<string, any>) {
  const metadataListing = record(record(snapshot.raw_metadata).listing_extraction);
  const reconstructed = { ...metadataListing, company: snapshot.company_name, description: snapshot.description_text };
  if (listingRevisionSignature(reconstructed) !== listingRevisionSignature(extraction)) return false;
  // Industry is retained in this exact snapshot extraction; the shared legacy
  // completion writer does not map it into jobs.industry.
  const same = (actual: unknown, expected: unknown, kind: "text" | "number" | "date" = "text") => {
    if (kind === "number") {
      const left = actual == null ? null : Number(actual);
      const right = expected == null ? null : Number(expected);
      return left === right && (left === null || Number.isFinite(left));
    }
    if (kind === "date") {
      const normalize = (value: unknown) => {
        if (value == null) return null;
        if (typeof value !== "string") return String(value);
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
      };
      return normalize(actual) === normalize(expected);
    }
    return (typeof actual === "string" ? actual.trim() : actual ?? null) === (typeof expected === "string" ? expected.trim() : expected ?? null);
  };
  const pairs: Array<[unknown, unknown, ("text" | "number" | "date")?]> = [
    [snapshot.company_name, extraction.company], [job.title, extraction.title],
    [job.source_url, extraction.source_url], [job.application_url, extraction.application_url],
    [job.external_job_id, extraction.external_job_id], [job.location_text, extraction.location],
    [job.work_mode, extraction.work_mode], [job.salary_text, extraction.salary_text],
    [job.salary_min, extraction.salary_min, "number"], [job.salary_max, extraction.salary_max, "number"],
    [job.posted_at, extraction.posted_at, "date"], [job.closes_at, extraction.closes_at, "date"],
    [job.employment_type, extraction.employment_type], [job.ats_provider, extraction.ats_provider],
  ];
  if (!pairs.every(([actual, expected, kind]) => same(actual, expected, kind || "text"))) return false;
  const storedCurrency = typeof job.salary_currency === "string" ? job.salary_currency.toUpperCase() : null;
  const expectedCurrency = typeof extraction.salary_currency === "string" ? extraction.salary_currency.toUpperCase() : "GBP";
  return storedCurrency === expectedCurrency;
}

function fitSignature(result: CombinedJobUrlInspectionResult | undefined) {
  if (!result || result.status !== "found" || !result.fit || result.fitIssue) return null;
  const { job_id: _jobId, listing_url: _listingUrl, ...fit } = result.fit;
  return stableJson(fit);
}

function sameVacancyRevision(left: CombinedJobUrlInspectionResult | undefined, right: CombinedJobUrlInspectionResult | undefined) {
  return Boolean(left && right && left.status === "found" && right.status === "found"
    && listingRevisionSignature(left.extraction) === listingRevisionSignature(right.extraction));
}

function exactFitEquivalent(left: CombinedJobUrlInspectionResult | undefined, right: CombinedJobUrlInspectionResult | undefined) {
  const leftSignature = fitSignature(left);
  return leftSignature !== null && leftSignature === fitSignature(right);
}

function finalForCapturedResponse(inspection: Inspection, responseHash: string) {
  return /^[0-9a-f]{64}$/.test(responseHash)
    && inspection.initial_fit_response_hash === responseHash
    && ["assessed", "insufficient_memory", "incomplete", "listing_unavailable", "wrong_listing", "invalid_response", "missing_result", "needs_user"]
      .includes(String(inspection.initial_fit_status || ""));
}

/** Persist the exact response's fit fields through the existing v4 fit batches and analysis tables. */
async function persistCombinedInitialFits(
  supabase: SupabaseClient,
  inspections: Inspection[],
  parsed: ReturnType<typeof parseCombinedJobUrlInspectionResponse>,
  dispatch: Record<string, any>,
  userId: string,
) {
  const batchId = inspections[0]?.batch_id;
  const assessmentAsOf = inspections[0]?.initial_fit_assessment_as_of;
  const responseHash = typeof dispatch.response_hash === "string" ? dispatch.response_hash : "";
  if (!batchId || !assessmentAsOf || !responseHash || typeof dispatch.id !== "string") {
    throw new Error("The combined fit result is missing its saved batch or exact-response identity.");
  }

  const completed = inspections.filter((inspection) => inspection.status === "completed" && inspection.job_id);
  if (!completed.length) return;
  const jobIds = [...new Set(completed.map((inspection) => inspection.job_id!))];
  const { data: jobData, error: jobError } = await supabase.from("jobs")
    .select("id,title,industry,source_url,application_url,external_job_id,analysis_revision,current_snapshot_id,location_text,work_mode,employment_type,salary_min,salary_max,salary_currency,salary_text,posted_at,closes_at,ats_provider,discovery_source")
    .eq("user_id", userId).in("id", jobIds);
  if (jobError) throw jobError;
  const jobs = rows(jobData);
  if (jobs.length !== jobIds.length) throw new Error("The imported jobs could not be re-read under the current user's ownership.");
  const snapshotIds = jobs.map((job) => job.current_snapshot_id).filter((id) => typeof id === "string");
  const snapshotRead = snapshotIds.length
    ? await supabase.from("job_snapshots").select("id,description_text,company_name,raw_metadata").in("id", snapshotIds)
    : { data: [], error: null };
  if (snapshotRead.error) throw snapshotRead.error;
  const snapshots = new Map(rows(snapshotRead.data).map((snapshot) => [snapshot.id, snapshot]));
  const profileRead = await supabase.from("candidate_profiles").select("id").eq("user_id", userId).maybeSingle();
  if (profileRead.error) throw profileRead.error;
  const preferencesRead = profileRead.data?.id
    ? await supabase.from("candidate_preferences").select("preferences").eq("profile_id", profileRead.data.id).maybeSingle()
    : { data: null, error: null };
  if (preferencesRead.error) throw preferencesRead.error;
  const preferences = record(preferencesRead.data?.preferences);

  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const ordered = completed.map((inspection) => ({
    inspection,
    job: jobsById.get(inspection.job_id!),
    result: parsed.results.get(inspection.id),
  }));
  if (ordered.some((item) => !item.job)) throw new Error("An imported job no longer belongs to the exact combined batch.");

  // Several verified source URLs can resolve to one ATS vacancy. The listing
  // completion RPC updates that owned job as each request is saved, so the
  // snapshot's inspection_request_id identifies which exact row produced the
  // current listing revision. Persist one v4 item for that revision only.
  const currentByJob = new Map<string, typeof ordered[number]>();
  const staleInspectionIds = new Set<string>();
  for (const jobId of jobIds) {
    const group = ordered.filter((item) => item.inspection.job_id === jobId);
    const job = jobsById.get(jobId)!;
    const snapshot = snapshots.get(job.current_snapshot_id) || {};
    const listing = record(record(snapshot.raw_metadata).listing_extraction);
    const sourceRequestId = typeof listing.inspection_request_id === "string" ? listing.inspection_request_id : "";
    const current = group.find((item) => item.inspection.id === sourceRequestId);
    const result = current ? current.result : undefined;
    if (!current || result?.status !== "found" || !persistedListingMatches(job, snapshot, result.extraction)) {
      for (const item of group) staleInspectionIds.add(item.inspection.id);
      continue;
    }
    currentByJob.set(jobId, current);
  }
  const staleMessage = "The saved vacancy changed after this exact Bridge response was captured. Its fit was not attached to the changed listing; run a new selected-job analysis for the current revision.";
  for (const item of ordered.filter(({ inspection }) => staleInspectionIds.has(inspection.id)
    && !finalForCapturedResponse(inspection, responseHash))) {
    await saveTerminalInitialFitOutcome(supabase, item.inspection, dispatch.id, responseHash, "invalid_response", staleMessage);
  }
  const fitJobs = [...currentByJob.values()].sort((left, right) => (left.inspection.batch_position || 0) - (right.inspection.batch_position || 0));
  if (!fitJobs.length) return;

  const chunks = [] as Array<{ ordinal: number; job_ids: string[]; instruction: string; idempotency_key: string }>;
  for (let offset = 0; offset < fitJobs.length; offset += 5) {
    const group = fitJobs.slice(offset, offset + 5);
    const ordinal = Math.floor(offset / 5) + 1;
    chunks.push({
      ordinal,
      job_ids: group.map((item) => item.inspection.job_id!),
      instruction: `Validated fit projection from the exact combined URL import response ${responseHash}. No second Bridge message was created.`,
      idempotency_key: `jobfit-memory-v4:${batchId}:${ordinal}`,
    });
  }
  const fitBatchJobs = fitJobs.map((item, index) => ({
    job_id: item.job!.id,
    listing_url: item.inspection.source_url,
    job_revision: Number(item.job!.analysis_revision),
    chunk_ordinal: Math.floor(index / 5) + 1,
  }));
  const { error: batchError } = await supabase.rpc("create_job_fit_memory_v4_batch", {
    p_batch_id: batchId,
    p_request_id: batchId,
    p_mode: "selected",
    p_assessment_as_of: assessmentAsOf,
    p_testing_mode: inspections[0]?.initial_fit_testing_mode === true,
    p_jobs: fitBatchJobs,
    p_chunks: chunks,
  });
  if (batchError) throw batchError;

  const [{ data: batchData, error: savedBatchError }, { data: chunkData, error: chunkReadError }, { data: itemData, error: itemReadError }] = await Promise.all([
    supabase.from("job_fit_memory_v4_batches").select("*").eq("id", batchId).eq("user_id", userId).single(),
    supabase.from("job_fit_memory_v4_chunks").select("*").eq("batch_id", batchId).eq("user_id", userId).order("ordinal"),
    supabase.from("job_fit_memory_v4_items").select("*").eq("batch_id", batchId).eq("user_id", userId),
  ]);
  if (savedBatchError) throw savedBatchError;
  if (chunkReadError) throw chunkReadError;
  if (itemReadError) throw itemReadError;
  const fitBatch = record(batchData);
  const fitChunks = rows(chunkData);
  const fitItems = rows(itemData);
  if (fitItems.length !== fitJobs.length || fitChunks.length !== chunks.length) throw new Error("The durable initial-fit projection did not contain every extracted vacancy.");

  const canonicalItems = fitItems.sort((left, right) => fitBatch.requested_job_ids.indexOf(left.job_id) - fitBatch.requested_job_ids.indexOf(right.job_id));
  for (const chunk of fitChunks) {
    const chunkItems = canonicalItems.filter((item) => item.chunk_id === chunk.id);
    const chunkItemsFinal = chunkItems.every((item) => ["assessed", "insufficient_memory", "invalid_response", "missing_result", "listing_unavailable", "wrong_listing"]
      .includes(String(item.state || "")));
    if (chunk.state === "completed" && chunkItemsFinal) continue;
    const projectionJobs: MemoryFitResponseJob[] = [];
    for (const item of chunkItems) {
      const sourceInspection = currentByJob.get(item.job_id)?.inspection;
      const combinedResult = sourceInspection ? parsed.results.get(sourceInspection.id) : null;
      if (combinedResult?.status === "found" && combinedResult.fit) {
        projectionJobs.push({ ...combinedResult.fit, job_id: item.job_id, listing_url: item.listing_url });
      }
    }
    const capturedResponse = JSON.stringify({
      schema_version: MEMORY_FIT_RESPONSE_VERSION,
      request_id: batchId,
      batch_id: batchId,
      rubric_version: MEMORY_FIT_RUBRIC_VERSION,
      assessment_as_of: assessmentAsOf,
      jobs: projectionJobs,
    });
    const capturedHash = sha256(capturedResponse);
    const provenance = {
      source: "combined_job_url_import_projection_v1",
      dispatch_id: dispatch.id,
      original_response_hash: responseHash,
      fit_only_projection: true,
    };
    const capturedAlreadyMatches = chunk.captured_response === capturedResponse && chunk.captured_response_hash === capturedHash;
    if (!capturedAlreadyMatches) {
      const { error: chunkUpdateError } = await supabase.from("job_fit_memory_v4_chunks").update({
        state: "saving", captured_response: capturedResponse, captured_response_hash: capturedHash,
        captured_response_at: dispatch.bridge_response_at || new Date().toISOString(), response_provenance: provenance,
        error_message: null, updated_at: new Date().toISOString(),
      }).eq("id", chunk.id).eq("user_id", userId);
      if (chunkUpdateError) throw chunkUpdateError;
      const { error: itemUpdateError } = await supabase.from("job_fit_memory_v4_items").update({ state: "saving", updated_at: new Date().toISOString() })
        .eq("chunk_id", chunk.id).eq("user_id", userId).in("state", ["queued", "saving"]);
      if (itemUpdateError) throw itemUpdateError;
    }

    const contextRows = chunkItems.map((item) => {
      const job = jobsById.get(item.job_id)!;
      return { item, job, snapshot: snapshots.get(job.current_snapshot_id) || {} };
    });
    const prepared = buildMemoryFitChunkPersistence({
      batch: fitBatch,
      chunk: { ...chunk, state: "saving", captured_response: capturedResponse, captured_response_hash: capturedHash },
      items: chunkItems,
      jobs,
      preferences,
      contextRows,
    });
    const { error: saveError } = await supabase.rpc("save_job_fit_memory_v4_chunk_results", {
      p_chunk_id: chunk.id,
      p_results: prepared.results,
    });
    if (saveError) throw saveError;
  }

  const { data: savedItems, error: savedItemsError } = await supabase.from("job_fit_memory_v4_items")
    .select("job_id,state,analysis_id,error_message,result_json").eq("batch_id", batchId).eq("user_id", userId);
  if (savedItemsError) throw savedItemsError;
  const savedByJob = new Map(rows(savedItems).map((item) => [item.job_id, item]));
  await Promise.all(ordered.filter(({ inspection }) => !finalForCapturedResponse(inspection, responseHash)).map(async ({ inspection }) => {
    const item = record(savedByJob.get(inspection.job_id!));
    const result = parsed.results.get(inspection.id);
    const current = currentByJob.get(inspection.job_id!);
    const currentResult = current ? parsed.results.get(current.inspection.id) : undefined;
    const canShareCurrentAnalysis = !staleInspectionIds.has(inspection.id) && (inspection.id === current?.inspection.id
      || (sameVacancyRevision(result, currentResult) && exactFitEquivalent(result, currentResult)));
    const partial = item.result_json?.completeness === "partial";
    const revisionMismatch = result?.status === "found" && result.fit && !canShareCurrentAnalysis;
    const status = revisionMismatch
      ? "invalid_response"
      : result?.status === "found" && result.fit?.status === "insufficient_memory"
      ? "insufficient_memory"
      : result?.status === "found" && result.fitIssue
        ? result.fitIssue
        : item.analysis_id
          ? partial ? "incomplete" : item.state
          : item.state === "listing_unavailable" || item.state === "wrong_listing" || item.state === "missing_result" || item.state === "invalid_response"
            ? item.state
            : "needs_user";
    const { error } = await supabase.rpc("save_job_url_inspection_initial_fit", {
      p_request_id: inspection.id,
      p_dispatch_id: dispatch.id,
      p_response_hash: responseHash,
      p_fit_status: status,
      p_fit_error: revisionMismatch
        ? "This URL resolved to an existing vacancy, but its listing revision or fit differed from the exact result selected for the current saved revision. No mismatched fit was attached."
        : result?.status === "found" ? result.fitError || (typeof item.error_message === "string" ? item.error_message : null) : result?.reason || null,
      p_analysis_id: canShareCurrentAnalysis ? item.analysis_id || null : null,
    });
    if (error) throw error;
  }));
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
  const responseHash = typeof dispatch.response_hash === "string" ? dispatch.response_hash : "";
  const unfinished = inspections.filter((inspection) => inspection.status !== "completed"
    && !(state === "completed" && finalForCapturedResponse(inspection, responseHash)));
  const needsFitReconciliation = inspections.some((inspection) => Boolean(inspection.initial_fit_assessment_as_of)
    && !finalForCapturedResponse(inspection, responseHash));
  const reconciliationErrors = new Map<string, string>();
  const capturedResultRetries = new Set<string>();

  if (state === "completed") {
    if (dispatch.output_refs?.response_provenance_recorded !== true || typeof dispatch.bridge_response !== "string") {
      const message = "ChatGPT completed without a verified exact-turn response. No listing was imported from this result.";
      await Promise.all(unfinished.map((inspection) => markFailed(
        supabase,
        inspection,
        message,
      )));
      await Promise.all(inspections.filter((inspection) => inspection.initial_fit_assessment_as_of
        && (!inspection.initial_fit_status || inspection.initial_fit_status === "pending"))
        .map(async (inspection) => {
          try { await markInitialFitNeedsUser(supabase, inspection, dispatchId, message); }
          catch (cause) { reconciliationErrors.set(inspection.id, cause instanceof Error ? cause.message : "The unverified fit result needs attention."); }
        }));
    } else if (unfinished.length || needsFitReconciliation) {
      const m04 = Boolean(inspections[0]?.batch_id && inspections[0]?.initial_fit_assessment_as_of);
      let combined: ReturnType<typeof parseCombinedJobUrlInspectionResponse> | null = null;
      let legacy: Map<string, JobUrlInspectionBatchResult> | null = null;
      let parseError: string | null = null;
      try {
        if (m04) {
          combined = parseCombinedJobUrlInspectionResponse(dispatch.bridge_response, {
            batchId: inspections[0].batch_id!,
            assessmentAsOf: inspections[0].initial_fit_assessment_as_of!,
            items: inspections.map((inspection) => ({ requestId: inspection.id, sourceUrl: inspection.source_url })),
          });
        } else {
          legacy = parseJobUrlInspectionBatchResponse(dispatch.bridge_response, inspections.map((inspection) => inspection.id));
          if (inspections.length === 1 && !legacy.get(inspections[0].id)) {
            legacy = new Map([[inspections[0].id, {
              requestId: inspections[0].id, status: "found",
              extraction: parseJobUrlInspectionResponse(dispatch.bridge_response, inspections[0].id),
            }]]);
          }
        }
      } catch (cause) {
        parseError = cause instanceof Error ? cause.message : "The combined response was not valid structured JSON.";
      }

      if (!combined && !legacy) {
        const terminalStatus = m04 && /^[0-9a-f]{64}$/.test(responseHash) ? "invalid_response" as const : null;
        await Promise.all(unfinished.map((inspection) => markFailed(
          supabase,
          inspection,
          `${parseError || "ChatGPT did not return a valid combined batch result."} The original ChatGPT message was not resent.`,
        )));
        const message = `${parseError || "ChatGPT did not return a valid combined batch result."} The original ChatGPT message was not resent.`;
        await Promise.all((m04 ? inspections : []).filter((inspection) => inspection.initial_fit_assessment_as_of
          && !finalForCapturedResponse(inspection, responseHash))
          .map(async (inspection) => {
            try {
              if (terminalStatus) await saveTerminalInitialFitOutcome(supabase, inspection, dispatchId, responseHash, terminalStatus, message);
              else await markInitialFitNeedsUser(supabase, inspection, dispatchId, message);
            } catch (cause) {
              reconciliationErrors.set(inspection.id, `${cause instanceof Error ? cause.message : "The captured fit result could not be finalized."} The original message was not resent.`);
            }
          }));
      } else {
        const resultFor = (id: string) => combined?.results.get(id) || legacy?.get(id);
        // Complete in the saved batch order. Distinct request URLs may resolve
        // to one ATS job; deterministic order ensures the current snapshot and
        // its inspection_request_id agree before fit projection.
        for (const inspection of [...unfinished].sort((left, right) => (left.batch_position || 0) - (right.batch_position || 0))) {
          const result = resultFor(inspection.id);
          if (!result || result.status !== "found") {
            const reason = result && "reason" in result ? result.reason : "ChatGPT omitted a structured result for this listing.";
            await markFailed(supabase, inspection, `${reason} The original ChatGPT message was not resent.`, false);
            if (combined && inspections[0]?.batch_id && !finalForCapturedResponse(inspection, responseHash)) {
              const outcome = result ? terminalFitOutcome(result) : { status: "missing_result" as const, message: reason };
              try {
                if (/^[0-9a-f]{64}$/.test(responseHash)) {
                  await saveTerminalInitialFitOutcome(supabase, inspection, dispatchId, responseHash, outcome.status, outcome.message);
                } else {
                  await markInitialFitNeedsUser(supabase, inspection, dispatchId, outcome.message);
                }
              } catch (cause) {
                reconciliationErrors.set(inspection.id, `${cause instanceof Error ? cause.message : "The terminal fit outcome could not be saved."} The original message was not resent.`);
              }
            }
            continue;
          }
          try {
            const priorError = typeof inspection.error_json?.message === "string" ? inspection.error_json.message : "";
            if ((inspection.status === "failed" || inspection.status === "user_required")
              && priorError.startsWith("ChatGPT's listing response was not one valid JSON object.")) {
              capturedResultRetries.add(inspection.id);
              const { error } = await supabase.rpc("retry_captured_job_url_inspection", {
                p_request_id: inspection.id, p_dispatch_id: dispatchId,
              });
              if (error) throw error;
            }
            const { error } = await supabase.rpc("complete_job_url_inspection", {
              p_request_id: inspection.id,
              p_extraction: result.extraction,
              p_provider: "chatgpt_direct",
              p_provider_response_id: null,
            });
            if (error) throw error;
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "The structured listing could not be saved.";
            reconciliationErrors.set(inspection.id, `${message} The captured response is retained and will be retried without resending the original message.`);
          }
        }

        if (combined && needsFitReconciliation) {
          try {
            const refreshed = await Promise.all(inspections.map((inspection) => readInspection(supabase, inspection.id, userId)));
            const current = inspections.map((inspection, index) => refreshed[index] || inspection);
            await persistCombinedInitialFits(supabase, current, combined, dispatch, userId);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "The captured initial fit could not be saved.";
            for (const inspection of inspections.filter((item) => item.status === "completed" && item.job_id)) {
              reconciliationErrors.set(inspection.id, `${message} The exact Bridge response remains captured; no message was resent.`);
            }
          }
        }
      }
    }
  } else if (["failed", "user_required", "expired", "cancelled"].includes(state)
    && (unfinished.length || inspections.some((inspection) => inspection.initial_fit_assessment_as_of
      && (!inspection.initial_fit_status || inspection.initial_fit_status === "pending")))) {
    const dispatchError = dispatch.error && typeof dispatch.error === "object" ? dispatch.error as Record<string, unknown> : {};
    const message = typeof dispatchError.message === "string" ? dispatchError.message : "The Website Bridge stopped before a listing was imported.";
    await Promise.all(unfinished.map((inspection) => markFailed(supabase, inspection, message, state === "user_required")));
    await Promise.all(inspections.filter((inspection) => inspection.batch_id && inspection.initial_fit_assessment_as_of
      && (!inspection.initial_fit_status || inspection.initial_fit_status === "pending"))
      .map(async (inspection) => {
        try { await markInitialFitNeedsUser(supabase, inspection, dispatchId, message); }
        catch (cause) { reconciliationErrors.set(inspection.id, cause instanceof Error ? cause.message : "The stopped fit request needs attention."); }
      }));
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

function batchInstruction(inspections: Inspection[]) {
  const batchId = inspections[0]?.batch_id;
  const assessmentAsOf = inspections[0]?.initial_fit_assessment_as_of;
  if (!batchId || !assessmentAsOf || inspections.some((inspection) => inspection.batch_id !== batchId
    || inspection.initial_fit_assessment_as_of !== assessmentAsOf
    || inspection.initial_fit_testing_mode !== inspections[0]?.initial_fit_testing_mode)) {
    throw new Error("This saved import is missing the exact batch and assessment identity needed for safe recovery.");
  }
  const assessmentTimestamp = new Date(assessmentAsOf);
  if (!Number.isFinite(assessmentTimestamp.getTime())) {
    throw new Error("This saved import has an invalid assessment timestamp and cannot be safely recovered.");
  }
  return buildJobUrlInspectionInstruction(
    inspections.map((inspection) => ({ sourceUrl: inspection.source_url, requestId: inspection.id })),
    { batchId, assessmentAsOf: assessmentTimestamp.toISOString() },
    inspections[0].initial_fit_testing_mode === true,
  );
}

async function createOrRecoverBatchDispatch(supabase: SupabaseClient, batchId: string, inspections: Inspection[]): Promise<Record<string, any>> {
  const { data, error } = await supabase.rpc("create_job_url_inspection_batch_dispatch", {
    p_batch_id: batchId,
    p_website_instruction: batchInstruction(inspections),
  });
  if (error) throw error;
  const dispatch = stripPluginFields(record(data));
  if (typeof dispatch.id !== "string" || !UUID_RE.test(dispatch.id)
    || dispatch.action_type !== "job.inspect_url"
    || dispatch.idempotency_key !== `job.inspect_url.batch:${batchId}`) {
    throw new Error("The saved combined import did not return its exact idempotent Website Bridge dispatch.");
  }
  return dispatch as Record<string, any>;
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
  let recoveryBatchId: string | null = null;
  let batchPersistenceAttempted = false;
  try {
    const body = await request.json().catch(() => ({}));
    const requestedBatchId = body?.batchId;
    if (requestedBatchId !== undefined && (typeof requestedBatchId !== "string" || !validUuid(requestedBatchId))) {
      throw new Error("The import idempotency key must be a valid UUID.");
    }
    const candidates = Array.isArray(body?.sourceUrls)
      ? body.sourceUrls
      : typeof body?.sourceUrl === "string" ? [body.sourceUrl] : [];
    if (candidates.length < 1) throw new Error("Enter at least one public job listing URL.");
    if (candidates.length > MAX_BULK_URLS) throw new Error(`Import up to ${MAX_BULK_URLS} job URLs at a time.`);
    const submitted = candidates.map((candidate: unknown) => {
      if (typeof candidate !== "string") throw new Error("Every job listing URL must be text.");
      const originalSourceUrl = candidate.trim();
      return { originalSourceUrl, sourceUrl: normalizeJobListingUrl(originalSourceUrl) };
    });
    const uniqueByUrl = new Map<string, { originalSourceUrl: string; sourceUrl: string }>();
    for (const item of submitted) if (!uniqueByUrl.has(item.sourceUrl)) uniqueByUrl.set(item.sourceUrl, item);
    const entries = [...uniqueByUrl.values()];
    if (!entries.length) throw new Error("Enter at least one public job listing URL.");
    const sourceUrls = entries.map((item) => item.sourceUrl);

    const { supabase, user } = await authenticatedClient();
    const batchId = typeof requestedBatchId === "string" ? requestedBatchId : crypto.randomUUID();
    recoveryBatchId = batchId;
    if (typeof requestedBatchId === "string") {
      const { data: existingData, error: existingError } = await supabase.from("job_url_inspection_requests")
        .select(INSPECTION_SELECT).eq("batch_id", batchId).eq("user_id", user.id).order("batch_position", { ascending: true });
      if (existingError) throw existingError;
      const existing = (existingData || []) as Inspection[];
      if (existing.length) {
        const sameRequest = existing.length === entries.length && existing.every((inspection, index) =>
          inspection.source_url === entries[index]?.sourceUrl
          && (inspection.original_source_url || inspection.source_url) === entries[index]?.originalSourceUrl);
        if (!sameRequest) return NextResponse.json({ ok: false, error: "This import retry id is already bound to a different URL list. Keep the entered URLs and submit again to start a new request." }, { status: 409 });
        const dispatchIds = [...new Set(existing.map((inspection) => inspection.dispatch_request_id).filter((id): id is string => Boolean(id)))];
        if (dispatchIds.length > 1) {
          return NextResponse.json({ ok: false, error: "This saved import is linked to more than one Bridge request and needs review. No new dispatch was created.", batchId }, { status: 409 });
        }
        batchPersistenceAttempted = true;
        let dispatch: Record<string, any> | null = null;
        const fullyLinked = dispatchIds.length === 1 && existing.every((inspection) => inspection.dispatch_request_id === dispatchIds[0]);
        if (fullyLinked) {
          dispatch = await readDispatch(supabase, dispatchIds[0]);
          if (!dispatch) return NextResponse.json({ ok: false, error: "The saved import's Bridge state could not be read. Retry this batch later; no replacement dispatch was created.", batchId }, { status: 503 });
        } else {
          if (!dispatchIds.length) {
            // A prior pre-transaction M04 writer could commit the generic
            // dispatch and crash before linking it to its saved inspection
            // rows. Do not let that exact orphan dispatch block its own
            // recovery via the user-wide active-operation lock. Acquire the
            // lock only when no matching owner-scoped dispatch exists; the
            // atomic RPC below still decides and links by the stable key.
            const orphan = await readBatchDispatch(supabase, batchId);
            if (!orphan) {
              operationId = await beginChatGptOperation(supabase, `Recover ${existing.length} saved job listing${existing.length === 1 ? "" : "s"}`);
            } else if (orphan.action_type !== "job.inspect_url" || orphan.idempotency_key !== `job.inspect_url.batch:${batchId}`) {
              return NextResponse.json({ ok: false, error: "The saved batch has a conflicting Bridge dispatch and needs review; no replacement message was created.", batchId }, { status: 409 });
            }
          } else {
            const known = await readDispatch(supabase, dispatchIds[0]);
            if (!known) return NextResponse.json({ ok: false, error: "The saved import's linked dispatch could not be read. Retry this batch later; its delivery state is unverified.", batchId }, { status: 503 });
          }
          dispatch = await createOrRecoverBatchDispatch(supabase, batchId, existing);
          if (dispatchIds.length && dispatch.id !== dispatchIds[0]) {
            throw new Error("The recovered dispatch did not match the saved batch's existing dispatch identity.");
          }
          if (operationId) {
            await trackChatGptOperation(supabase, operationId, [dispatch.id]);
            operationTracked = true;
          }
        }
        const reconciled = await reconcileInspections(supabase, existing, user.id);
        const items = await Promise.all(reconciled.map(async (inspection) => ({
            inspection: publicInspection(inspection),
            dispatch: await dispatchSummary(supabase, inspection),
          })));
        const hint = String(dispatch.state) === "queued" ? dispatchHint(dispatch) : null;
        const first = items[0] as Record<string, any> | undefined;
        return NextResponse.json({
          ok: true, batchId, duplicateCount: submitted.length - sourceUrls.length,
          execution: "chatgpt_browser_bridge", idempotentReplay: true, items,
          bridge_hints: hint ? [hint] : [], requestId: first?.inspection?.id,
          inspection: first?.inspection, dispatch: stripPluginFields(dispatch),
          bridge_hint: hint,
        }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
      }
    }
    const testingModeEnabled = await readChatGptTestingMode(supabase, user.id);
    const assessmentAsOf = new Date().toISOString();
    const inspectionIds = sourceUrls.map(() => crypto.randomUUID());
    buildJobUrlInspectionInstruction(
      sourceUrls.map((sourceUrl, index) => ({ sourceUrl, requestId: inspectionIds[index] })),
      { batchId, assessmentAsOf },
      testingModeEnabled,
    );
    operationId = await beginChatGptOperation(supabase, `Inspect ${sourceUrls.length} job listing${sourceUrls.length === 1 ? "" : "s"}`);
    const insertRows = entries.map((entry, index) => ({
      id: inspectionIds[index],
      user_id: user.id,
      source_url: entry.sourceUrl,
      original_source_url: entry.originalSourceUrl,
      batch_id: batchId,
      batch_position: index + 1,
      initial_fit_status: "pending",
      initial_fit_assessment_as_of: assessmentAsOf,
      initial_fit_testing_mode: testingModeEnabled,
    }));
    batchPersistenceAttempted = true;
    const { data: inserted, error: insertError } = await supabase.from("job_url_inspection_requests")
      .insert(insertRows).select(INSPECTION_SELECT);
    if (insertError) throw insertError;
    const inspections = (inserted || []).map(publicInspection).sort((left: Inspection, right: Inspection) => (left.batch_position || 0) - (right.batch_position || 0));
    if (inspections.length !== sourceUrls.length) throw new Error("The inspection service did not return every import row.");
    const dispatch = await createOrRecoverBatchDispatch(supabase, batchId, inspections);
    await trackChatGptOperation(supabase, operationId, [dispatch.id]);
    operationTracked = true;
    const hint = String(dispatch.state) === "queued" ? dispatchHint(dispatch) : null;

    const currentInspections = await Promise.all(inspections.map(async (inspection) =>
      (await readInspection(supabase, inspection.id, user.id)) || inspection));
    const items = currentInspections.map((inspection) => ({
      inspection: publicInspection(inspection),
      dispatch,
    }));
    const first = items[0] as Record<string, any>;
    const responseBody = {
      ok: true,
      batchId,
      duplicateCount: submitted.length - sourceUrls.length,
      execution: "chatgpt_browser_bridge",
      items,
      bridge_hints: hint ? [hint] : [],
      // Keep the existing single-import response fields for older pages/links.
      requestId: first?.inspection?.id,
      inspection: first?.inspection,
      dispatch: first?.dispatch,
      bridge_hint: hint,
    };
    return NextResponse.json(responseBody, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const errorObject = error && typeof error === "object" ? error as { message?: unknown } : null;
    const message = error instanceof Error ? error.message
      : typeof errorObject?.message === "string" ? errorObject.message
        : "Unable to queue the job listing URLs.";
    if (message === "AUTH_REQUIRED") return NextResponse.json({ ok: false, error: "Sign in with an active JobHuntAI Console membership before importing a live listing." }, { status: 401 });
    if (message === "LIVE_INSPECTION_REQUIRES_SUPABASE") return NextResponse.json({ ok: false, error: "Live ChatGPT URL inspection is available after the hosted Supabase connection is enabled." }, { status: 503 });
    if (batchPersistenceAttempted && recoveryBatchId) {
      return NextResponse.json({
        ok: false,
        batchId: recoveryBatchId,
        error: "The saved import's dispatch and delivery state could not be confirmed. Submit the same URLs again to recover this batch; its stable idempotency key will reuse the original dispatch if one exists. No replacement message will be created.",
        // Preserve actionable diagnostics for local development without
        // returning raw database errors from a production API response.
        diagnostic: process.env.NODE_ENV === "development" ? message.slice(0, 500) : undefined,
      }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
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
      if (inspection.batch_id) {
        const { data, error } = await supabase.from("job_url_inspection_requests").select(INSPECTION_SELECT)
          .eq("batch_id", inspection.batch_id).eq("user_id", user.id).order("batch_position", { ascending: true });
        if (error) throw error;
        const batchRows = (data || []) as Inspection[];
        inspections = batchRows.some((row) => row.id === inspection.id) ? batchRows : [inspection];
      } else {
        inspections = [inspection];
      }
    }

    const previousStatuses = new Map(inspections.map((inspection) => [inspection.id, inspection.status]));
    const reconciled = await reconcileInspections(supabase, inspections, user.id);
    const newlyCompleted = reconciled.some((inspection) => inspection.status === "completed" && Boolean(inspection.job_id)
      && previousStatuses.get(inspection.id) !== "completed");
    if (newlyCompleted) {
      await recordJobPoolSheetSyncInBackground(supabase, user.id);
    }
    const items = await Promise.all(reconciled.map(async (inspection) => ({
      inspection: publicInspection(inspection),
      dispatch: await dispatchSummary(supabase, inspection),
    })));
    if (!batchId) {
      const target = items.find((item) => item.inspection.id === requestId) || items[0];
      return NextResponse.json({ ok: true, inspection: target.inspection, dispatch: target.dispatch }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const counts = items.reduce((summary, item) => {
      summary[item.inspection.status] = (summary[item.inspection.status] || 0) + 1;
      return summary;
    }, {} as Record<string, number>);
    return NextResponse.json({ ok: true, batchId, items, counts }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to read the job listing inspections.");
  }
}
