import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const RESET_CONFIRMATION = "RESET ONBOARDING DATA";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return String((error as { message: string }).message);
  }
  return "Unable to reset the onboarding data.";
}

async function deleteProfileRows(supabase: any, table: string, profileId: string) {
  const { error } = await supabase.from(table).delete().eq("profile_id", profileId);
  if (error) throw new Error(`Could not clear ${table}: ${error.message || "database error"}`);
}

async function memoryDispatchIds(supabase: any, profileId: string) {
  // The dispatch queue deliberately has no direct client SELECT policy. The
  // onboarding memory row is the user-owned index for the profile import and
  // incremental source updates, so resolve only those ids through the
  // ownership-checked dispatch RPC before deleting the index itself.
  const { data: memory, error: memoryError } = await supabase
    .from("candidate_chatgpt_memory")
    .select("memory_import_dispatch_id,memory_update_dispatch_ids")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (memoryError) throw memoryError;

  const ids = new Set<string>();
  if (typeof memory?.memory_import_dispatch_id === "string" && memory.memory_import_dispatch_id) {
    ids.add(memory.memory_import_dispatch_id);
  }
  if (Array.isArray(memory?.memory_update_dispatch_ids)) {
    for (const id of memory.memory_update_dispatch_ids) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }

  return [...ids];
}

async function cancelMemoryDispatchesForReset(supabase: any, profileId: string) {
  const ids = await memoryDispatchIds(supabase, profileId);
  if (!ids.length) return;

  // Migration 0098 expands this existing ownership-checked RPC to sent and
  // result-pending rows. It changes only JobHuntAI dispatch state, so the
  // already-visible ChatGPT conversation is never edited or deleted.
  for (const id of ids) {
    const { error: cancelError } = await supabase.rpc("cancel_chatgpt_dispatch_request", { p_request_id: id });
    if (cancelError) throw cancelError;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (body.confirmation !== RESET_CONFIRMATION) {
      throw new Error(`Type ${RESET_CONFIRMATION} exactly to confirm the final reset.`);
    }

    const { supabase, profile } = await requireProfile();
    // Abandon every indexed profile/background request before deleting the
    // onboarding memory row. The reset RPC also handles sent/result-pending
    // rows, clears their lease, and leaves ChatGPT conversation history alone;
    // the extension will reconcile the terminal state on its next poll.
    await cancelMemoryDispatchesForReset(supabase, profile.id);
    const { data: documents, error: documentReadError } = await supabase
      .from("candidate_source_documents")
      .select("storage_object_key")
      .eq("profile_id", profile.id);
    if (documentReadError) throw documentReadError;

    const storageKeys = (documents || [])
      .map((document: { storage_object_key?: unknown }) => document.storage_object_key)
      .filter((key: unknown): key is string => typeof key === "string" && Boolean(key.trim()));
    if (storageKeys.length) {
      const { error } = await supabase.storage.from("candidate-source-documents").remove(storageKeys);
      if (error) throw new Error(`Could not remove uploaded onboarding files: ${error.message || "storage error"}`);
    }

    const { data: evidenceItems, error: evidenceReadError } = await supabase
      .from("evidence_items")
      .select("id")
      .eq("profile_id", profile.id);
    if (evidenceReadError) throw evidenceReadError;
    const evidenceIds = (evidenceItems || [])
      .map((item: { id?: unknown }) => item.id)
      .filter((id: unknown): id is string => typeof id === "string" && Boolean(id));
    if (evidenceIds.length) {
      const { error } = await supabase.from("document_evidence_links").delete().in("evidence_item_id", evidenceIds);
      if (error) throw new Error(`Could not clear imported evidence links: ${error.message || "database error"}`);
    }

    // Keep the account, jobs, applications, generated documents, ChatGPT
    // Project and bridge device. Clear only the profile/onboarding data shown
    // or edited on the onboarding page.
    for (const table of [
      "candidate_extraction_proposals",
      "candidate_facts",
      "candidate_employment",
      "candidate_education",
      "candidate_skills",
      "candidate_projects",
      "candidate_publications",
      "candidate_source_documents",
      "evidence_items",
      "evidence_sources",
      "candidate_cv_families",
      "reusable_answers",
      "candidate_chatgpt_memory",
      "candidate_onboarding",
    ]) {
      await deleteProfileRows(supabase, table, profile.id);
    }

    const { error: profileError } = await supabase
      .from("candidate_profiles")
      .update({ display_name: "", updated_at: new Date().toISOString() })
      .eq("id", profile.id);
    if (profileError) throw profileError;

    return NextResponse.json({ ok: true, storageFilesRemoved: storageKeys.length });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: statusCode(error) });
  }
}
