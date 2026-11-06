import { createHash, randomUUID } from "node:crypto";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";
import { createdMemoryFitDispatchMatches, exactMemoryFitDispatchMatches, memoryFitDispatchWasSafelyRequeued } from "./dispatch-contract.ts";
import { findRequestedCapturedRepair } from "./recovery.ts";
import { buildMemoryFitChunkPersistence } from "./worker.ts";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function rows(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.map(record) : [];
}
function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }

type LoadedMemoryFitBatch = Record<string, any> & {
  counts: { total: number; completed: number; assessed: number; insufficient_memory: number; needs_user: number; queued: number; running: number };
  chunks: Array<Record<string, any>>;
  items: Array<Record<string, any>>;
};

type AdvanceMemoryFitBatchResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      state: string;
      batch: LoadedMemoryFitBatch | null;
      dispatchId?: string | null;
      dispatch?: Record<string, any>;
      bridge_hint?: ReturnType<typeof dispatchHint>;
      started?: boolean;
      progressOwnedElsewhere?: boolean;
      captured_response_reprocessed?: boolean;
      captured_response_reprocess_error?: string;
    };

type DispatchQueuedChunkResult = Omit<Extract<AdvanceMemoryFitBatchResult, { ok: true }>, "batch">;

export function dispatchHint(dispatch: Record<string, any>) {
  return {
    version: 1,
    type: "JOBHUNT_DISPATCH_HINT",
    request_id: String(dispatch.id),
    correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : String(dispatch.id),
    nonce: crypto.randomUUID(),
  };
}

function batchSummary(batch: Record<string, any>, chunks: Record<string, any>[], items: Record<string, any>[]): LoadedMemoryFitBatch {
  const counts = {
    total: Number(batch.requested_count || 0),
    completed: items.filter((item) => ["assessed", "insufficient_memory", "listing_unavailable", "wrong_listing", "invalid_response", "missing_result", "needs_user"].includes(String(item.state))).length,
    assessed: items.filter((item) => item.state === "assessed").length,
    insufficient_memory: items.filter((item) => item.state === "insufficient_memory").length,
    needs_user: items.filter((item) => ["needs_user", "invalid_response", "missing_result"].includes(String(item.state))).length,
    queued: items.filter((item) => item.state === "queued").length,
    running: items.filter((item) => item.state === "saving" || chunks.some((chunk) => chunk.state === "waiting_for_bridge" && chunk.job_ids?.includes(item.job_id))).length,
  };
  return { ...batch, counts, chunks, items };
}

export async function loadMemoryFitBatch(supabase: any, userId: string, batchId: string): Promise<LoadedMemoryFitBatch | null> {
  const { data: batch, error: batchError } = await supabase.from("job_fit_memory_v4_batches").select("*").eq("id", batchId).eq("user_id", userId).maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return null;
  const [{ data: chunks, error: chunksError }, { data: items, error: itemsError }] = await Promise.all([
    supabase.from("job_fit_memory_v4_chunks").select("id,ordinal,job_ids,instruction,idempotency_key,state,dispatch_id,operation_id,captured_response,captured_response_hash,captured_response_at,error_message,updated_at").eq("batch_id", batchId).eq("user_id", userId).order("ordinal"),
    supabase.from("job_fit_memory_v4_items").select("id,chunk_id,job_id,listing_url,job_revision,state,result_json,analysis_id,error_message,updated_at").eq("batch_id", batchId).eq("user_id", userId),
  ]);
  if (chunksError) throw chunksError;
  if (itemsError) throw itemsError;
  const itemRows = rows(items).sort((a, b) => batch.requested_job_ids.indexOf(a.job_id) - batch.requested_job_ids.indexOf(b.job_id));
  return batchSummary(record(batch), rows(chunks), itemRows);
}

async function dispatchQueuedChunk(supabase: any, userId: string, batch: Record<string, any>, chunk: Record<string, any>): Promise<DispatchQueuedChunkResult> {
  const { data: existing, error: activeError } = await supabase.from("job_fit_memory_v4_chunks")
    .select("id,state,dispatch_id").eq("batch_id", batch.id).eq("user_id", userId).eq("state", "waiting_for_bridge").maybeSingle();
  if (activeError) throw activeError;
  if (existing) return { ok: true, state: "waiting_for_bridge", dispatchId: existing.dispatch_id, started: false };

  const operationId = await beginChatGptOperation(supabase, "Analyse jobs using ChatGPT Memory");
  let tracked = false;
  try {
    const { data, error } = await supabase.rpc("create_chatgpt_dispatch_request_with_website_instruction", {
      p_action_type: "jobs.analyse_selected",
      p_subject_refs: { job_ids: chunk.job_ids },
      p_origin: "user_click",
      p_display_title: `Analyse ${chunk.job_ids.length} job${chunk.job_ids.length === 1 ? "" : "s"} using ChatGPT Memory`,
      p_idempotency_key: chunk.idempotency_key,
      p_priority: 50,
      p_website_instruction: chunk.instruction,
    });
    if (error) throw error;
    const created = record(data);
    if (typeof created.id !== "string") throw new Error("The generic Website Bridge did not return a dispatch request ID.");
    const { data: persisted, error: readError } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: created.id });
    if (readError) throw readError;
    const dispatch = record(persisted);
    if (!createdMemoryFitDispatchMatches(created, dispatch, chunk)) {
      throw new Error("The generic Website Bridge dispatch did not match the saved Memory-fit group.");
    }
    const { data: attached, error: attachError } = await supabase.from("job_fit_memory_v4_chunks")
      .update({ state: "waiting_for_bridge", dispatch_id: dispatch.id, operation_id: operationId, error_message: null, updated_at: new Date().toISOString() })
      .eq("id", chunk.id).eq("user_id", userId).eq("state", "queued").select("id").maybeSingle();
    if (attachError) throw attachError;
    if (!attached) {
      const { data: current, error: currentError } = await supabase.from("job_fit_memory_v4_chunks").select("state,dispatch_id").eq("id", chunk.id).eq("user_id", userId).single();
      if (currentError) throw currentError;
      if (current.state !== "waiting_for_bridge" || current.dispatch_id !== dispatch.id) throw new Error("This Memory-fit group was concurrently advanced; its saved dispatch was not replaced.");
    }
    await trackChatGptOperation(supabase, operationId, [dispatch.id]);
    tracked = true;
    await supabase.from("job_fit_memory_v4_batches").update({ state: "processing", updated_at: new Date().toISOString() }).eq("id", batch.id).eq("user_id", userId);
    return { ok: true, state: "waiting_for_bridge", dispatchId: dispatch.id, dispatch, bridge_hint: dispatchHint(dispatch), started: true };
  } finally {
    if (!tracked) {
      try { await releaseChatGptOperation(supabase, operationId); } catch { /* A saved dispatch remains recoverable by its idempotency key. */ }
    }
  }
}

async function saveCapturedChunk(supabase: any, userId: string, batch: Record<string, any>, chunk: Record<string, any>, items: Record<string, any>[]) {
  const preferencesResult = await supabase.from("candidate_profiles").select("id").eq("user_id", userId).maybeSingle();
  if (preferencesResult.error) throw preferencesResult.error;
  const preferenceResult = preferencesResult.data?.id
    ? await supabase.from("candidate_preferences").select("preferences").eq("profile_id", preferencesResult.data.id).maybeSingle()
    : { data: null, error: null };
  if (preferenceResult.error) throw preferenceResult.error;
  const jobIds = items.map((item) => item.job_id);
  const jobResult = await supabase.from("jobs").select("id,title,industry,source_url,application_url,analysis_revision,current_snapshot_id,location_text,work_mode,employment_type,salary_min,salary_max,salary_currency,salary_text,posted_at,closes_at,ats_provider,discovery_source").eq("user_id", userId).in("id", jobIds);
  if (jobResult.error) throw jobResult.error;
  const jobs = rows(jobResult.data);
  const snapshotIds = jobs.map((job) => job.current_snapshot_id).filter((id) => typeof id === "string");
  const snapshotResult = snapshotIds.length
    ? await supabase.from("job_snapshots").select("id,description_text,company_name,raw_metadata").in("id", snapshotIds)
    : { data: [], error: null };
  if (snapshotResult.error) throw snapshotResult.error;
  const snapshots = new Map(rows(snapshotResult.data).map((snapshot) => [snapshot.id, snapshot]));
  const contextRows = items.map((item) => {
    const job = jobs.find((row) => row.id === item.job_id);
    return { item, job, snapshot: job ? snapshots.get(job.current_snapshot_id) || {} : {} };
  });
  const prepared = buildMemoryFitChunkPersistence({
    batch, chunk, items, preferences: record(preferenceResult.data?.preferences), contextRows,
  });
  const { data: saved, error: saveError } = await supabase.rpc("save_job_fit_memory_v4_chunk_results", { p_chunk_id: chunk.id, p_results: prepared.results });
  if (saveError) throw saveError;
  return { saved: true, malformedEnvelope: prepared.malformedEnvelope, ...(prepared.error ? { error: prepared.error } : {}), result: record(saved) };
}

async function getDispatch(supabase: any, dispatchId: string) {
  const { data, error } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: dispatchId });
  if (error) throw error;
  return record(data);
}

async function releaseOperation(supabase: any, operationId: unknown) {
  if (typeof operationId !== "string" || !operationId) return;
  try { await releaseChatGptOperation(supabase, operationId); } catch { /* The durable chunk state remains authoritative and another refresh can retry. */ }
}

async function advanceMemoryFitBatchUnderLease(
  supabase: any,
  userId: string,
  batchId: string,
  options: { reprocessCapturedChunkId?: string } = {},
): Promise<AdvanceMemoryFitBatchResult> {
  let current = await loadMemoryFitBatch(supabase, userId, batchId);
  if (!current) return { ok: false, status: 404, error: "Memory-based analysis batch not found." };
  const reload = async (): Promise<LoadedMemoryFitBatch> => {
    const fresh = await loadMemoryFitBatch(supabase, userId, batchId);
    if (!fresh) throw new Error("The Memory-based analysis batch disappeared while it was advancing.");
    return fresh;
  };

  // The generic Bridge retry endpoint is the only way to repeat a delivery,
  // and its database RPC only requeues a server-confirmed pre-Send V2 failure.
  // Reattach that exact row here if the page closed between the retry and this
  // progress wake; never infer a retry from a label or user-provided status.
  const { data: retryCandidate, error: retryCandidateError } = await supabase.from("job_fit_memory_v4_chunks").select("*")
    .eq("batch_id", batchId).eq("user_id", userId).eq("state", "needs_user").order("ordinal").limit(1).maybeSingle();
  if (retryCandidateError) throw retryCandidateError;
  if (retryCandidate?.dispatch_id) {
    const retriedDispatch = await getDispatch(supabase, String(retryCandidate.dispatch_id));
    if (memoryFitDispatchWasSafelyRequeued(retriedDispatch, record(retryCandidate))) {
      const { data: reattached, error: reattachError } = await supabase.from("job_fit_memory_v4_chunks")
        .update({ state: "waiting_for_bridge", operation_id: null, error_message: null, updated_at: new Date().toISOString() })
        .eq("id", retryCandidate.id).eq("user_id", userId).eq("state", "needs_user").select("id").maybeSingle();
      if (reattachError) throw reattachError;
      if (reattached) {
        const { error: resetItemsError } = await supabase.from("job_fit_memory_v4_items")
          .update({ state: "queued", error_message: null, updated_at: new Date().toISOString() })
          .eq("chunk_id", retryCandidate.id).eq("user_id", userId).eq("state", "needs_user");
        if (resetItemsError) throw resetItemsError;
        await supabase.from("job_fit_memory_v4_batches").update({ state: "processing", updated_at: new Date().toISOString() }).eq("id", batchId).eq("user_id", userId);
        current = await reload();
      }
    }
  }

  const { data: active, error: activeError } = await supabase.from("job_fit_memory_v4_chunks").select("*")
    .eq("batch_id", batchId).eq("user_id", userId).eq("state", "waiting_for_bridge").maybeSingle();
  if (activeError) throw activeError;

  if (active) {
    const dispatch = await getDispatch(supabase, String(active.dispatch_id));
    if (!exactMemoryFitDispatchMatches(dispatch, active)) {
      const reason = "The saved Website Bridge dispatch did not match this exact Memory-only message. No replacement message was sent.";
      const { error: itemsError } = await supabase.from("job_fit_memory_v4_items").update({ state: "needs_user", error_message: reason, updated_at: new Date().toISOString() }).eq("chunk_id", active.id).eq("user_id", userId);
      if (itemsError) throw itemsError;
      const { error: chunkError } = await supabase.from("job_fit_memory_v4_chunks").update({ state: "needs_user", error_message: reason, updated_at: new Date().toISOString() }).eq("id", active.id).eq("user_id", userId);
      if (chunkError) throw chunkError;
      await releaseOperation(supabase, active.operation_id);
      current = await reload();
      const hasRemainingWork = current.chunks.some((chunk) => chunk.id !== active.id && ["queued", "waiting_for_bridge", "saving"].includes(String(chunk.state)));
      await supabase.from("job_fit_memory_v4_batches").update({ state: hasRemainingWork ? "processing" : "partial", updated_at: new Date().toISOString() }).eq("id", batchId).eq("user_id", userId);
      current = await reload();
    }
    else if (dispatch.state === "completed") {
      try {
        const { error } = await supabase.rpc("capture_job_fit_memory_v4_chunk", { p_chunk_id: active.id, p_dispatch_id: active.dispatch_id });
        if (error) throw error;
        const { data: capturedChunk, error: captureReadError } = await supabase.from("job_fit_memory_v4_chunks").select("*").eq("id", active.id).eq("user_id", userId).single();
        if (captureReadError) throw captureReadError;
        const { data: items, error: itemsError } = await supabase.from("job_fit_memory_v4_items").select("*").eq("chunk_id", active.id).eq("user_id", userId);
        if (itemsError) throw itemsError;
        await saveCapturedChunk(supabase, userId, current, record(capturedChunk), rows(items).sort((a, b) => active.job_ids.indexOf(a.job_id) - active.job_ids.indexOf(b.job_id)));
        current = await reload();
      } finally {
        // The Bridge turn is finished even if the local capture or database
        // save fails. Never leave the site-wide ChatGPT action lock active
        // while recovering an already-completed response.
        await releaseOperation(supabase, active.operation_id);
      }
    } else if (["failed", "expired", "cancelled", "user_required"].includes(String(dispatch.state))) {
      const reason = record(dispatch.error).message || "ChatGPT could not finish this saved request. Start a new analysis to send a new request; this one will not be resent.";
      const safeReason = String(reason).slice(0, 1000);
      const { error: itemsError } = await supabase.from("job_fit_memory_v4_items").update({ state: "needs_user", error_message: safeReason, updated_at: new Date().toISOString() }).eq("chunk_id", active.id).eq("user_id", userId);
      if (itemsError) throw itemsError;
      const { error: chunkError } = await supabase.from("job_fit_memory_v4_chunks").update({ state: "needs_user", error_message: safeReason, updated_at: new Date().toISOString() }).eq("id", active.id).eq("user_id", userId);
      if (chunkError) throw chunkError;
      await releaseOperation(supabase, active.operation_id);
      current = await reload();
      const hasRemainingWork = current.chunks.some((chunk) => chunk.id !== active.id && ["queued", "waiting_for_bridge", "saving"].includes(String(chunk.state)));
      await supabase.from("job_fit_memory_v4_batches").update({ state: hasRemainingWork ? "processing" : "partial", updated_at: new Date().toISOString() }).eq("id", batchId).eq("user_id", userId);
      current = await reload();
    } else {
      return { ok: true, state: "waiting_for_bridge", dispatch, batch: current };
    }
  }

  // A validated assistant turn is immutable and already saved locally. Allow
  // the exact captured response to be reparsed/recommitted after a parser or
  // transient result-save repair, without creating or sending a new dispatch.
  const batchBeforeCapturedRepair = current;
  const requestedCapturedRepairId = options.reprocessCapturedChunkId;
  const capturedRepair = findRequestedCapturedRepair(batchBeforeCapturedRepair.chunks, batchBeforeCapturedRepair.items, requestedCapturedRepairId);
  if (requestedCapturedRepairId && !capturedRepair) {
    throw new Error("That saved response is not eligible for local reprocessing. No ChatGPT message was sent.");
  }
  if (capturedRepair) {
    if (sha256(String(capturedRepair.captured_response)) !== capturedRepair.captured_response_hash) {
      throw new Error("The saved captured response hash does not match. No new ChatGPT message was sent.");
    }
    const { data: certified, error: certifyError } = await supabase.rpc("capture_job_fit_memory_v4_chunk", {
      p_chunk_id: capturedRepair.id, p_dispatch_id: capturedRepair.dispatch_id,
    });
    if (certifyError) throw certifyError;
    if (!certified || typeof certified !== "object" || (certified as Record<string, unknown>).idempotent !== true) {
      throw new Error("The saved assistant response was not confirmed as the exact captured turn. No new ChatGPT message was sent.");
    }
    const captureItems = batchBeforeCapturedRepair.items.filter((item) => item.chunk_id === capturedRepair.id);
    let repairOutcome: Awaited<ReturnType<typeof saveCapturedChunk>>;
    try {
      repairOutcome = await saveCapturedChunk(supabase, userId, batchBeforeCapturedRepair, capturedRepair,
        captureItems.sort((a, b) => capturedRepair.job_ids.indexOf(a.job_id) - capturedRepair.job_ids.indexOf(b.job_id)));
    } finally { await releaseOperation(supabase, capturedRepair.operation_id); }
    current = await reload();
    return {
      ok: true,
      state: current.state,
      batch: current,
      captured_response_reprocessed: !repairOutcome.malformedEnvelope,
      ...(repairOutcome.error ? { captured_response_reprocess_error: repairOutcome.error } : {}),
    };
  }

  const { data: savingChunk, error: savingError } = await supabase.from("job_fit_memory_v4_chunks").select("*")
    .eq("batch_id", batchId).eq("user_id", userId).eq("state", "saving").order("ordinal").limit(1).maybeSingle();
  if (savingError) throw savingError;
  if (savingChunk) {
    const { data: items, error: itemsError } = await supabase.from("job_fit_memory_v4_items").select("*").eq("chunk_id", savingChunk.id).eq("user_id", userId);
    if (itemsError) throw itemsError;
    await saveCapturedChunk(supabase, userId, current, record(savingChunk), rows(items).sort((a, b) => savingChunk.job_ids.indexOf(a.job_id) - savingChunk.job_ids.indexOf(b.job_id)));
    current = await reload();
  }

  const { data: nextChunk, error: nextError } = await supabase.from("job_fit_memory_v4_chunks").select("*")
    .eq("batch_id", batchId).eq("user_id", userId).eq("state", "queued").order("ordinal").limit(1).maybeSingle();
  if (nextError) throw nextError;
  if (nextChunk) {
    const started = await dispatchQueuedChunk(supabase, userId, current, record(nextChunk));
    return { ...started, batch: await loadMemoryFitBatch(supabase, userId, batchId) };
  }
  return { ok: true, state: current.state, batch: current };
}

/** Serialize foreground progress with the minute worker on the same DB lease. */
export async function advanceMemoryFitBatch(
  supabase: any,
  userId: string,
  batchId: string,
  options: { reprocessCapturedChunkId?: string } = {},
): Promise<AdvanceMemoryFitBatchResult> {
  const leaseToken = randomUUID();
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase.from("job_fit_memory_v4_batches")
    .update({ advance_lease_token: leaseToken, advance_lease_expires_at: new Date(Date.now() + 90_000).toISOString() })
    .eq("id", batchId).eq("user_id", userId).in("state", ["queued", "processing", "partial"])
    .or(`advance_lease_token.is.null,advance_lease_expires_at.lte.${now}`)
    .select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) {
    const batch = await loadMemoryFitBatch(supabase, userId, batchId);
    if (!batch) return { ok: false, status: 404, error: "Memory-based analysis batch not found." };
    return { ok: true, state: batch.state, batch, progressOwnedElsewhere: true };
  }
  try {
    return await advanceMemoryFitBatchUnderLease(supabase, userId, batchId, options);
  } finally {
    await supabase.from("job_fit_memory_v4_batches").update({ advance_lease_token: null, advance_lease_expires_at: null })
      .eq("id", batchId).eq("user_id", userId).eq("advance_lease_token", leaseToken);
  }
}
