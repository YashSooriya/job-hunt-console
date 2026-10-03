import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { buildManualJobSearchPrompt } from "@/lib/search/job-search-prompt";
import { applyChatGptTestingMode, chatGptInstructionBodyLimit, readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { reconcileManualJobSearch } from "@/lib/search/manual-search-service";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";
import { currentJobPoolSheetSnapshot, releaseJobPoolSheetLease, syncJobPoolSheetForCurrentUser } from "@/lib/google-job-pool-sheet";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function availability(control: Record<string, any> | null) {
  const now = Date.now();
  const last = typeof control?.last_manual_search_at === "string" ? Date.parse(control.last_manual_search_at) : NaN;
  const disabled = control?.manual_search_cooldown_disabled === true;
  const next = !disabled && Number.isFinite(last) ? last + 60 * 60 * 1000 : null;
  const remainingSeconds = next === null ? 0 : Math.max(0, Math.ceil((next - now) / 1000));
  return {
    serverNow: new Date(now).toISOString(),
    allowed: disabled || !Number.isFinite(last) || remainingSeconds <= 0,
    cooldownDisabled: disabled,
    lastTriggeredAt: Number.isFinite(last) ? new Date(last).toISOString() : null,
    nextAllowedAt: next === null ? null : new Date(next).toISOString(),
    remainingSeconds,
  };
}

export async function GET(request: Request) {
  try {
    const runId = new URL(request.url).searchParams.get("runId");
    const { supabase, profile } = await requireProfile();
    if (runId !== null) {
      if (!UUID_RE.test(runId)) return NextResponse.json({ ok: false, error: "A valid search run id is required." }, { status: 400 });
      const result = await reconcileManualJobSearch(supabase, profile.user_id, runId);
      return NextResponse.json(result, { status: result.ok ? 200 : result.status, headers: { "Cache-Control": "private, no-store" } });
    }
    const { data, error } = await supabase.from("job_search_controls").select("last_manual_search_at,manual_search_cooldown_disabled").eq("user_id", profile.user_id).maybeSingle();
    if (error) throw error;
    return NextResponse.json({ ok: true, availability: availability(record(data)) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to read manual-search availability." }, { status: statusCode(error) });
  }
}

export async function POST(request: Request) {
  let operationId: string | null = null;
  let operationClient: any = null;
  let operationTracked = false;
  let sheetLeaseId: string | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    const { supabase, profile } = await requireProfile();
    operationClient = supabase;
    const runId = typeof body?.runId === "string" ? body.runId : "";
    if (!UUID_RE.test(runId)) return NextResponse.json({ ok: false, error: "A valid search run id is required." }, { status: 400 });

    // A retried browser POST is recovery for the same durable run, never a new
    // ChatGPT message. Return the existing dispatch and only re-emit a hint if
    // it has not crossed the queued-to-extension boundary.
    const { data: existingRun, error: existingRunError } = await supabase.from("job_search_runs")
      .select("id,dispatch_request_id,state")
      .eq("id", runId).eq("user_id", profile.user_id).maybeSingle();
    if (existingRunError) throw existingRunError;
    if (existingRun) {
      const requestId = typeof existingRun.dispatch_request_id === "string" ? existingRun.dispatch_request_id : "";
      if (!requestId) return NextResponse.json({ ok: false, error: "This search attempt is already recorded without a Website Bridge dispatch. It will not be resent; start a new search." }, { status: 409 });
      const { data: existingDispatch, error: dispatchError } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: requestId });
      if (dispatchError) throw dispatchError;
      const dispatch = record(existingDispatch);
      if (typeof dispatch.id !== "string") return NextResponse.json({ ok: false, error: "The saved search dispatch could not be recovered." }, { status: 409 });
      return NextResponse.json({
        ok: true,
        existing: true,
        runId,
        dispatch,
        ...(dispatch.state === "queued" ? { bridge_hint: {
          version: 1,
          type: "JOBHUNT_DISPATCH_HINT",
          request_id: requestId,
          correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : requestId,
          nonce: crypto.randomUUID(),
        } } : {}),
      }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
    }

    operationId = await beginChatGptOperation(supabase, "Manual job search");
    const publication = await syncJobPoolSheetForCurrentUser(supabase, profile.user_id, { holdLease: true });
    sheetLeaseId = publication.leaseId;
    const snapshot = await currentJobPoolSheetSnapshot(supabase, profile.user_id);
    if (snapshot.publicationId !== publication.publicationId) throw new Error("job_pool_changed_during_sync");
    const [preferencesResult, sourcesResult] = await Promise.all([
      supabase.from("candidate_preferences").select("preferences").eq("profile_id", profile.id).maybeSingle(),
      supabase.from("job_search_sources").select("source_key,label").eq("user_id", profile.user_id).eq("enabled", true).order("source_key"),
    ]);
    if (preferencesResult.error) throw preferencesResult.error;
    if (sourcesResult.error) throw sourcesResult.error;
    const sources = (sourcesResult.data || []) as Array<Record<string, unknown>>;
    if (!sources.length) throw new Error("Enable at least one discovery source in Search settings before starting a search.");
    const idempotencyKey = `jobs.search.manual:${runId}`;
    const testingModeEnabled = await readChatGptTestingMode(supabase, profile.user_id);
    const instruction = applyChatGptTestingMode(
      buildManualJobSearchPrompt(
        record(preferencesResult.data?.preferences),
        runId,
        chatGptInstructionBodyLimit(testingModeEnabled),
        sources.map((source) => String(source.label || "")).filter(Boolean),
        {
          publicationId: snapshot.publicationId,
          revision: snapshot.revision,
          rowCount: snapshot.rowCount,
          dataUrl: snapshot.dataUrl,
          dataSheetTitle: snapshot.dataSheetTitle,
          manifestUrl: snapshot.manifestUrl,
          manifestSheetTitle: snapshot.manifestSheetTitle,
        },
      ),
      testingModeEnabled,
    );
    const { data, error } = await supabase.rpc("create_manual_job_search_dispatch_with_pool_snapshot", {
      p_run_id: runId,
      p_idempotency_key: idempotencyKey,
      p_website_instruction: instruction,
      p_source_keys: sources.map((source) => String(source.source_key || "")).filter(Boolean),
      p_publication_id: snapshot.publicationId,
      p_lease_id: publication.leaseId,
    });
    if (error) throw error;
    const result = record(data);
    if (result.ok !== true && result.reason === "manual_search_cooldown") {
      return NextResponse.json({ ok: false, error: "Manual job search is limited to once per hour.", availability: {
        serverNow: result.server_now,
        allowed: false,
        cooldownDisabled: false,
        lastTriggeredAt: result.last_triggered_at,
        nextAllowedAt: result.next_allowed_at,
        remainingSeconds: result.remaining_seconds,
      } }, { status: 429, headers: { "Retry-After": String(result.remaining_seconds || 3600), "Cache-Control": "private, no-store" } });
    }
    if (result.ok !== true && result.reason === "active_search") {
      return NextResponse.json({
        ok: false,
        reason: "active_search",
        activeRunId: result.active_run_id,
        activeDispatchId: result.active_dispatch_id,
        error: "A search is already in progress. Its existing result is being tracked; no duplicate message was sent.",
      }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    }
    if (result.ok !== true || !result.dispatch || typeof result.dispatch !== "object") throw new Error("The manual search was not queued.");
    const dispatch = result.dispatch as Record<string, unknown>;
    const requestId = typeof dispatch.id === "string" ? dispatch.id : "";
    if (!requestId) throw new Error("The manual search did not return a dispatch id.");
    await trackChatGptOperation(supabase, operationId, [requestId]);
    operationTracked = true;
    return NextResponse.json({
      ok: true,
      runId: typeof result.run_id === "string" ? result.run_id : runId,
      dispatch,
      availability: availability({ last_manual_search_at: result.server_now, manual_search_cooldown_disabled: result.cooldown_disabled === true }),
      bridge_hint: {
        version: 1,
        type: "JOBHUNT_DISPATCH_HINT",
        request_id: requestId,
        correlation_id: typeof dispatch.correlation_id === "string" ? dispatch.correlation_id : requestId,
        nonce: crypto.randomUUID(),
      },
    }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to queue a manual job search." }, { status: statusCode(error) });
  } finally {
    if (operationClient && sheetLeaseId) {
      try { await releaseJobPoolSheetLease(operationClient, sheetLeaseId); } catch { /* the database lease expires after ten minutes */ }
    }
    if (operationId && !operationTracked) {
      try { await releaseChatGptOperation(operationClient, operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}
