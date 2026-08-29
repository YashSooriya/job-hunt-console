import { NextResponse } from "next/server";
import { importCandidateSource } from "@/lib/onboarding/import-source";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
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

type MemorySettings = Record<string, any> | null;

type BridgeReadiness = {
  paired: boolean;
  online: boolean;
  automaticSendEnabled: boolean;
  extensionVersion: string | null;
  hasProfessionalBackgroundConversation: boolean;
  workflowConversationCount: number;
};

const MEMORY_IMPORT_MAX_TEXT_CHARS = 36000;
const MEMORY_IMPORT_PROPOSAL_LIMIT = 48;
const MEMORY_IMPORT_RETRY_AFTER_MS = 2 * 60 * 1000;
const RESPONSE_CHECK_DISPLAY_TITLE = "Check completed professional profile response";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return String((error as { message: string }).message);
  }
  return fallback;
}

function memoryResponse(settings: MemorySettings, bridge: BridgeReadiness | null = null, responseCheckAvailable = false) {
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
    responseCheckAvailable,
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

async function readBridgeReadiness(supabase: any): Promise<BridgeReadiness | null> {
  try {
    const { data, error } = await supabase.rpc("get_chatgpt_bridge_status");
    if (error || !data || typeof data !== "object") return null;
    const devices = Array.isArray((data as Record<string, unknown>).devices)
      ? (data as { devices: Array<Record<string, unknown>> }).devices
      : [];
    const device = devices.find((candidate) => candidate.online === true) || devices[0] || null;
    const conversations = device && Array.isArray(device.conversations)
      ? device.conversations as Array<Record<string, unknown>>
      : [];
    return {
      paired: devices.length > 0,
      online: device?.online === true,
      automaticSendEnabled: device?.automatic_send_enabled === true,
      extensionVersion: typeof device?.extension_version === "string" ? device.extension_version : null,
      hasProfessionalBackgroundConversation: conversations.some((conversation) => (
        conversation.workflow_key === "profile.background" && conversation.project_verified !== false
      )),
      workflowConversationCount: conversations.length,
    };
  } catch {
    return null;
  }
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
  const code = String(dispatch?.error?.code || "");
  const state = String(dispatch?.state || "");
  const missingRecordedResponse = !String(dispatch?.bridge_response || "").trim() && !dispatch?.completed_at;
  return dispatch?.action_type === "profile.background"
    && (
      (state === "user_required" && Boolean(dispatch?.sent_at) && ["response_not_captured", "response_capture_failed"].includes(code))
      // A delivery acknowledgement can time out after the Website Bridge has
      // already typed and sent the message. The original request deliberately
      // remains unsent in the database because automatically retrying it could
      // duplicate the user's long-running Memory prompt. Allow an explicit,
      // read-only response check for that state as well; the extension will
      // look for the exact existing prompt and will never send it again.
      || (state === "user_required" && !dispatch?.sent_at && ["delivery_uncertain", "delivery_lease_expired"].includes(code))
      // Older bridge versions could leave a sent request in this state after
      // their shorter lease expired. A read-only check is safe when there is
      // still no response recorded, and avoids forcing the user to resend the
      // long-running Memory prompt.
      || (state === "sent" && missingRecordedResponse)
    );
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

async function finaliseMemoryImport(supabase: any, user: { id: string }, profile: { id: string }, settings: MemorySettings) {
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
      return updateSettings(supabase, profile.id, {
        memory_import_status: "completed",
        memory_import_completed_at: new Date().toISOString(),
        memory_import_questions: importQuestions,
        memory_import_error: null,
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

export async function GET() {
  try {
    const { supabase, user, profile } = await requireProfile();
    const settings = await readSettings(supabase, profile.id);
    const latest = await finaliseMemoryImport(supabase, user, profile, settings);
    const bridge = ["queued", "in_progress"].includes(String(latest?.memory_import_status || ""))
      ? await readBridgeReadiness(supabase)
      : null;
    const responseCheckAvailable = latest?.memory_import_status === "user_required" && latest?.memory_import_dispatch_id
      ? canCheckCompletedResponse(await readDispatch(supabase, latest.memory_import_dispatch_id))
      : false;
    return NextResponse.json({ ok: true, memory: memoryResponse(latest, bridge, responseCheckAvailable) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error, "Unable to read ChatGPT Memory setup.") }, { status: statusCode(error) });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const { supabase, user, profile } = await requireProfile();
    const current = await readSettings(supabase, profile.id);
    const now = new Date().toISOString();

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
        updated_at: now,
      }, { onConflict: "profile_id" }).select("*").single();
      if (settings.error) throw settings.error;
      return NextResponse.json({ ok: true, memory: memoryResponse(settings.data) });
    }

    if (action === "check_completed_response") {
      if (!current?.memory_import_dispatch_id) throw new Error("There is no previous ChatGPT Memory request to check.");
      const previous = await readDispatch(supabase, current.memory_import_dispatch_id);
      if (!canCheckCompletedResponse(previous)) {
        throw new Error("A completed-response check is available only after the previous Memory attempt may have reached ChatGPT but its response could not be captured.");
      }
      const websiteInstruction = typeof previous.website_instruction === "string" && previous.website_instruction.trim()
        ? previous.website_instruction.trim()
        : typeof previous.manual_instruction === "string" ? previous.manual_instruction.trim() : "";
      if (!websiteInstruction) throw new Error("The previous Memory instruction could not be recovered safely.");
      const { data: dispatch, error: dispatchError } = await supabase.rpc("create_chatgpt_dispatch_request_with_website_instruction", {
        p_action_type: "profile.background",
        p_subject_refs: {},
        p_origin: "user_click",
        p_display_title: RESPONSE_CHECK_DISPLAY_TITLE,
        p_idempotency_key: `profile.memory.response-check:${previous.id}:${crypto.randomUUID()}`,
        p_priority: 80,
        p_website_instruction: websiteInstruction,
      });
      if (dispatchError) throw dispatchError;
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
        memory: memoryResponse(settings.data),
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

    if (action === "allow_and_import") {
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
      const queued = await queueProfessionalBackgroundImport({
        supabase,
        profileId: profile.id,
        displayName: profile.display_name,
        sourceDocuments: sourcesResult.data || [],
        linkedinUrl: linkedInUrl,
        allowMemoryUpdate: true,
        includeJsonProfile: true,
      });
      const dispatch = queued.summaryDispatch;
      if (!dispatch?.id) throw new Error("The structured professional-profile request could not be queued.");
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

    if (action === "sync_confirmed_profile") {
      const allowed = Boolean(current?.memory_enabled_user_confirmed) && current?.use_previous_knowledge !== false && current?.memory_sync_enabled === true;
      if (!allowed) throw new Error("Allow ChatGPT Memory before updating it with confirmed profile details.");
      const input = await readVerifiedProfessionalBackground(supabase, profile);
      const dispatches = await queueProfessionalBackgroundInstructions({
        supabase,
        input,
        displayTitle: "Update ChatGPT professional Memory",
        idempotencyKeyPrefix: "profile.background.confirmed:v2",
        priority: 55,
      });
      const dispatch = dispatches[0] || null;
      const bridgeHints = dispatches.map((item) => ({
        version: 1 as const,
        type: "JOBHUNT_DISPATCH_HINT" as const,
        request_id: item.id,
        correlation_id: item.correlation_id || item.id,
        nonce: crypto.randomUUID(),
      }));
      return NextResponse.json({
        ok: true,
        memory: memoryResponse(current),
        dispatch,
        dispatches,
        bridge_hint: bridgeHints[0],
        bridge_hints: bridgeHints,
      }, { status: 202 });
    }

    throw new Error("Unknown ChatGPT Memory action.");
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error, "Unable to update ChatGPT Memory setup.") }, { status: statusCode(error) });
  }
}
