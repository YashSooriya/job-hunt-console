import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { extractCvProposals, extractSimpleFacts } from "@/lib/onboarding/extract";
import { extractDocumentText } from "@/lib/onboarding/document-parser";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Choose a CV file.");
    if (file.size > 10 * 1024 * 1024) throw new Error("CV file must be 10 MB or smaller.");

    const { supabase, user, profile } = await requireProfile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extraction = extractDocumentText(bytes, file.name, file.type);
    if (!extraction.format) throw new Error(extraction.error || "Unsupported CV format.");

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "cv";
    const objectKey = `${user.id}/onboarding/${sha256.slice(0, 16)}-${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from("candidate-source-documents")
      .upload(objectKey, bytes, { contentType: file.type || "application/octet-stream", upsert: true });
    if (uploadError) throw uploadError;

    const extractionStatus = extraction.text.length >= 40 ? "extracted" : "needs_text";
    const { data: doc, error: docError } = await supabase
      .from("candidate_source_documents")
      .upsert({
        profile_id: profile.id,
        original_name: file.name,
        storage_object_key: objectKey,
        mime_type: file.type || null,
        byte_size: file.size,
        sha256,
        extraction_status: extractionStatus,
        extraction_format: extraction.format,
        extraction_error: extraction.error,
        extracted_text: extraction.text || null,
        extraction_version: "worker_document_parser_v1",
        extracted_at: extraction.text ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "profile_id,sha256" })
      .select("id")
      .single();
    if (docError) throw docError;

    if (extraction.text.length >= 40) {
      const sourceKey = `cv_upload_${doc.id}`;
      const { data: source, error: sourceError } = await supabase
        .from("evidence_sources")
        .upsert({
          profile_id: profile.id,
          source_key: sourceKey,
          title: file.name,
          source_type: "cv_upload",
          provider: "user_upload",
          provider_ref: doc.id,
          captured_at: new Date().toISOString(),
          metadata: { sha256, mime_type: file.type || null, extraction_format: extraction.format },
        }, { onConflict: "profile_id,source_key" })
        .select("id")
        .single();
      if (sourceError) throw sourceError;

      const facts = extractSimpleFacts(extraction.text).map((fact) => ({
        profile_id: profile.id,
        fact_key: fact.key,
        value_json: fact.value,
        verification_status: "needs_review",
        source_note: sourceKey,
        verified_at: null,
        updated_at: new Date().toISOString(),
      }));
      if (facts.length) {
        const { error } = await supabase.from("candidate_facts").upsert(facts, { onConflict: "profile_id,fact_key", ignoreDuplicates: true });
        if (error) throw error;
      }

      const proposals = extractCvProposals(extraction.text).map((proposal) => ({
        profile_id: profile.id,
        source_id: source.id,
        proposal_key: proposal.proposalKey,
        proposal_type: proposal.category,
        proposed_json: {
          claim: proposal.claim,
          detail: proposal.detail,
          tags: proposal.tags,
          category: proposal.category,
        },
        source_locator: proposal.locator,
        verification_status: "needs_review",
        updated_at: new Date().toISOString(),
      }));
      if (proposals.length) {
        const { error } = await supabase.from("candidate_extraction_proposals").upsert(proposals, {
          onConflict: "profile_id,source_id,proposal_key",
          ignoreDuplicates: true,
        });
        if (error) throw error;
      }
      return NextResponse.json({
        ok: true,
        documentId: doc.id,
        extractionStatus,
        extractionFormat: extraction.format,
        charactersExtracted: extraction.text.length,
        proposals: proposals.length,
      });
    }

    return NextResponse.json({
      ok: true,
      documentId: doc.id,
      extractionStatus,
      extractionFormat: extraction.format,
      charactersExtracted: extraction.text.length,
      proposals: 0,
      warning: extraction.error || "No selectable text was found.",
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to import CV." },
      { status: statusCode(error) },
    );
  }
}
