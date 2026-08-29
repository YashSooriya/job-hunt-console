import { NextResponse } from "next/server";
import { queueProfessionalBackgroundImport } from "@/lib/chatgpt/professional-background-dispatch";
import { requireProfile, statusCode, text } from "@/lib/onboarding/server";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normaliseLinkedInUrl(value: unknown) {
  const raw = text(value, 2000);
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid LinkedIn profile URL."); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) || !/^\/in\/[^/]+/i.test(url.pathname)) {
    throw new Error("Enter a public LinkedIn profile URL such as https://www.linkedin.com/in/your-name.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const linkedinUrl = normaliseLinkedInUrl(body.linkedinUrl);
    const sourceDocumentIds = Array.isArray(body.sourceDocumentIds)
      ? body.sourceDocumentIds.filter(isUuid).slice(0, 20)
      : [];
    const refreshOnly = body.refreshOnly === true;
    const { supabase, profile } = await requireProfile();
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

    if (linkedinUrl) {
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
      .select("id,original_name,source_type,storage_object_key,mime_type,byte_size,sha256,extraction_status,created_at,updated_at")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: false });
    const [factsResult, sourcesResult] = await Promise.all([
      supabase.from("candidate_facts").select("fact_key,value_json,verification_status").eq("profile_id", profile.id).order("fact_key"),
      refreshOnly
        ? sourceQuery.eq("id", "00000000-0000-0000-0000-000000000000")
        : sourceDocumentIds.length ? sourceQuery.in("id", sourceDocumentIds) : sourceQuery,
    ]);
    const queryError = [factsResult, sourcesResult].find((result) => result.error)?.error;
    if (queryError) throw queryError;

    const linkedInFact = (factsResult.data || []).find((fact: any) => fact.fact_key === "linkedin_url");
    const storedLinkedInUrl = typeof linkedInFact?.value_json === "string" ? linkedInFact.value_json : "";
    const queued = refreshOnly || !allowMemoryUpdate
      ? { dispatches: [], sourceTasks: [], summaryDispatch: null }
      : await queueProfessionalBackgroundImport({
        supabase,
        profileId: profile.id,
        displayName: profile.display_name,
        sourceDocuments: sourcesResult.data || [],
        linkedinUrl: linkedinUrl || storedLinkedInUrl,
        allowMemoryUpdate,
        includeJsonProfile: allowMemoryUpdate,
      });
    const dispatches = queued.dispatches;

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
      sourceCount: (sourcesResult.data || []).length,
      profileImportQueued: Boolean(queued.summaryDispatch),
      bridge_hint: firstHint,
      bridge_hints: bridgeHints,
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to send the professional background." }, { status: statusCode(error) });
  }
}
