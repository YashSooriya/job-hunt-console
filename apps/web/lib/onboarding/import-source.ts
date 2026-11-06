import { createHash } from "node:crypto";
import { detectDocumentFormat, extractDocumentText } from "@/lib/onboarding/document-parser";
import { parseStructuredMemoryInterview } from "@/lib/chatgpt/memory-profile";
import { applyStructuredMemoryProfile } from "@/lib/onboarding/import-chatgpt-memory";
import { extractSourceProposals } from "@/lib/onboarding/extract";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 120000;

export const SOURCE_TYPES = ["cv_upload", "previous_application", "work_sample", "user_description", "chatgpt_memory", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

type ImportSourceArgs = {
  supabase: any;
  user: { id: string };
  profile: { id: string };
  file?: File | null;
  text?: string | null;
  title?: string | null;
  sourceType?: string | null;
  maxTextChars?: number;
  proposalLimit?: number;
  replaceExisting?: boolean;
  /** Replace older sources of this type after the new source is stored. */
  replaceSourceType?: string | null;
};

type RemoveSourceArgs = {
  supabase: any;
  profileId: string;
  documentId: string;
};

function safeSourceType(value: string | null | undefined): SourceType {
  return SOURCE_TYPES.includes(value as SourceType) ? value as SourceType : "cv_upload";
}

function sourceTitle(value: string | null | undefined, fallback: string) {
  const title = typeof value === "string" ? value.trim().slice(0, 240) : "";
  return title || fallback;
}

export async function importCandidateSource(args: ImportSourceArgs) {
  const sourceType = safeSourceType(args.sourceType);
  const hasFile = args.file instanceof File;
  const replaceExisting = args.replaceExisting === true;
  const replaceSourceType = args.replaceSourceType === "user_description" ? "user_description" : null;
  if (args.replaceSourceType && !replaceSourceType) {
    throw new Error("Only additional information sources can be replaced automatically.");
  }
  if (replaceSourceType && (sourceType !== replaceSourceType || hasFile)) {
    throw new Error("Additional information replacement must use the user description source type.");
  }
  const maxTextChars = Number.isInteger(args.maxTextChars)
    ? Math.max(1000, Math.min(MAX_TEXT_CHARS, Number(args.maxTextChars)))
    : MAX_TEXT_CHARS;
  const text = typeof args.text === "string" ? args.text.trim().slice(0, maxTextChars) : "";
  if (!hasFile && !text) throw new Error("Upload at least one document or enter a description.");
  if (hasFile && args.file!.size > MAX_FILE_BYTES) throw new Error("Document files must be 10 MB or smaller.");
  if (replaceExisting && (!hasFile || !/\.json$/i.test(args.file!.name || ""))) {
    throw new Error("Reimport accepts a ChatGPT-produced .json file only.");
  }

  let bytes: Uint8Array;
  let fileName: string;
  let mimeType: string;
  let title: string;

  if (hasFile) {
    bytes = new Uint8Array(await args.file!.arrayBuffer());
    fileName = args.file!.name || "candidate-source";
    mimeType = args.file!.type || "application/octet-stream";
    title = sourceTitle(args.title, fileName);
  } else {
    bytes = new TextEncoder().encode(text);
    fileName = `${sourceTitle(args.title, "user-description").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 150) || "user-description"}.txt`;
    mimeType = "text/plain";
    title = sourceTitle(args.title, "User description");
  }

  const extractionFormat = detectDocumentFormat(fileName, mimeType);
  if (!extractionFormat) throw new Error("Supported formats are PDF, DOCX, JSON, TXT, Markdown or RTF.");
  // Chromium on Windows can report RTF as `text/rtf` or a registry-specific
  // MIME value. The private source bucket allows the canonical `application/rtf`
  // type, so normalize by the verified extension before storing the file.
  if (extractionFormat === "rtf") mimeType = "application/rtf";

  const parseStructuredResponse = replaceExisting || sourceType === "chatgpt_memory";
  let extractedText: string | null = hasFile ? null : text;
  let structuredPreview: ReturnType<typeof parseStructuredMemoryInterview> = null;
  let extractionStatus: "stored" | "extracted" | "failed" = "stored";
  let extractionError: string | null = null;
  let sourceProposals: ReturnType<typeof extractSourceProposals> = [];
  if (parseStructuredResponse) {
    const extraction = extractDocumentText(bytes, fileName, mimeType);
    if (!extraction.format || !extraction.text || extraction.error) {
      throw new Error(extraction.error || "The structured ChatGPT profile could not be read.");
    }
    extractedText = extraction.text;
    structuredPreview = parseStructuredMemoryInterview(extraction.text);
    if (!structuredPreview) {
      throw new Error("The ChatGPT response did not contain a supported structured professional profile.");
    }
    extractionStatus = "extracted";
  } else if (hasFile) {
    const extraction = extractDocumentText(bytes, fileName, mimeType);
    if (extraction.error || !extraction.text) {
      extractionStatus = "failed";
      extractionError = extraction.error || "No selectable text was found in this document.";
    } else {
      extractedText = extraction.text;
      extractionStatus = "extracted";
      sourceProposals = extractSourceProposals(extractedText);
    }
  } else if (text) {
    extractionStatus = "extracted";
    sourceProposals = extractSourceProposals(text);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Keep original filenames out of source URLs. The original display name is
  // retained as private metadata in the application.
  const storageExtension = extractionFormat === "markdown" ? "md" : extractionFormat;
  const objectKey = `${args.user.id}/onboarding/${sha256.slice(0, 32)}.${storageExtension}`;
  const { error: uploadError } = await args.supabase.storage
    .from("candidate-source-documents")
    .upload(objectKey, bytes, { contentType: mimeType, upsert: true });
  if (uploadError) throw uploadError;

  const now = new Date().toISOString();
  const { data: document, error: documentError } = await args.supabase
    .from("candidate_source_documents")
    .upsert({
      profile_id: args.profile.id,
      original_name: title,
      source_type: sourceType,
      storage_object_key: objectKey,
      mime_type: mimeType,
      byte_size: bytes.byteLength,
      sha256,
      extraction_status: extractionStatus,
      extraction_format: extractionFormat,
      extraction_error: extractionError,
      extracted_text: extractedText,
      extraction_version: parseStructuredResponse
        ? "chatgpt_structured_profile_v1"
        : hasFile
          ? "local_source_extraction_v1"
          : "user_text_source_v1",
      extracted_at: extractionStatus === "extracted" ? now : null,
      updated_at: now,
    }, { onConflict: "profile_id,sha256" })
    .select("id")
    .single();
  if (documentError || !document) throw documentError || new Error("Could not store the source document.");

  const sourceKey = `source_${sourceType}_${document.id}`;
  const { data: source, error: sourceError } = await args.supabase
    .from("evidence_sources")
    .upsert({
      profile_id: args.profile.id,
      source_key: sourceKey,
      title,
      source_type: sourceType,
      provider: "user_input",
      provider_ref: document.id,
      captured_at: now,
      metadata: {
        sha256,
        mime_type: mimeType,
        extraction_format: extractionFormat,
        source_type: sourceType,
        input_mode: hasFile
          ? extractionStatus === "extracted" ? "extracted_file" : "failed_file_extraction"
          : "user_entered_text",
      },
    }, { onConflict: "profile_id,source_key" })
    .select("id")
    .single();
  if (sourceError || !source) throw sourceError || new Error("Could not store source provenance.");

  const proposalLimit = Number.isInteger(args.proposalLimit)
    ? Math.max(1, Math.min(180, Number(args.proposalLimit)))
    : 48;
  const proposalRows = sourceProposals.slice(0, proposalLimit).map((proposal) => ({
    profile_id: args.profile.id,
    source_id: source.id,
    proposal_key: proposal.proposalKey,
    proposal_type: proposal.category,
    proposed_json: { ...proposal.proposed, detail: proposal.detail, tags: proposal.tags },
    source_locator: proposal.locator,
    verification_status: "needs_review",
    updated_at: now,
  }));
  if (proposalRows.length) {
    const { error: proposalError } = await args.supabase
      .from("candidate_extraction_proposals")
      .upsert(proposalRows, { onConflict: "profile_id,source_id,proposal_key" });
    if (proposalError) throw proposalError;
  }

  // Text entered in the Additional information field represents one editable
  // source. Store the replacement first, then remove every older copy so a
  // retry cannot leave the ChatGPT bundle with stale text or duplicate rows.
  const replacedDocumentIds: string[] = [];
  if (replaceSourceType) {
    const { data: previousDocuments, error: previousDocumentsError } = await args.supabase
      .from("candidate_source_documents")
      .select("id")
      .eq("profile_id", args.profile.id)
      .eq("source_type", replaceSourceType)
      .neq("id", document.id);
    if (previousDocumentsError) throw previousDocumentsError;
    for (const previousDocument of previousDocuments || []) {
      const previousId = String(previousDocument?.id || "").trim();
      if (!previousId) continue;
      await removeCandidateSource({
        supabase: args.supabase,
        profileId: args.profile.id,
        documentId: previousId,
      });
      replacedDocumentIds.push(previousId);
    }
  }

  const structured = structuredPreview;
  if (structured) {
    const imported = await applyStructuredMemoryProfile({
      supabase: args.supabase,
      profileId: args.profile.id,
      sourceId: source.id,
      parsed: structured,
    });
    return {
      documentId: document.id,
      sourceId: source.id,
      sourceType,
      title,
      extractionStatus: "extracted",
      extractionFormat,
      charactersExtracted: extractedText?.length || 0,
      facts: imported.facts,
      proposals: imported.proposals,
      structured: imported.structured,
      preferencesUpdated: imported.preferencesUpdated,
      replacedDocumentIds,
    };
  }

  return {
    documentId: document.id,
    sourceId: source.id,
    sourceType,
    title,
      extractionStatus,
    extractionFormat,
      extractionError,
      charactersExtracted: extractedText?.length || 0,
    bytesStored: bytes.byteLength,
    facts: 0,
      proposals: proposalRows.length,
    replacedDocumentIds,
  };
}

/**
 * Remove all Additional information sources for the current profile. Older
 * versions of the editor could create more than one text document, so this
 * deliberately removes every matching row rather than trusting a single
 * client-provided document id.
 */
export async function removeAdditionalInformationSources(args: { supabase: any; profileId: string }) {
  const { data: documents, error } = await args.supabase
    .from("candidate_source_documents")
    .select("id")
    .eq("profile_id", args.profileId)
    .eq("source_type", "user_description");
  if (error) throw error;

  const removedDocumentIds: string[] = [];
  for (const document of documents || []) {
    const documentId = String(document?.id || "").trim();
    if (!documentId) continue;
    await removeCandidateSource({
      supabase: args.supabase,
      profileId: args.profileId,
      documentId,
    });
    removedDocumentIds.push(documentId);
  }

  return {
    sourceType: "user_description" as const,
    removedDocumentIds,
    removedCount: removedDocumentIds.length,
  };
}

/**
 * Remove one source document owned by the current onboarding profile.
 *
 * A source document has a matching evidence-source row and may have
 * materialised profile records attached to that provenance row. Delete those
 * derived rows first (including the restrictive document/evidence links),
 * then remove the private storage object and source records. User-entered
 * profile rows use a null source_id and are intentionally preserved.
 */
export async function removeCandidateSource(args: RemoveSourceArgs) {
  const documentId = args.documentId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentId)) {
    throw new Error("The source document id is invalid.");
  }

  const { data: document, error: documentError } = await args.supabase
    .from("candidate_source_documents")
    .select("id,source_type,original_name,storage_object_key")
    .eq("id", documentId)
    .eq("profile_id", args.profileId)
    .maybeSingle();
  if (documentError) throw documentError;
  if (!document) throw new Error("The source document was not found in this onboarding profile.");

  const { data: evidenceSources, error: sourceError } = await args.supabase
    .from("evidence_sources")
    .select("id")
    .eq("profile_id", args.profileId)
    .eq("provider_ref", documentId);
  if (sourceError) throw sourceError;
  const sourceIds = [...new Set((evidenceSources || [])
    .map((source: { id?: unknown }) => String(source.id || ""))
    .filter(Boolean))];

  // Storage removal is deliberately attempted before the database rows are
  // deleted. Supabase treats removing an already-absent object as an
  // idempotent operation, so a retry after a transient database error remains
  // safe and the normal path never leaves a source row pointing at a removed
  // object.
  const storageKey = typeof document.storage_object_key === "string" ? document.storage_object_key.trim() : "";
  if (storageKey) {
    const { error: storageError } = await args.supabase.storage
      .from("candidate-source-documents")
      .remove([storageKey]);
    if (storageError) throw storageError;
  }

  if (sourceIds.length) {
    const { data: evidenceItems, error: evidenceItemsError } = await args.supabase
      .from("evidence_items")
      .select("id")
      .eq("profile_id", args.profileId)
      .in("source_id", sourceIds);
    if (evidenceItemsError) throw evidenceItemsError;
    const evidenceItemIds = (evidenceItems || [])
      .map((item: { id?: unknown }) => String(item.id || ""))
      .filter(Boolean);

    if (evidenceItemIds.length) {
      const { error: linksError } = await args.supabase
        .from("document_evidence_links")
        .delete()
        .in("evidence_item_id", evidenceItemIds);
      if (linksError) throw linksError;
    }

    const dependentDeletes = await Promise.all([
      args.supabase.from("candidate_extraction_proposals").delete().eq("profile_id", args.profileId).in("source_id", sourceIds),
      args.supabase.from("candidate_employment").delete().eq("profile_id", args.profileId).in("source_id", sourceIds),
      args.supabase.from("candidate_education").delete().eq("profile_id", args.profileId).in("source_id", sourceIds),
      args.supabase.from("candidate_skills").delete().eq("profile_id", args.profileId).in("source_id", sourceIds),
      args.supabase.from("candidate_projects").delete().eq("profile_id", args.profileId).in("source_id", sourceIds),
      args.supabase.from("candidate_publications").delete().eq("profile_id", args.profileId).in("source_id", sourceIds),
    ]);
    const dependentError = dependentDeletes.find((result: { error?: unknown }) => result.error)?.error;
    if (dependentError) throw dependentError;

    const { error: evidenceError } = await args.supabase
      .from("evidence_items")
      .delete()
      .eq("profile_id", args.profileId)
      .in("source_id", sourceIds);
    if (evidenceError) throw evidenceError;

    const { error: sourcesDeleteError } = await args.supabase
      .from("evidence_sources")
      .delete()
      .eq("profile_id", args.profileId)
      .in("id", sourceIds);
    if (sourcesDeleteError) throw sourcesDeleteError;
  }

  const { error: documentDeleteError } = await args.supabase
    .from("candidate_source_documents")
    .delete()
    .eq("id", documentId)
    .eq("profile_id", args.profileId);
  if (documentDeleteError) throw documentDeleteError;

  return {
    documentId,
    sourceType: document.source_type || null,
    title: document.original_name || null,
    storageRemoved: Boolean(storageKey),
  };
}

export { MAX_FILE_BYTES, MAX_TEXT_CHARS };
