import { NextResponse } from "next/server";
import { queueProfessionalBackgroundImport } from "@/lib/chatgpt/professional-background-dispatch";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { normaliseLinkedInUrl, sourceBundleDigest } from "@/lib/onboarding/source-validation";
import { bridgeReadinessError, bridgeReadyForDispatch, readBridgeReadiness } from "@/lib/chatgpt-bridge/readiness";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";

export async function POST(request: Request) {
  let operationClient: any = null;
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const hasLinkedinUrl = Object.prototype.hasOwnProperty.call(body, "linkedinUrl");
    const linkedinUrl = hasLinkedinUrl ? normaliseLinkedInUrl(body.linkedinUrl) : "";
    const expectedBundleRevision = typeof body.expectedBundleRevision === "string" ? body.expectedBundleRevision : "";
    const refreshOnly = body.refreshOnly === true;
    const { supabase, profile } = await requireProfile();
    operationClient = supabase;
    const now = new Date().toISOString();

    const { data: memorySettings, error: memoryError } = await supabase
      .from("candidate_chatgpt_memory")
      .select("memory_enabled_user_confirmed,use_previous_knowledge,memory_sync_enabled")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (memoryError) throw memoryError;
    const allowMemoryUpdate = Boolean(
      memorySettings?.memory_enabled_user_confirmed
      && memorySettings?.use_previous_knowledge !== false
      && memorySettings?.memory_sync_enabled === true,
    );
    // A profile build is the explicit ChatGPT send boundary. Do not create a
    // durable dispatch that an offline, stale, or partially upgraded bridge
    // could claim later and send unexpectedly. bridgeReadyForDispatch also
    // requires background_focus_policy_v2, result_completion_v3 and
    // response_provenance_v3 so this route cannot queue work for an older
    // bridge that could steal focus or import the wrong response.
    if (allowMemoryUpdate) {
      const bridge = await readBridgeReadiness(supabase);
      if (!bridgeReadyForDispatch(bridge)) throw new Error(bridgeReadinessError(bridge));
    }

    if (hasLinkedinUrl && linkedinUrl) {
      const { error } = await supabase.from("candidate_facts").upsert({
        profile_id: profile.id,
        fact_key: "linkedin_url",
        value_json: linkedinUrl,
        verification_status: "verified",
        source_note: "user_onboarding",
        verified_at: now,
        updated_at: now,
      }, { onConflict: "profile_id,fact_key" });
      if (error) throw error;
    }

    const sourceQuery = supabase
      .from("candidate_source_documents")
      .select("id,original_name,source_type,storage_object_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at,updated_at")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: false });
    const [factsResult, sourcesResult] = await Promise.all([
      supabase.from("candidate_facts").select("fact_key,value_json,verification_status").eq("profile_id", profile.id).order("fact_key"),
      sourceQuery,
    ]);
    const queryError = [factsResult, sourcesResult].find((result) => result.error)?.error;
    if (queryError) throw queryError;

    const linkedInFact = (factsResult.data || []).find((fact: any) => fact.fact_key === "linkedin_url" || fact.fact_key === "linkedin");
    const storedLinkedInUrl = typeof linkedInFact?.value_json === "string" ? linkedInFact.value_json : "";
    const sourceDocuments = (sourcesResult.data || []).filter((source: any) => source.source_type !== "chatgpt_memory");
    if (!sourceDocuments.length && !(linkedinUrl || storedLinkedInUrl)) {
      throw new Error("Add a CV, document, LinkedIn profile URL or additional information before building the profile.");
    }
    if (expectedBundleRevision) {
      const additionalSource = sourceDocuments.find((source: any) => source.source_type === "user_description");
      const additionalInformation = typeof additionalSource?.extracted_text === "string" ? additionalSource.extracted_text : "";
      const revision = sourceBundleDigest({
        // `user_description` is represented by the separate editable text
        // value in the source bundle. The source-save and state endpoints
        // deliberately exclude that document row from their digest and add
        // its text once, so do the same here or a freshly saved bundle will
        // appear to have changed when Memory consent resumes the build.
        documents: sourceDocuments.filter((source: any) => source.source_type !== "user_description"),
        linkedinUrl: linkedinUrl || storedLinkedInUrl,
        additionalInformation,
      });
      if (revision !== expectedBundleRevision) throw new Error("SOURCE_BUNDLE_CONFLICT");
    }
    let queued = { dispatches: [] as any[], sourceTasks: [] as any[], summaryDispatch: null as any };
    if (!refreshOnly && allowMemoryUpdate) {
      operationId = await beginChatGptOperation(supabase, "Build professional profile with ChatGPT");
      queued = await queueProfessionalBackgroundImport({
        supabase,
        userId: profile.user_id,
        profileId: profile.id,
        displayName: profile.display_name,
        sourceDocuments,
        linkedinUrl: linkedinUrl || storedLinkedInUrl,
        allowMemoryUpdate,
        includeJsonProfile: allowMemoryUpdate,
      });
      const dispatchIds = queued.dispatches.map((item: any) => typeof item?.id === "string" ? item.id : "");
      if (dispatchIds.length) {
        await trackChatGptOperation(supabase, operationId, dispatchIds);
        operationTracked = true;
      }
    }
    const dispatches = queued.dispatches;
    const bundleSourceCount = sourceDocuments.length + (linkedinUrl || storedLinkedInUrl ? 1 : 0);

    if (queued.summaryDispatch?.id) {
      const { error: settingsError } = await supabase.from("candidate_chatgpt_memory").update({
        memory_import_status: "queued",
        memory_import_dispatch_id: queued.summaryDispatch.id,
        memory_import_requested_at: now,
        memory_import_completed_at: null,
        memory_import_error: null,
        memory_import_questions: [],
        updated_at: now,
      }).eq("profile_id", profile.id);
      if (settingsError) throw settingsError;
    }

    const bridgeHints = dispatches.map((dispatch) => ({
      version: 1 as const,
      type: "JOBHUNT_DISPATCH_HINT" as const,
      request_id: dispatch?.id,
      correlation_id: dispatch?.correlation_id || dispatch?.id,
      nonce: crypto.randomUUID(),
    }));
    const firstQueuedIndex = dispatches.findIndex((item) => ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready"].includes(String(item?.state || "")));
    const firstHint = bridgeHints[firstQueuedIndex >= 0 ? firstQueuedIndex : 0];
    const dispatch = queued.summaryDispatch || dispatches[dispatches.length - 1] || null;
    return NextResponse.json({
      ok: true,
      dispatch,
      dispatches,
      linkedinUrl: linkedinUrl || null,
      sourceCount: bundleSourceCount,
      profileImportQueued: Boolean(queued.summaryDispatch),
      bridge_hint: firstHint,
      bridge_hints: bridgeHints,
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to send the professional background." }, { status: statusCode(error) });
  } finally {
    if (operationClient && operationId && !operationTracked) {
      try { await releaseChatGptOperation(operationClient, operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}
