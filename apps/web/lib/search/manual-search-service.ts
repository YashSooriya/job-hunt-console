import { createHash } from "node:crypto";
import { parseManualSearchResponse, type ManualSearchResult } from "@/lib/search/manual-search-response";
import { recordJobPoolSheetSyncInBackground } from "@/lib/google-job-pool-sheet";

type SearchRun = Record<string, any>;
type Dispatch = Record<string, any>;
type Inspection = {
  id: string;
  source_url: string;
  status: string;
  job_id: string | null;
  error_json?: Record<string, unknown> | null;
  batch_position: number | null;
  dispatch_request_id: string | null;
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stableInspectionId(runId: string, position: number) {
  const hex = createHash("sha256").update(`jobhunt-manual-search:${runId}:${position}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function dispatchState(dispatch: Dispatch) {
  return typeof dispatch.state === "string" ? dispatch.state : "unknown";
}

function waitingState(state: string) {
  return ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready", "sent", "acknowledged_by_mcp", "running"].includes(state);
}

async function finalizeRun(
  supabase: any,
  run: SearchRun,
  dispatch: Dispatch,
  state: string,
  response?: ReturnType<typeof parseManualSearchResponse>,
  errorMessage?: string,
) {
  const { data, error } = await supabase.rpc("finalize_job_search_run", {
    p_run_id: run.id,
    p_final_state: state,
    p_jobs_checked: response?.jobs_checked ?? 0,
    p_found_count: response?.results.filter((result) => result.status === "found").length ?? 0,
    p_unavailable_count: response?.results.filter((result) => result.status !== "found").length ?? 0,
    p_result_summary: response?.summary ?? null,
    p_error_message: errorMessage ?? null,
  });
  if (error) throw error;
  return {
    ...asRecord(data),
    dispatch_state: dispatchState(dispatch),
    dispatch_id: dispatch.id,
  };
}

async function readOwnedRun(supabase: any, userId: string, runId: string): Promise<SearchRun | null> {
  const { data, error } = await supabase.from("job_search_runs").select("*").eq("id", runId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function readDispatch(supabase: any, requestId: string): Promise<Dispatch | null> {
  const { data, error } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: requestId });
  if (error) throw error;
  const dispatch = asRecord(data);
  return dispatch.id ? dispatch : null;
}

async function readInspections(supabase: any, userId: string, runId: string): Promise<Inspection[]> {
  const { data, error } = await supabase.from("job_url_inspection_requests")
    .select("id,source_url,status,job_id,error_json,batch_position,dispatch_request_id")
    .eq("user_id", userId).eq("batch_id", runId).order("batch_position", { ascending: true });
  if (error) throw error;
  return (data || []) as Inspection[];
}

async function readRunPoolSnapshot(supabase: any, userId: string, runId: string) {
  const { data, error } = await supabase.from("job_search_run_pool_snapshots")
    .select("publication_id,source_revision,row_count,verification_token")
    .eq("run_id", runId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) return null; // Pre-mirror historical runs retain their legacy response contract.
  return {
    publicationId: String(data.publication_id),
    revision: Number(data.source_revision),
    rowCount: Number(data.row_count),
    verificationToken: String(data.verification_token),
  };
}

function inspectionRows(runId: string, dispatchId: string, userId: string, results: ManualSearchResult[]) {
  return results.filter((result) => result.source_url).map((result) => ({
    id: stableInspectionId(runId, result.position),
    user_id: userId,
    source_url: result.source_url!,
    batch_id: runId,
    batch_position: result.position,
    dispatch_request_id: dispatchId,
  }));
}

async function persistCapturedResults(supabase: any, userId: string, runId: string, dispatchId: string, results: ManualSearchResult[]) {
  const rowsToCreate = inspectionRows(runId, dispatchId, userId, results);
  if (rowsToCreate.length) {
    // Conflict-ignore makes repeated reconciliation safe: the exact captured
    // dispatch response is replayed into the same stable inspection IDs.
    const { error } = await supabase.from("job_url_inspection_requests")
      .upsert(rowsToCreate, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw error;
  }

  let inspections = await readInspections(supabase, userId, runId);
  const byPosition = new Map(inspections.map((inspection) => [inspection.batch_position, inspection]));
  const writeErrors: string[] = [];
  for (const result of results) {
    if (!result.source_url) continue;
    const inspection = byPosition.get(result.position);
    if (!inspection || inspection.dispatch_request_id !== dispatchId || inspection.source_url !== result.source_url) {
      writeErrors.push(`The saved result row ${result.position} did not match this search.`);
      continue;
    }
    if (inspection.status === "completed" || inspection.status === "failed" || inspection.status === "user_required") continue;
    try {
      if (result.status === "found" && result.extraction) {
        const { error } = await supabase.rpc("complete_job_url_inspection", {
          p_request_id: inspection.id,
          p_extraction: result.extraction,
          p_provider: "chatgpt_direct",
          p_provider_response_id: null,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc("mark_job_url_inspection_failed", {
          p_request_id: inspection.id,
          p_message: result.reason || "ChatGPT could not verify this vacancy.",
          p_user_required: false,
        });
        if (error) throw error;
      }
    } catch (error) {
      // Keep a found result queued/processing so the next status poll can retry
      // this authenticated persistence call from the captured response. Never
      // mark it terminal and never send the ChatGPT message a second time.
      writeErrors.push(error instanceof Error ? error.message : "A captured vacancy result could not be saved yet.");
    }
  }
  inspections = await readInspections(supabase, userId, runId);
  return { inspections, writeErrors };
}

export async function reconcileManualJobSearch(supabase: any, userId: string, runId: string) {
  const run = await readOwnedRun(supabase, userId, runId);
  if (!run) return { ok: false as const, status: 404, error: "Manual search not found." };
  const dispatchId = typeof run.dispatch_request_id === "string" ? run.dispatch_request_id : "";
  if (!dispatchId) return { ok: true as const, run: { ...run, state: run.state || "queued", error: "This older search was not linked to a Website Bridge result." } };

  const dispatch = await readDispatch(supabase, dispatchId);
  if (!dispatch) return { ok: false as const, status: 404, error: "The search's Website Bridge request was not found." };
  const state = dispatchState(dispatch);
  if (waitingState(state)) {
    return { ok: true as const, run: { ...run, state, dispatch_state: state, dispatch_id: dispatchId } };
  }
  if (state !== "completed") {
    const dispatchError = asRecord(dispatch.error);
    if (["failed", "user_required", "expired", "cancelled"].includes(state)) {
      try {
        const saved = await finalizeRun(
          supabase,
          run,
          dispatch,
          state,
          undefined,
          typeof dispatchError.message === "string" ? dispatchError.message : "The Website Bridge stopped before returning a search result.",
        );
        return { ok: true as const, run: saved };
      } catch (error) {
        return { ok: true as const, run: { ...run, state: "importing", dispatch_id: dispatchId, error_json: { message: error instanceof Error ? error.message : "The terminal search state could not be saved yet." } } };
      }
    }
    return {
      ok: true as const,
      run: {
        ...run,
        state,
        dispatch_state: state,
        dispatch_id: dispatchId,
        error_json: { message: typeof dispatchError.message === "string" ? dispatchError.message : "The Website Bridge stopped before returning a search result." },
      },
    };
  }

  const outputRefs = asRecord(dispatch.output_refs);
  if (outputRefs.response_provenance_recorded !== true || typeof dispatch.bridge_response !== "string") {
    const message = "ChatGPT completed without a verified exact-turn response. No vacancies were imported.";
    try {
      const saved = await finalizeRun(supabase, run, dispatch, "failed", undefined, message);
      return { ok: true as const, run: saved };
    } catch (error) {
      return { ok: true as const, run: { ...run, state: "importing", dispatch_state: state, dispatch_id: dispatchId, error_json: { message: error instanceof Error ? error.message : message } } };
    }
  }

  let response;
  try {
    const expectedPoolSnapshot = await readRunPoolSnapshot(supabase, userId, String(run.id));
    response = parseManualSearchResponse(dispatch.bridge_response, String(run.id), expectedPoolSnapshot || undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The captured search result was invalid.";
    try {
      const saved = await finalizeRun(supabase, run, dispatch, "failed", undefined, message);
      return { ok: true as const, run: saved };
    } catch (cause) {
      return { ok: true as const, run: { ...run, state: "importing", dispatch_state: state, dispatch_id: dispatchId, error_json: { message: cause instanceof Error ? cause.message : message } } };
    }
  }

  try {
    const { inspections, writeErrors } = await persistCapturedResults(supabase, userId, String(run.id), dispatchId, response.results);
    const foundResults = response.results.filter((result) => result.status === "found");
    const expectedWithUrl = foundResults.filter((result) => result.source_url);
    const byPosition = new Map(inspections.map((inspection) => [inspection.batch_position, inspection]));
    const pending = expectedWithUrl.some((result) => byPosition.get(result.position)?.status !== "completed");
    const importedJobIds = new Set(expectedWithUrl.map((result) => byPosition.get(result.position)?.job_id).filter((id): id is string => typeof id === "string"));
    const done = !pending && writeErrors.length === 0;
    if (done) {
      const saved = await finalizeRun(supabase, run, dispatch, "completed", response);
      await recordJobPoolSheetSyncInBackground(supabase, userId);
      return { ok: true as const, run: saved };
    }
    return { ok: true as const, run: {
      ...run,
      state: "importing",
      dispatch_state: state,
      dispatch_id: dispatchId,
      jobs_checked: response.jobs_checked,
      jobs_discovered: importedJobIds.size,
      summary: { ...(asRecord(run.summary)), result_summary: response.summary, found: foundResults.length, unavailable: response.results.filter((result) => result.status !== "found").length },
      error_json: { message: writeErrors[0] || "Captured search results are still being saved. This will retry without resending the ChatGPT message." },
    } };
  } catch (error) {
    return {
      ok: true as const,
      run: {
        ...run,
        state: "importing",
        dispatch_state: state,
        dispatch_id: dispatchId,
        jobs_checked: response.jobs_checked,
        summary: { ...(asRecord(run.summary)), result_summary: response.summary, found: response.results.filter((result) => result.status === "found").length },
        error_json: { message: error instanceof Error ? error.message : "Captured search results could not be saved yet. The original ChatGPT message was not resent." },
      },
    };
  }
}
