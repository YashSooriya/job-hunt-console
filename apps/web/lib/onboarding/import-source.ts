import { createHash } from "node:crypto";
import { extractSimpleFacts, extractSourceProposals } from "@/lib/onboarding/extract";
import { extractDocumentText } from "@/lib/onboarding/document-parser";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 120000;

export const SOURCE_TYPES = ["cv_upload", "previous_application", "work_sample", "user_description", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

type ImportSourceArgs = {
  supabase: any;
  user: { id: string };
  profile: { id: string };
  file?: File | null;
  text?: string | null;
  title?: string | null;
  sourceType?: string | null;
};

function safeSourceType(value: string | null | undefined): SourceType {
  return SOURCE_TYPES.includes(value as SourceType) ? value as SourceType : "cv_upload";
}

function safeName(value: string, fallback: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || fallback;
}

function sourceTitle(value: string | null | undefined, fallback: string) {
  const title = typeof value === "string" ? value.trim().slice(0, 240) : "";
  return title || fallback;
}

export async function importCandidateSource(args: ImportSourceArgs) {
  const sourceType = safeSourceType(args.sourceType);
  const hasFile = args.file instanceof File;
  const text = typeof args.text === "string" ? args.text.trim().slice(0, MAX_TEXT_CHARS) : "";
  if (!hasFile && !text) throw new Error("Upload at least one document or enter a description.");
  if (hasFile && args.file!.size > MAX_FILE_BYTES) throw new Error("Document files must be 10 MB or smaller.");

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

  const extraction = extractDocumentText(bytes, fileName, mimeType);
  if (!extraction.format) throw new Error(extraction.error || "Unsupported source format.");
  if (!extraction.text || extraction.text.length < (hasFile ? 40 : 20) || (hasFile && extraction.error)) {
    throw new Error(extraction.error || "The source did not contain enough selectable text to build a profile.");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `${args.user.id}/onboarding/${sha256.slice(0, 16)}-${safeName(fileName, "candidate-source")}`;
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
      extraction_status: "extracted",
      extraction_format: extraction.format,
      extraction_error: hasFile ? extraction.error : null,
      extracted_text: extraction.text,
      extraction_version: "worker_document_parser_v2",
      extracted_at: now,
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
        extraction_format: extraction.format,
        source_type: sourceType,
        input_mode: hasFile ? "file" : "text",
      },
    }, { onConflict: "profile_id,source_key" })
    .select("id")
    .single();
  if (sourceError || !source) throw sourceError || new Error("Could not store source provenance.");

  const facts = extractSimpleFacts(extraction.text).map((fact) => ({
    profile_id: args.profile.id,
    fact_key: fact.key,
    value_json: fact.value,
    verification_status: "needs_review",
    source_note: sourceKey,
    verified_at: null,
    updated_at: now,
  }));
  if (facts.length) {
    const { error } = await args.supabase.from("candidate_facts").upsert(facts, {
      onConflict: "profile_id,fact_key",
      ignoreDuplicates: true,
    });
    if (error) throw error;
  }

  const proposals = extractSourceProposals(extraction.text).map((proposal) => ({
    profile_id: args.profile.id,
    source_id: source.id,
    proposal_key: proposal.proposalKey,
    proposal_type: proposal.category,
    proposed_json: proposal.proposed,
    source_locator: proposal.locator,
    verification_status: "needs_review",
    updated_at: now,
  }));
  if (proposals.length) {
    const { error } = await args.supabase.from("candidate_extraction_proposals").upsert(proposals, {
      onConflict: "profile_id,source_id,proposal_key",
      ignoreDuplicates: true,
    });
    if (error) throw error;
  }

  return {
    documentId: document.id,
    sourceType,
    title,
    extractionStatus: "extracted",
    extractionFormat: extraction.format,
    charactersExtracted: extraction.text.length,
    facts: facts.length,
    proposals: proposals.length,
  };
}

export { MAX_FILE_BYTES, MAX_TEXT_CHARS };
