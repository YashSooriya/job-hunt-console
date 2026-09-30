import { NextResponse } from "next/server";
import { importCandidateSource } from "@/lib/onboarding/import-source";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { CHATGPT_TESTING_MODE_PREFIX, prepareChatGptInstruction, readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { readVerifiedProfessionalBackground } from "@/lib/chatgpt/verified-professional-background";
import {
  PROFESSIONAL_BACKGROUND_SUMMARY_KEY_PREFIX,
  queueProfessionalBackgroundImport,
  queueProfessionalBackgroundInstructions,
} from "@/lib/chatgpt/professional-background-dispatch";
import {
  memoryConflictText,
  memoryQuestionText,
  parseStructuredMemoryInterview,
} from "@/lib/chatgpt/memory-profile";
import { bridgeReadinessError, bridgeReadyForDispatch, readBridgeReadiness, type BridgeReadiness } from "@/lib/chatgpt-bridge/readiness";
import { diffSnapshots, snapshotFromInput, type ProfileSnapshot } from "@/lib/chatgpt/profile-snapshot";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";

type MemorySettings = Record<string, any> | null;

type MemoryUpdateInfo = {
  retryAllowed: boolean;
  manualReviewRequired: boolean;
};

const MEMORY_IMPORT_MAX_TEXT_CHARS = 36000;
const MEMORY_IMPORT_PROPOSAL_LIMIT = 48;
const MEMORY_IMPORT_RETRY_AFTER_MS = 2 * 60 * 1000;
const MEMORY_UPDATE_ACTIVE_STATES = new Set(["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready", "send_attempted", "sent", "acknowledged_by_mcp", "running"]);
const MEMORY_UPDATE_TERMINAL_STATES = new Set(["completed", "failed", "user_required", "expired", "cancelled"]);

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return String((error as { message: string }).message);
  }
  return fallback;
}

function memoryResponse(
  settings: MemorySettings,
  bridge: BridgeReadiness | null = null,
  responseCheckAvailable = false,
  manualReviewRequired = false,
  updateInfo: MemoryUpdateInfo = { retryAllowed: false, manualReviewRequired: false },
) {
  const confirmed = Boolean(settings?.memory_enabled_user_confirmed) && settings?.use_previous_knowledge !== false;
  const decision = settings?.consent_status || (confirmed ? "allowed" : "undecided");
  return {
    confirmed,
    decision,
    status: confirmed ? "user_confirmed" : decision === "declined" ? "user_declined" : "unknown",
    usePreviousKnowledge: settings?.use_previous_knowledge !== false,
    memorySyncEnabled: Boolean(settings?.memory_sync_enabled) && confirmed,
    reminderRequired: decision === "undecided",
    confirmedAt: settings?.memory_confirmed_at || null,
    importStatus: settings?.memory_import_status || "not_requested",
    importDispatchId: settings?.memory_import_dispatch_id || null,
    importRequestedAt: settings?.memory_import_requested_at || null,
    importCompletedAt: settings?.memory_import_completed_at || null,
    importError: settings?.memory_import_error || null,
    updateStatus: settings?.memory_update_status || "not_requested",
    updateDispatchIds: Array.isArray(settings?.memory_update_dispatch_ids)
      ? settings.memory_update_dispatch_ids.filter((id: unknown): id is string => typeof id === "string")
      : [],
    updateRequestedAt: settings?.memory_update_requested_at || null,
    updateCompletedAt: settings?.memory_update_completed_at || null,
    updateError: settings?.memory_update_error || null,
    updateFingerprint: settings?.memory_update_fingerprint || null,
    updateRetryAllowed: updateInfo.retryAllowed,
    updateManualReviewRequired: updateInfo.manualReviewRequired,
    responseCheckAvailable,
    manualReviewRequired,
    importQuestions: Array.isArray(settings?.memory_import_questions)
      ? settings.memory_import_questions.filter((question: unknown): question is string => typeof question === "string").slice(0, 80)
      : [],
    bridge,
  };
}

function extractQuestions(response: string) {
  return [...new Set(response
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
    .filter((line) => line.length > 0 && line.includes("?") && line.length <= 800))].slice(0, 80);
}

async function readSettings(supabase: any, profileId: string) {
  const { data, error } = await supabase
    .from("candidate_chatgpt_memory")
    .select("*")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (error) throw error;
  return data as MemorySettings;
}

async function updateSettings(supabase: any, profileId: string, values: Record<string, unknown>) {
  const { data, error } = await supabase
    .from("candidate_chatgpt_memory")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("profile_id", profileId)
    .select("*")
    .single();
  if (error) throw error;
  return data as MemorySettings;
}

async function readDispatch(supabase: any, dispatchId: string) {
  const { data, error } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: dispatchId });
  if (error) throw error;
  return data as Record<string, any>;
}

function canCheckCompletedResponse(dispatch: Record<string, any> | null | undefined) {
  // The database owns response-check eligibility because it has the durable
  // send boundary and exact-turn anchor. The webapp must not infer that an
  // ambiguous legacy request can be inspected safely from state names alone.
  return dispatch?.response_check_available === true
    && dispatch?.has_delivery_turn_anchor === true;
}

function hasResponseProvenance(dispatch: Record<string, any> | null | undefined) {
  const outputRefs = dispatch?.output_refs && typeof dispatch.output_refs === "object" && !Array.isArray(dispatch.output_refs)
    ? dispatch.output_refs as Record<string, unknown>
    : {};
  return outputRefs.response_provenance_recorded === true;
}

function isCurrentSourceFirstSummary(dispatch: Record<string, any> | null | undefined) {
  const key = typeof dispatch?.idempotency_key === "string" ? dispatch.idempotency_key : "";
  return key.startsWith(`${PROFESSIONAL_BACKGROUND_SUMMARY_KEY_PREFIX}:`);
}

function bridgeHintForDispatch(dispatch: Record<string, any> | null | undefined) {
  const requestId = typeof dispatch?.id === "string" ? dispatch.id : "";
  if (!requestId) return undefined;
  return {
    version: 1,
    type: "JOBHUNT_DISPATCH_HINT",
    request_id: requestId,
    correlation_id: typeof dispatch?.correlation_id === "string" ? dispatch.correlation_id : requestId,
    nonce: crypto.randomUUID(),
  };
}

async function finaliseMemoryImport(supabase: any, user: { id: string }, profile: { id: string; display_name: string }, settings: MemorySettings) {
  const dispatchId = typeof settings?.memory_import_dispatch_id === "string" ? settings.memory_import_dispatch_id : "";
  if (!dispatchId || ["completed", "failed", "user_required"].includes(String(settings?.memory_import_status || ""))) return settings;

  const dispatch = await readDispatch(supabase, dispatchId);
  const dispatchState = String(dispatch.state || "");
  if (dispatchState === "completed") {
    // A Worker can be terminated while the profile import is being written. Do
    // not start the same expensive import on every 2.5 second browser poll;
    // allow a bounded recovery retry if the previous attempt really stalled.
    if (String(settings?.memory_import_status || "") === "in_progress") {
      const lastAttempt = Date.parse(String(settings?.memory_import_requested_at || ""));
      if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < MEMORY_IMPORT_RETRY_AFTER_MS) return settings;
    }
    const response = typeof dispatch.bridge_response === "string" ? dispatch.bridge_response.trim() : "";
    if (!response) {
      return updateSettings(supabase, profile.id, {
        memory_import_status: "failed",
        memory_import_error: "ChatGPT completed the request without returning a professional-background summary.",
      });
    }

    // A completed row from the pre-provenance bridge may contain an older
    // assistant JSON artifact. Never import it after a reset or retry: only a
    // v3 completion that carried the exact sent user-turn identity is eligible
    // for structured profile population.
    if (!hasResponseProvenance(dispatch)) {
      return updateSettings(supabase, profile.id, {
        memory_import_status: "user_required",
        memory_import_error: "The completed ChatGPT response could not be tied to the exact latest turn. Review the Professional background conversation and retry with the latest Website Bridge.",
      });
    }

    await updateSettings(supabase, profile.id, {
      memory_import_status: "in_progress",
      memory_import_requested_at: new Date().toISOString(),
      memory_import_error: null,
    });
    try {
      const boundedResponse = response.length > MEMORY_IMPORT_MAX_TEXT_CHARS
        ? `${response.slice(0, MEMORY_IMPORT_MAX_TEXT_CHARS)}\n\n[The structured response exceeded the safe import size. Review the missing details in ChatGPT and add them below.]`
        : response;
      const structured = parseStructuredMemoryInterview(boundedResponse);
      const source = await importCandidateSource({
        supabase,
        user,
        profile,
        text: boundedResponse,
        title: "ChatGPT Memory structured onboarding profile",
        sourceType: "chatgpt_memory",
        maxTextChars: MEMORY_IMPORT_MAX_TEXT_CHARS,
        proposalLimit: MEMORY_IMPORT_PROPOSAL_LIMIT,
      });
      const importQuestions = structured
        ? [
          ...structured.questions.map(memoryQuestionText),
          ...structured.conflicts.map(memoryConflictText),
        ]
        : extractQuestions(response);
      const importedProfile = await readVerifiedProfessionalBackground(supabase, profile, {
        includeImported: true,
        allowMemoryUpdate: false,
      });
      return updateSettings(supabase, profile.id, {
        memory_import_status: "completed",
        memory_import_completed_at: new Date().toISOString(),
        memory_import_questions: importQuestions,
        memory_import_error: null,
        memory_update_snapshot: snapshotFromInput(importedProfile),
        memory_update_pending_snapshot: null,
        memory_update_pending_payload: null,
      });
    } catch (error) {
      return updateSettings(supabase, profile.id, {
        memory_import_status: "failed",
        memory_import_questions: extractQuestions(response),
        memory_import_error: errorMessage(error, "The ChatGPT summary could not be added to the profile."),
      });
    }
  }

  if (["failed", "expired", "cancelled"].includes(dispatchState)) {
    return updateSettings(supabase, profile.id, {
      memory_import_status: "failed",
      memory_import_error: typeof dispatch.error?.message === "string" ? dispatch.error.message : "The ChatGPT Memory summary request did not complete.",
    });
  }
  if (dispatchState === "user_required") {
    return updateSettings(supabase, profile.id, {
      memory_import_status: "user_required",
      memory_import_error: typeof dispatch.error?.message === "string" ? dispatch.error.message : "ChatGPT needs your attention before the summary can be imported.",
    });
  }
  // Keep the memory state as queued until ChatGPT has actually returned its
  // summary. This prevents a transient bridge state from being mistaken for a
  // completed import and lets the client keep polling safely.
  return settings;
}

function dispatchHasSendBoundary(dispatch: Record<string, any>) {
  return Boolean(
    dispatch.send_attempted_at
      || dispatch.sent_at
      || dispatch.sent_confirmed_at
      || dispatch.delivery_turn_anchor
      || dispatch.has_delivery_turn_anchor === true,
  );
}

function dispatchRetryAllowed(dispatch: Record<string, any>) {
  return dispatch.retry_allowed === true && !dispatchHasSendBoundary(dispatch);
}

function memoryUpdateInfo(dispatches: Record<string, any>[]): MemoryUpdateInfo {
  return {
    retryAllowed: dispatches.some((dispatch) => dispatchRetryAllowed(dispatch)),
    manualReviewRequired: dispatches.some((dispatch) => {
      const state = String(dispatch.state || "");
      return state !== "completed"
        && MEMORY_UPDATE_TERMINAL_STATES.has(state)
        && (dispatch.manual_review_required === true || dispatchHasSendBoundary(dispatch));
    }),
  };
}

async function finaliseMemoryUpdate(supabase: any, profile: { id: string }, settings: MemorySettings) {
  const ids = Array.isArray(settings?.memory_update_dispatch_ids)
    ? settings.memory_update_dispatch_ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (!ids.length) return { settings, dispatches: [] as Record<string, any>[], info: { retryAllowed: false, manualReviewRequired: false } };

  const dispatches = await Promise.all(ids.map((id) => readDispatch(supabase, id)));
  const states = dispatches.map((dispatch) => String(dispatch.state || ""));
  const allCompleted = states.length > 0 && states.every((state) => state === "completed");
  const hasActive = states.some((state) => MEMORY_UPDATE_ACTIVE_STATES.has(state));
  const info = memoryUpdateInfo(dispatches);
  const hasUnsafeTerminal = dispatches.some((dispatch) => (
    MEMORY_UPDATE_TERMINAL_STATES.has(String(dispatch.state || ""))
      && !dispatchRetryAllowed(dispatch)
      && String(dispatch.state || "") !== "completed"
  ));
  const hasRetryableTerminal = dispatches.some((dispatch) => (
    MEMORY_UPDATE_TERMINAL_STATES.has(String(dispatch.state || ""))
      && String(dispatch.state || "") !== "completed"
      && dispatchRetryAllowed(dispatch)
  ));

  let nextStatus = String(settings?.memory_update_status || "queued");
  let nextError = settings?.memory_update_error || null;
  let completedAt = settings?.memory_update_completed_at || null;
  if (allCompleted) {
    nextStatus = "completed";
    nextError = null;
    completedAt = settings?.memory_update_completed_at || new Date().toISOString();
  } else if (hasActive) {
    nextStatus = states.every((state) => state === "queued") ? "queued" : "in_progress";
    nextError = null;
    completedAt = null;
  } else if (hasUnsafeTerminal) {
    nextStatus = "user_required";
    nextError = dispatches.find((dispatch) => dispatch.manual_review_required === true || dispatchHasSendBoundary(dispatch))?.error?.message
      || "The update may have reached ChatGPT. Review the bound Professional background conversation before retrying.";
  } else if (hasRetryableTerminal) {
    nextStatus = "failed";
    nextError = dispatches.find((dispatch) => dispatchRetryAllowed(dispatch))?.error?.message
      || "The Website Bridge stopped before sending the Memory update.";
    completedAt = null;
  }

  const changed = nextStatus !== settings?.memory_update_status
    || nextError !== (settings?.memory_update_error || null)
    || completedAt !== (settings?.memory_update_completed_at || null)
    || (allCompleted && Boolean(settings?.memory_update_pending_snapshot));
  const nextSettings = changed
    ? await updateSettings(supabase, profile.id, {
      memory_update_status: nextStatus,
      memory_update_completed_at: completedAt,
      memory_update_error: nextError,
      ...(allCompleted && settings?.memory_update_pending_snapshot
        ? {
          memory_update_snapshot: settings.memory_update_pending_snapshot,
          memory_update_pending_snapshot: null,
          memory_update_pending_payload: null,
        }
        : {}),
    })
    : settings;
  return { settings: nextSettings, dispatches, info };
}

async function refreshMemoryUpdateDispatches(supabase: any, dispatches: Record<string, any>[]) {
  const refreshed: Record<string, any>[] = [];
  for (const candidate of dispatches) {
    let dispatch = candidate;
    const state = String(dispatch.state || "");
    if (["failed", "expired", "user_required"].includes(state)) {
      if (!dispatchRetryAllowed(dispatch)) {
        throw new Error("The previous Memory update may have reached ChatGPT. Review the bound Professional background conversation before retrying.");
      }
      const { data, error } = await supabase.rpc("retry_chatgpt_dispatch_request", { p_request_id: dispatch.id });
      if (error) throw error;
      dispatch = await readDispatch(supabase, String((data as Record<string, unknown>)?.id || dispatch.id));
    } else if (state === "cancelled") {
      throw new Error("The previous Memory update was cancelled. Save the corrected details again to create a new request.");
    }
    refreshed.push(dispatch);
  }
  return refreshed;
}

function memoryUpdateFingerprint(dispatches: Record<string, any>[]) {
  return dispatches
    .map((dispatch) => typeof dispatch.idempotency_key === "string" ? dispatch.idempotency_key : String(dispatch.id || ""))
    .filter(Boolean)
    .join("|");
}

function bridgeHintsForDispatches(dispatches: Record<string, any>[]) {
  return dispatches
    .filter((dispatch) => MEMORY_UPDATE_ACTIVE_STATES.has(String(dispatch.state || "")))
    .map((dispatch) => bridgeHintForDispatch(dispatch))
    .filter((hint) => Boolean(hint));
}

async function saveMemoryUpdateQueue(supabase: any, profileId: string, dispatches: Record<string, any>[], now: string) {
  const ids = dispatches.map((dispatch) => String(dispatch.id || "")).filter(Boolean);
  if (!ids.length) throw new Error("The Website Bridge did not return a Memory update request.");
  const { data, error } = await supabase.from("candidate_chatgpt_memory").update({
    memory_update_status: dispatches.every((dispatch) => String(dispatch.state || "") === "queued") ? "queued" : "in_progress",
    memory_update_dispatch_ids: ids,
    memory_update_requested_at: now,
    memory_update_completed_at: null,
    memory_update_error: null,
    memory_update_fingerprint: memoryUpdateFingerprint(dispatches),
    updated_at: now,
  }).eq("profile_id", profileId).select("*").single();
  if (error) throw error;
  return data as MemorySettings;
}

export async function GET() {
  try {
    const { supabase, user, profile } = await requireProfile();
    const settings = await readSettings(supabase, profile.id);
    const latestImport = await finaliseMemoryImport(supabase, user, profile, settings);
    const latestUpdate = await finaliseMemoryUpdate(supabase, profile, latestImport);
    const latest = latestUpdate.settings;
    const bridge = ["queued", "in_progress"].includes(String(latest?.memory_import_status || ""))
      || ["queued", "in_progress"].includes(String(latest?.memory_update_status || ""))
      ? await readBridgeReadiness(supabase)
      : null;
    const stoppedDispatch = latest?.memory_import_status === "user_required" && latest?.memory_import_dispatch_id
      ? await readDispatch(supabase, latest.memory_import_dispatch_id)
      : null;
    const responseCheckAvailable = canCheckCompletedResponse(stoppedDispatch);
    const manualReviewRequired = stoppedDispatch?.manual_review_required === true;
    return NextResponse.json({ ok: true, memory: memoryResponse(latest, bridge, responseCheckAvailable, manualReviewRequired, latestUpdate.info) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error, "Unable to read ChatGPT Memory setup.") }, { status: statusCode(error) });
  }
}

export async function POST(request: Request) {
  let operationClient: any = null;
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const { supabase, user, profile } = await requireProfile();
    operationClient = supabase;
    const loadedSettings = await readSettings(supabase, profile.id);
    // Reconcile a finished dispatch before evaluating a new action. This
    // closes the small window where the bridge has completed but the browser
    // has not polled GET yet, so a second click is not incorrectly rejected as
    // "already in progress".
    const reconciledUpdate = await finaliseMemoryUpdate(supabase, profile, loadedSettings);
    const current = reconciledUpdate.settings;
    const now = new Date().toISOString();

    if (action === "allow") {
      const settings = await supabase.from("candidate_chatgpt_memory").upsert({
        profile_id: profile.id,
        memory_enabled_user_confirmed: true,
        use_previous_knowledge: true,
        consent_status: "allowed",
        memory_sync_enabled: true,
        memory_confirmed_at: current?.memory_confirmed_at || now,
        memory_import_status: current?.memory_import_status || "not_requested",
        memory_import_dispatch_id: current?.memory_import_dispatch_id || null,
        memory_import_requested_at: current?.memory_import_requested_at || null,
        memory_import_completed_at: current?.memory_import_completed_at || null,
        memory_import_error: current?.memory_import_error || null,
        memory_import_questions: Array.isArray(current?.memory_import_questions) ? current.memory_import_questions : [],
        memory_update_status: current?.memory_update_status || "not_requested",
        memory_update_dispatch_ids: Array.isArray(current?.memory_update_dispatch_ids) ? current.memory_update_dispatch_ids : [],
        memory_update_requested_at: current?.memory_update_requested_at || null,
        memory_update_completed_at: current?.memory_update_completed_at || null,
        memory_update_error: current?.memory_update_error || null,
        memory_update_fingerprint: current?.memory_update_fingerprint || null,
        memory_update_snapshot: current?.memory_update_snapshot || {},
        memory_update_pending_snapshot: current?.memory_update_pending_snapshot || null,
        memory_update_pending_payload: current?.memory_update_pending_payload || null,
        updated_at: now,
      }, { onConflict: "profile_id" }).select("*").single();
      if (settings.error) throw settings.error;
      return NextResponse.json({ ok: true, memory: memoryResponse(settings.data) });
    }

    if (action === "decline") {
      const settings = await supabase.from("candidate_chatgpt_memory").upsert({
        profile_id: profile.id,
        memory_enabled_user_confirmed: false,
        use_previous_knowledge: false,
        consent_status: "declined",
        memory_sync_enabled: false,
        memory_import_status: "not_requested",
        memory_import_dispatch_id: null,
        memory_import_requested_at: null,
        memory_import_completed_at: null,
        memory_import_error: null,
        memory_import_questions: [],
        memory_update_status: "not_requested",
        memory_update_dispatch_ids: [],
        memory_update_requested_at: null,
        memory_update_completed_at: null,
        memory_update_error: null,
        memory_update_fingerprint: null,
        memory_update_snapshot: {},
        memory_update_pending_snapshot: null,
        memory_update_pending_payload: null,
        updated_at: now,
      }, { onConflict: "profile_id" }).select("*").single();
      if (settings.error) throw settings.error;
      return NextResponse.json({ ok: true, memory: memoryResponse(settings.data) });
    }

    if (action === "reset") {
      const settings = await supabase.from("candidate_chatgpt_memory").upsert({
        profile_id: profile.id,
        memory_enabled_user_confirmed: false,
        use_previous_knowledge: true,
        consent_status: "undecided",
        memory_sync_enabled: false,
        memory_import_status: "not_requested",
        memory_import_dispatch_id: null,
        memory_import_requested_at: null,
        memory_import_completed_at: null,
        memory_import_error: null,
        memory_confirmed_at: null,
        memory_import_questions: [],
        memory_update_status: "not_requested",
        memory_update_dispatch_ids: [],
        memory_update_requested_at: null,
        memory_update_completed_at: null,
        memory_update_error: null,
        memory_update_fingerprint: null,
        memory_update_snapshot: {},
        memory_update_pending_snapshot: null,
        memory_update_pending_payload: null,
        updated_at: now,
      }, { onConflict: "profile_id" }).select("*").single();
      if (settings.error) throw settings.error;
      return NextResponse.json({ ok: true, memory: memoryResponse(settings.data) });
    }

    if (action === "check_completed_response") {
      const bridge = await readBridgeReadiness(supabase);
      if (!bridgeReadyForDispatch(bridge)) throw new Error(bridgeReadinessError(bridge));
      if (!current?.memory_import_dispatch_id) throw new Error("There is no previous ChatGPT Memory request to check.");
      const previous = await readDispatch(supabase, current.memory_import_dispatch_id);
      if (!canCheckCompletedResponse(previous)) {
        throw new Error("A completed-response check is available only after the previous Memory attempt may have reached ChatGPT but its response could not be captured.");
      }
      const websiteInstruction = typeof previous.website_instruction === "string" && previous.website_instruction.trim()
        ? previous.website_instruction.trim()
        : typeof previous.manual_instruction === "string" ? previous.manual_instruction.trim() : "";
      if (!websiteInstruction) throw new Error("The previous Memory instruction could not be recovered safely.");
      // Use the dedicated server-side response-check creator. The normal
      // profile.background creator rejects subject references; this boundary
      // validates ownership and eligibility before recording exactly one
      // response_check_for reference and marking the ticket read-only.
      const testingModeEnabled = await readChatGptTestingMode(supabase, user.id);
      const responseCheckInstruction = testingModeEnabled
        ? `${CHATGPT_TESTING_MODE_PREFIX}\n\nDo not carry out, repeat, or resume the previous request. This diagnostic is test-only: inspect only the visible conversation and report whether a response to the earlier message is present. Do not change Memory or take any action beyond this read-only status report.`
        : websiteInstruction;
      const prepared = await prepareChatGptInstruction(supabase, user.id, responseCheckInstruction);
      operationId = await beginChatGptOperation(supabase, "Check the completed ChatGPT response");
      const { data: dispatch, error: dispatchError } = await supabase.rpc("create_chatgpt_response_check_dispatch", {
        p_source_request_id: previous.id,
        p_website_instruction: prepared.instruction,
        p_idempotency_key: `profile.memory.response-check:${previous.id}`,
      });
      if (dispatchError) throw dispatchError;
      if (typeof dispatch?.id !== "string") throw new Error("The response check did not return a dispatch request id.");
      await trackChatGptOperation(supabase, operationId, [dispatch.id]);
      operationTracked = true;
      const settings = await supabase.from("candidate_chatgpt_memory").upsert({
        profile_id: profile.id,
        memory_enabled_user_confirmed: true,
        use_previous_knowledge: true,
        consent_status: "allowed",
        memory_sync_enabled: true,
        memory_confirmed_at: current?.memory_confirmed_at || now,
        memory_import_status: "queued",
        memory_import_dispatch_id: dispatch.id,
        memory_import_requested_at: now,
        memory_import_completed_at: null,
        memory_import_error: null,
        memory_import_questions: [],
        updated_at: now,
      }, { onConflict: "profile_id" }).select("*").single();
      if (settings.error) throw settings.error;
      return NextResponse.json({
        ok: true,
        memory: memoryResponse(settings.data, bridge),
        dispatch,
        bridge_hint: dispatch?.id ? { version: 1, type: "JOBHUNT_DISPATCH_HINT", request_id: dispatch.id, correlation_id: dispatch.correlation_id || dispatch.id, nonce: crypto.randomUUID() } : undefined,
      }, { status: 202 });
    }

    if (action === "reset_review") {
      const { data: memorySources, error: sourceError } = await supabase
        .from("evidence_sources")
        .select("id")
        .eq("profile_id", profile.id)
        .eq("source_type", "chatgpt_memory");
      if (sourceError) throw sourceError;
      const sourceIds = (memorySources || []).map((source: { id?: unknown }) => String(source.id || "")).filter(Boolean);
      const results: Array<{ data: Array<{ id: string }> | null; error: unknown }> = [];

      const facts = await supabase
        .from("candidate_facts")
        .update({ verification_status: "needs_review", verified_at: null, updated_at: now })
        .eq("profile_id", profile.id)
        .eq("verification_status", "verified")
        .like("source_note", "chatgpt_memory:%")
        .select("id");
      results.push(facts);

      if (sourceIds.length) {
        const [evidence, proposals, employment, education, skills, projects, publications] = await Promise.all([
          supabase.from("evidence_items").update({ verification_status: "needs_review", updated_at: now }).eq("profile_id", profile.id).eq("verification_status", "verified").in("source_id", sourceIds).select("id"),
          supabase.from("candidate_extraction_proposals").update({ verification_status: "needs_review", reviewed_at: null, updated_at: now }).eq("profile_id", profile.id).eq("verification_status", "verified").in("source_id", sourceIds).select("id"),
          supabase.from("candidate_employment").update({ verification_status: "needs_review", updated_at: now }).eq("profile_id", profile.id).eq("verification_status", "verified").in("source_id", sourceIds).select("id"),
          supabase.from("candidate_education").update({ verification_status: "needs_review", updated_at: now }).eq("profile_id", profile.id).eq("verification_status", "verified").in("source_id", sourceIds).select("id"),
          supabase.from("candidate_skills").update({ verification_status: "needs_review", updated_at: now }).eq("profile_id", profile.id).eq("verification_status", "verified").in("source_id", sourceIds).select("id"),
          supabase.from("candidate_projects").update({ verification_status: "needs_review", updated_at: now }).eq("profile_id", profile.id).eq("verification_status", "verified").in("source_id", sourceIds).select("id"),
          supabase.from("candidate_publications").update({ verification_status: "needs_review", updated_at: now }).eq("profile_id", profile.id).eq("verification_status", "verified").in("source_id", sourceIds).select("id"),
        ]);
        results.push(evidence, proposals, employment, education, skills, projects, publications);
      }

      const failed = results.find((result) => result.error);
      if (failed?.error) throw failed.error;
      const reviewResetCount = results.reduce((total, result) => total + (result.data?.length || 0), 0);
      return NextResponse.json({ ok: true, memory: memoryResponse(current), reviewResetCount });
    }

    // Old cached clients used this action as both consent and dispatch. Keep
    // the contract fail-closed during rollout: a stale page must refresh
    // instead of allowing the Memory button to send a ChatGPT message.
    if (action === "allow_and_import") {
      return NextResponse.json({
        ok: false,
        code: "onboarding_client_refresh_required",
        error: "This onboarding page is out of date. Refresh it before choosing ChatGPT Memory; the Memory button no longer sends messages.",
      }, { status: 409 });
    }

    // Keep the pre-refactor recovery path isolated from the public action
    // above. It is retained only so a previously-created, pre-barrier request
    // can be recovered safely; the current UI never posts this action.
    if (action === "allow_and_import_legacy_unreachable") {
      const bridge = await readBridgeReadiness(supabase);
      if (!bridgeReadyForDispatch(bridge)) throw new Error(bridgeReadinessError(bridge));
      if (current?.memory_import_dispatch_id) {
        const existingDispatch = await readDispatch(supabase, current.memory_import_dispatch_id);
        const existingState = String(existingDispatch.state || current.memory_import_status || "");
        const currentSourceFirstSummary = isCurrentSourceFirstSummary(existingDispatch);
        const activeStates = ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready", "sent", "acknowledged_by_mcp", "running"];

        // A pre-barrier summary could still be waiting in the queue from an
        // older build. It is safe to stop before delivery and start the
        // source-first flow below; a request that may already have been sent
        // remains protected by the existing at-most-once safe stop.
        if (!currentSourceFirstSummary && !existingDispatch.sent_at && ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready"].includes(existingState)) {
          const { error: cancelError } = await supabase.rpc("cancel_chatgpt_dispatch_request", { p_request_id: current.memory_import_dispatch_id });
          if (cancelError) throw cancelError;
        }

        if (currentSourceFirstSummary && activeStates.includes(existingState)) {
          // Repeated clicks must never create another Memory message while a
          // request is already in flight. Return the original request and
          // re-notify the bridge when delivery has not started yet; this
          // recovers a page/extension handoff that was missed on the first
          // click without ever creating a duplicate request.
          return NextResponse.json({
            ok: true,
            memory: memoryResponse(current),
            dispatch: { id: current.memory_import_dispatch_id, state: existingState },
            bridge_hint: existingDispatch.sent_at ? undefined : bridgeHintForDispatch(existingDispatch),
          }, { status: 202 });
        }
        if (currentSourceFirstSummary && ["user_required", "failed", "expired"].includes(existingState) && !existingDispatch.sent_at) {
          operationId = await beginChatGptOperation(supabase, "Retry ChatGPT Memory profile import");
          const retryIds: string[] = [];
          // If the dependency barrier stopped the profile request because a
          // source update failed before delivery, retry those same source
          // requests first. The summary remains blocked until they complete.
          if (String(existingDispatch.error?.code || "") === "source_memory_update_incomplete") {
            const dependencyIds = Array.isArray(existingDispatch.depends_on_request_ids)
              ? existingDispatch.depends_on_request_ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
              : [];
            for (const dependencyId of dependencyIds) {
              const dependency = await readDispatch(supabase, dependencyId);
              const dependencyState = String(dependency.state || "");
              if (dependencyState === "completed" || ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready"].includes(dependencyState)) continue;
              if (["failed", "expired", "user_required"].includes(dependencyState) && !dependency.sent_at) {
                const { error: dependencyRetryError } = await supabase.rpc("retry_chatgpt_dispatch_request", { p_request_id: dependencyId });
                if (dependencyRetryError) throw dependencyRetryError;
                retryIds.push(dependencyId);
                continue;
              }
              throw new Error("A source Memory update may already have been sent. Review the bound ChatGPT conversation before retrying the profile import.");
            }
          }
          // A pre-delivery safe stop is safe to retry by id. Reusing the
          // request preserves idempotency and prevents repeated clicks from
          // queueing duplicate onboarding messages.
          const { data: retried, error: retryError } = await supabase.rpc("retry_chatgpt_dispatch_request", { p_request_id: current.memory_import_dispatch_id });
          if (retryError) throw retryError;
          retryIds.push(current.memory_import_dispatch_id);
          await trackChatGptOperation(supabase, operationId, retryIds);
          operationTracked = true;
          const settings = await updateSettings(supabase, profile.id, {
            memory_enabled_user_confirmed: true,
            use_previous_knowledge: true,
            consent_status: "allowed",
            memory_sync_enabled: true,
            memory_confirmed_at: current?.memory_confirmed_at || now,
            memory_import_status: "queued",
            memory_import_requested_at: now,
            memory_import_error: null,
          });
          return NextResponse.json({
            ok: true,
            memory: memoryResponse(settings),
            dispatch: retried,
            bridge_hint: bridgeHintForDispatch(existingDispatch),
          }, { status: 202 });
        }
        if (existingState === "completed") {
          return NextResponse.json({
            ok: true,
            memory: memoryResponse(current),
            dispatch: { id: current.memory_import_dispatch_id, state: existingState },
          }, { status: 202 });
        }
        if (existingDispatch.sent_at) {
          throw new Error("The previous Memory message may already have been sent. Review the bound ChatGPT conversation before requesting another import.");
        }
      }
      const [factsResult, sourcesResult] = await Promise.all([
        supabase.from("candidate_facts").select("fact_key,value_json").eq("profile_id", profile.id),
        supabase.from("candidate_source_documents").select("id,original_name,source_type,storage_object_key,mime_type,byte_size,sha256,extraction_status,created_at,updated_at").eq("profile_id", profile.id).order("created_at", { ascending: false }),
      ]);
      const contextError = [factsResult, sourcesResult].find((result) => result.error)?.error;
      if (contextError) throw contextError;
      const linkedInFact = (factsResult.data || []).find((fact: Record<string, unknown>) => fact.fact_key === "linkedin_url");
      const linkedInUrl = typeof linkedInFact?.value_json === "string" ? linkedInFact.value_json : null;
      operationId = await beginChatGptOperation(supabase, "Build professional profile with ChatGPT");
      const queued = await queueProfessionalBackgroundImport({
        supabase,
        userId: user.id,
        profileId: profile.id,
        displayName: profile.display_name,
        sourceDocuments: sourcesResult.data || [],
        linkedinUrl: linkedInUrl,
        allowMemoryUpdate: true,
        includeJsonProfile: true,
      });
      const dispatch = queued.summaryDispatch;
      if (!dispatch?.id) throw new Error("The structured professional-profile request could not be queued.");
      await trackChatGptOperation(supabase, operationId, queued.dispatches.map((item) => String(item?.id || "")));
      operationTracked = true;
      const settings = await supabase.from("candidate_chatgpt_memory").upsert({
        profile_id: profile.id,
        memory_enabled_user_confirmed: true,
        use_previous_knowledge: true,
        consent_status: "allowed",
        memory_sync_enabled: true,
        memory_confirmed_at: current?.memory_confirmed_at || now,
        memory_import_status: "queued",
        memory_import_dispatch_id: dispatch.id,
        memory_import_requested_at: now,
        memory_import_completed_at: null,
        memory_import_error: null,
        memory_import_questions: [],
        updated_at: now,
      }, { onConflict: "profile_id" }).select("*").single();
      if (settings.error) throw settings.error;
      const bridgeHints = queued.dispatches.map((item) => ({
        version: 1 as const,
        type: "JOBHUNT_DISPATCH_HINT" as const,
        request_id: item?.id,
        correlation_id: item?.correlation_id || item?.id,
        nonce: crypto.randomUUID(),
      }));
      const firstQueuedIndex = queued.dispatches.findIndex((item) => ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready"].includes(String(item?.state || "")));
      return NextResponse.json({
        ok: true,
        memory: memoryResponse(settings.data),
        dispatch,
        dispatches: queued.dispatches,
        bridge_hint: bridgeHints[firstQueuedIndex >= 0 ? firstQueuedIndex : 0],
        bridge_hints: bridgeHints,
      }, { status: 202 });
    }

    if (action === "retry_confirmed_profile") {
      const bridge = await readBridgeReadiness(supabase);
      if (!bridgeReadyForDispatch(bridge)) throw new Error(bridgeReadinessError(bridge));
      const ids = Array.isArray(current?.memory_update_dispatch_ids)
        ? current.memory_update_dispatch_ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
        : [];
      if (!ids.length) throw new Error("There is no previous incremental Memory update to retry.");
      operationId = await beginChatGptOperation(supabase, "Retry ChatGPT Memory update");
      const existing = await Promise.all(ids.map((id) => readDispatch(supabase, id)));
      const dispatches = await refreshMemoryUpdateDispatches(supabase, existing);
      const activeIds = dispatches.filter((item) => MEMORY_UPDATE_ACTIVE_STATES.has(String(item.state || ""))).map((item) => String(item.id || ""));
      if (activeIds.length) {
        await trackChatGptOperation(supabase, operationId, activeIds);
        operationTracked = true;
      }
      const settings = await saveMemoryUpdateQueue(supabase, profile.id, dispatches, now);
      const latestUpdate = await finaliseMemoryUpdate(supabase, profile, settings);
      const bridgeHints = bridgeHintsForDispatches(latestUpdate.dispatches);
      return NextResponse.json({
        ok: true,
        memory: memoryResponse(latestUpdate.settings, bridge, false, false, latestUpdate.info),
        dispatch: latestUpdate.dispatches[0] || null,
        dispatches: latestUpdate.dispatches,
        bridge_hint: bridgeHints[0],
        bridge_hints: bridgeHints,
      }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
    }

    if (action === "sync_confirmed_profile") {
      const allowed = Boolean(current?.memory_enabled_user_confirmed) && current?.use_previous_knowledge !== false && current?.memory_sync_enabled === true;
      if (!allowed) throw new Error("Allow ChatGPT Memory before updating it with confirmed profile details.");
      const bridge = await readBridgeReadiness(supabase);
      if (!bridgeReadyForDispatch(bridge)) throw new Error(bridgeReadinessError(bridge));
      const currentStatus = String(current?.memory_update_status || "not_requested");
      const currentDispatchIds = Array.isArray(current?.memory_update_dispatch_ids)
        ? current.memory_update_dispatch_ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
        : [];
      // A worker/browser crash can happen after the pending delta is written
      // but before the first dispatch id is recorded. That state is safe to
      // recover because no send boundary exists; recompute the current delta
      // below and replace the pending payload. Requests with any recorded id
      // remain blocked until their durable lifecycle is reconciled.
      if (MEMORY_UPDATE_ACTIVE_STATES.has(currentStatus) && currentDispatchIds.length > 0) {
        throw new Error("A ChatGPT Memory update is already in progress. Wait for it to finish before sending another correction.");
      }
      const input = await readVerifiedProfessionalBackground(supabase, profile, {
        includeImported: true,
        allowMemoryUpdate: true,
      });
      const previousSnapshot = (current?.memory_update_snapshot && typeof current.memory_update_snapshot === "object" && !Array.isArray(current.memory_update_snapshot)
        ? current.memory_update_snapshot
        : {}) as ProfileSnapshot;
      const nextSnapshot = snapshotFromInput(input);
      const changedFields = diffSnapshots(previousSnapshot, nextSnapshot);
      if (!changedFields.length) {
        const settings = await updateSettings(supabase, profile.id, {
          memory_update_status: "completed",
          memory_update_error: null,
          memory_update_completed_at: current?.memory_update_completed_at || now,
          memory_update_pending_snapshot: null,
          memory_update_pending_payload: null,
        });
        return NextResponse.json({
          ok: true,
          noChanges: true,
          memory: memoryResponse(settings, bridge, false, false, { retryAllowed: false, manualReviewRequired: false }),
          dispatches: [],
        }, { status: 200, headers: { "Cache-Control": "private, no-store" } });
      }

      // Mark the exact delta as pending before queueing. The idempotent queue
      // key is derived from this payload, so a page refresh or worker restart
      // can recover the same message without sending a duplicate.
      await updateSettings(supabase, profile.id, {
        memory_update_status: "in_progress",
        memory_update_pending_snapshot: nextSnapshot,
        memory_update_pending_payload: { changedFields },
        memory_update_requested_at: now,
        memory_update_completed_at: null,
        memory_update_error: null,
      });
      operationId = await beginChatGptOperation(supabase, "Sync corrected profile details to ChatGPT Memory");
      const deltaInput = {
        ...input,
        facts: [],
        employment: [],
        education: [],
        skills: [],
        projects: [],
        publications: [],
        evidence: [],
        sourceDocuments: [],
        sourceNames: [],
        preferences: {},
        changedFields,
      };
      try {
        const queuedDispatches = await queueProfessionalBackgroundInstructions({
          supabase,
          userId: user.id,
          input: deltaInput,
          displayTitle: "Update ChatGPT professional Memory",
          idempotencyKeyPrefix: "profile.background.confirmed:v3",
          priority: 55,
        });
        const queuedIds = queuedDispatches.map((item) => String(item?.id || "")).filter(Boolean);
        if (queuedIds.length) {
          await trackChatGptOperation(supabase, operationId, queuedIds);
          operationTracked = true;
        }
        const initialDispatches = await Promise.all(queuedDispatches.map((dispatch) => readDispatch(supabase, String(dispatch.id || ""))));
        const dispatches = await refreshMemoryUpdateDispatches(supabase, initialDispatches);
        const settings = await saveMemoryUpdateQueue(supabase, profile.id, dispatches, now);
        const latestUpdate = await finaliseMemoryUpdate(supabase, profile, settings);
        const bridgeHints = bridgeHintsForDispatches(latestUpdate.dispatches);
        return NextResponse.json({
          ok: true,
          memory: memoryResponse(latestUpdate.settings, bridge, false, false, latestUpdate.info),
          dispatch: latestUpdate.dispatches[0] || null,
          dispatches: latestUpdate.dispatches,
          bridge_hint: bridgeHints[0],
          bridge_hints: bridgeHints,
        }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
      } catch (cause) {
        // Leave the pending snapshot intact for a safe retry, but never leave
        // an ID-less in_progress row that would make the page appear hung.
        await updateSettings(supabase, profile.id, {
          memory_update_status: "failed",
          memory_update_error: errorMessage(cause, "The corrected profile could not be queued."),
        });
        throw cause;
      }
    }

    throw new Error("Unknown ChatGPT Memory action.");
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error, "Unable to update ChatGPT Memory setup.") }, { status: statusCode(error) });
  } finally {
    if (operationClient && operationId && !operationTracked) {
      try { await releaseChatGptOperation(operationClient, operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}
