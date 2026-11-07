import { createHash } from "node:crypto";
import type { DocumentKind } from "./generation-context.ts";
import { parseDocumentJsonResponse, validateDocumentResponse } from "./generation-context.ts";
import { renderApplicationDocument } from "./render.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_PROVENANCE_RECORDED = (value: unknown) => value === true || value === "true";

export function documentActionType(kind: DocumentKind) {
  return kind === "cv" ? "documents.cv.create" : "documents.cover_letter.create";
}

export function documentDispatchIdempotencyKey(requestId: string, chunkIndex: number) {
  return "docgen-" + requestId + ":" + chunkIndex;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export async function loadDocumentGeneration(supabase: any, userId: string, requestId: string) {
  if (!UUID.test(requestId)) throw new Error("A valid document generation request is required.");
  const { data, error } = await supabase.from("document_generation_requests").select("*")
    .eq("id", requestId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: items, error: itemsError } = await supabase.from("document_generation_items").select("*")
    .eq("request_id", requestId).eq("user_id", userId).order("created_at");
  if (itemsError) throw itemsError;
  return { request: data, items: (items || []) as Array<Record<string, any>> };
}

export async function getExactCompletedDispatch(supabase: any, request: Record<string, any>, dispatchId: string, chunkIndex: number) {
  if (!UUID.test(dispatchId)) throw new Error("A valid Website Bridge dispatch is required.");
  const { data, error } = await supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: dispatchId });
  if (error) throw error;
  const dispatch = asRecord(data);
  const step = Array.isArray(request.context_chunks) ? asRecord(request.context_chunks[chunkIndex]) : {};
  const kind = step.kind as DocumentKind;
  if (!UUID.test(String(dispatch.id || "")) || dispatch.id !== dispatchId
    || dispatch.action_type !== documentActionType(kind)
    || dispatch.idempotency_key !== documentDispatchIdempotencyKey(request.id, chunkIndex)
    || !Array.isArray(dispatch.subject_refs?.application_ids)
    || dispatch.subject_refs.application_ids.length !== 1
    || dispatch.subject_refs.application_ids[0] !== request.application_id) {
    throw new Error("This Bridge result does not belong to the current application-document step.");
  }
  return dispatch;
}

export function verifyExactTurn(dispatch: Record<string, any>) {
  if (dispatch.state !== "completed") return { ready: false as const, state: String(dispatch.state || "unknown") };
  const outputRefs = asRecord(dispatch.output_refs);
  if (!RESPONSE_PROVENANCE_RECORDED(outputRefs.response_provenance_recorded)
    || typeof dispatch.bridge_response !== "string"
    || typeof dispatch.bridge_response_at !== "string"
    || !dispatch.bridge_response.trim()) {
    throw new Error("The Bridge completed without a verified assistant-turn response. The document request has not been resent.");
  }
  return { ready: true as const, response: dispatch.bridge_response };
}

function parseEvidence(snapshot: Record<string, any>) {
  const profile = asRecord(snapshot.profile);
  return (Array.isArray(profile.verified_evidence) ? profile.verified_evidence : []).map((item: unknown) => {
    const value = asRecord(item);
    return {
      evidenceKey: typeof value.key === "string" ? value.key : "",
      id: typeof value.id === "string" ? value.id : undefined,
      status: value.status === "verified" ? "verified" : "needs_review",
    };
  });
}

function parseContact(snapshot: Record<string, any>) {
  const contact = asRecord(snapshot.trusted_contact);
  return Object.fromEntries(["name", "email", "phone", "location", "linkedin"].map((key) => [
    key, typeof contact[key] === "string" ? contact[key] : "",
  ])) as Record<string, string>;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function persistFinalDocument(supabase: any, userId: string, request: Record<string, any>, item: Record<string, any>, rawResponse: string) {
  const responseHash = sha256(rawResponse.trim());
  if (item.response_hash && item.response_hash !== responseHash) {
    throw new Error("A different response was already captured for this document. No response was overwritten.");
  }
  if (!item.response_hash) {
    const { error } = await supabase.rpc("record_application_document_response", {
      p_request_id: request.id,
      p_item_id: item.id,
      p_dispatch_id: request.dispatch_id,
      p_response_hash: responseHash,
      p_response_text: rawResponse,
    });
    if (error) throw error;
    item.response_hash = responseHash;
    item.response_text = rawResponse;
    item.state = "validating";
  }

  let validated: ReturnType<typeof validateDocumentResponse>;
  try {
    const parsed = parseDocumentJsonResponse(rawResponse);
    const snapshot = asRecord(request.input_snapshot);
    const job = asRecord(snapshot.job);
    validated = validateDocumentResponse(
      parsed,
      item.document_kind as DocumentKind,
      request.application_id,
      request.input_hash,
      parseEvidence(snapshot),
      typeof snapshot.cv_family === "string" ? snapshot.cv_family : "",
      { id: typeof job.id === "string" ? job.id : "", company: typeof job.company === "string" ? job.company : "", title: typeof job.title === "string" ? job.title : "" },
      parseContact(snapshot),
      snapshot.memory_only === true,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The captured ChatGPT document response could not be validated.";
    await supabase.rpc("set_application_document_generation_error", {
      p_request_id: request.id, p_item_id: item.id, p_state: "needs_user", p_error_code: "response_validation_failed", p_error_message: message,
    });
    throw new Error(message);
  }

  let rendered: Awaited<ReturnType<typeof renderApplicationDocument>>;
  try {
    rendered = await renderApplicationDocument(item.document_kind, validated.structured as Record<string, any>, request.template_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The document did not fit the required page layout.";
    await supabase.rpc("set_application_document_generation_error", {
      p_request_id: request.id, p_item_id: item.id, p_state: "needs_user",
      p_error_code: "page_layout_validation_failed", p_error_message: message,
    });
    throw new Error(message);
  }
  const versionContent = {
    ...(validated.structured as Record<string, any>),
    document_template_id: request.template_id,
  };
  const { data: versionResult, error: versionError } = await supabase.rpc("create_application_document_version", {
    p_item_id: item.id,
    p_structured_content: versionContent,
    p_evidence_links: validated.evidenceLinks.map((link) => ({ claim_key: link.claimKey, evidence_id: link.evidenceId })),
    p_plaintext: validated.plaintext || "",
    p_quality_report: rendered.quality,
  });
  if (versionError) throw versionError;
  const version = asRecord(versionResult);
  const versionId = typeof version.document_version_id === "string" ? version.document_version_id : "";
  if (!UUID.test(versionId)) throw new Error("The database did not return a valid document version. The captured ChatGPT response remains saved and will not be resent.");

  const pdfKey = userId + "/" + request.application_id + "/" + versionId + "/" + item.document_kind + ".pdf";
  const docxKey = userId + "/" + request.application_id + "/" + versionId + "/" + item.document_kind + ".docx";
  const storage = supabase.storage.from("application-documents");
  const [pdfUpload, docxUpload] = await Promise.all([
    storage.upload(pdfKey, rendered.pdf, { contentType: "application/pdf", upsert: true }),
    storage.upload(docxKey, rendered.docx, { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: true }),
  ]);
  if (pdfUpload.error) throw pdfUpload.error;
  if (docxUpload.error) throw docxUpload.error;

  const [pdfStored, docxStored] = await Promise.all([storage.download(pdfKey), storage.download(docxKey)]);
  if (pdfStored.error) throw pdfStored.error;
  if (docxStored.error) throw docxStored.error;
  const [pdfBytes, docxBytes] = await Promise.all([pdfStored.data.arrayBuffer(), docxStored.data.arrayBuffer()]);
  const pdfHash = createHash("sha256").update(new Uint8Array(pdfBytes)).digest("hex");
  const docxHash = createHash("sha256").update(new Uint8Array(docxBytes)).digest("hex");
  const expectedPdfHash = createHash("sha256").update(new Uint8Array(rendered.pdf)).digest("hex");
  const expectedDocxHash = createHash("sha256").update(new Uint8Array(rendered.docx)).digest("hex");
  if (pdfHash !== expectedPdfHash) {
    throw new Error("The saved PDF could not be verified. The original ChatGPT response remains saved; retry document saving.");
  }
  if (docxHash !== expectedDocxHash) {
    throw new Error("The saved Word document could not be verified. The original ChatGPT response remains saved; retry document saving.");
  }

  const { data: finalized, error: finalizeError } = await supabase.rpc("finalize_application_document_item", {
    p_item_id: item.id,
    p_version_id: versionId,
    p_pdf_key: pdfKey,
    p_docx_key: docxKey,
    p_pdf_sha256: pdfHash,
    p_docx_sha256: docxHash,
    p_plaintext: validated.plaintext || "",
    p_structured_content: versionContent,
    p_quality_report: rendered.quality,
  });
  if (finalizeError) throw finalizeError;

  return {
    itemId: item.id, versionId,
    quality: rendered.quality,
    finalized: asRecord(finalized),
  };
}

export async function advanceDocumentGeneration(
  supabase: any,
  userId: string,
  request: Record<string, any>,
  items: Array<Record<string, any>>,
  chunkIndex: number,
  dispatchId: string,
) {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error("A valid document-generation step is required.");
  if (chunkIndex > request.current_chunk) {
    throw new Error("The document-generation step is not current. Refresh this page before continuing.");
  }
  if (chunkIndex < request.current_chunk) {
    if (request.last_completed_dispatch_id === dispatchId) return { ok: true, idempotent: true, state: request.state };
    throw new Error("This document-generation step has already moved on.");
  }
  const chunks = Array.isArray(request.context_chunks) ? request.context_chunks : [];
  const step = asRecord(chunks[chunkIndex]);
  if (!step.kind || !["cv", "cover_letter"].includes(step.kind) || !["context", "final"].includes(step.phase)) {
    throw new Error("The saved document-generation step is invalid.");
  }
  const dispatch = await getExactCompletedDispatch(supabase, request, dispatchId, chunkIndex);
  if (request.dispatch_id && request.dispatch_id !== dispatchId) throw new Error("A different Bridge dispatch is already attached to this document step.");
  if (!request.dispatch_id) {
    const { data: linked, error: linkError } = await supabase.rpc("record_application_document_dispatch", {
      p_request_id: request.id, p_expected_chunk: chunkIndex, p_dispatch_id: dispatchId,
    });
    if (linkError) throw linkError;
    if (linked !== true) throw new Error("The Bridge dispatch could not be attached to the current document step.");
    request.dispatch_id = dispatchId;
  }
  let delivery: ReturnType<typeof verifyExactTurn>;
  try {
    delivery = verifyExactTurn(dispatch);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Website Bridge response could not be verified.";
    const item = step.phase === "final" ? items.find((candidate) => candidate.document_kind === step.kind) : null;
    await supabase.rpc("set_application_document_generation_error", {
      p_request_id: request.id, p_item_id: item?.id || null, p_state: "needs_user",
      p_error_code: "bridge_provenance_missing", p_error_message: message,
    });
    throw error;
  }
  if (!delivery.ready) {
    const terminal = ["failed", "expired", "cancelled", "user_required"].includes(delivery.state);
    const canRetryWithoutSend = dispatch.retry_allowed === true && dispatch.send_attempted_at == null && dispatch.sent_at == null;
    if (terminal && !canRetryWithoutSend) {
      const rawError = JSON.stringify(dispatch.error || dispatch.last_error || "");
      const contextLimit = /context.{0,30}(?:limit|length|window)|conversation.{0,40}(?:too long|limit|full)|maximum.{0,30}(?:tokens|length)|start a new chat/i.test(rawError);
      const workflow = step.kind === "cv" ? "CV drafting" : "cover-letter drafting";
      const message = contextLimit
        ? "The bound ChatGPT " + workflow + " conversation appears to have reached its context limit. This failed result was not resent. In the extension popup, select " + workflow + " and choose “Create fresh selected chat”, then start a new document request here; the full instructions and frozen inputs will be set up again."
        : "The Website Bridge stopped before returning a verifiable document response. No ChatGPT message was resent. Resolve the Bridge issue, then start a new document request here.";
      const item = step.phase === "final" ? items.find((candidate) => candidate.document_kind === step.kind) : null;
      await supabase.rpc("set_application_document_generation_error", {
        p_request_id: request.id, p_item_id: item?.id || null, p_state: "needs_user",
        p_error_code: contextLimit ? "conversation_context_limit" : "bridge_result_unavailable", p_error_message: message,
      });
      return { ok: true, needsUser: true, error: message, state: delivery.state };
    }
    return { ok: true, waiting: true, state: delivery.state, dispatchId };
  }

  if (step.phase === "context") {
    if (!/^context received[!. ]*$/i.test(delivery.response.trim())) {
      const message = "ChatGPT did not confirm this setup message exactly. The assistant reply is saved; no message was resent. Start a fresh document request to try again.";
      await supabase.rpc("set_application_document_generation_error", {
        p_request_id: request.id, p_item_id: null, p_state: "needs_user", p_error_code: "context_acknowledgement_invalid", p_error_message: message,
      });
      throw new Error(message);
    }
    const { data, error } = await supabase.rpc("capture_application_document_context", {
      p_request_id: request.id, p_expected_chunk: chunkIndex, p_dispatch_id: dispatchId, p_response_text: delivery.response,
    });
    if (error) throw error;
    return { ok: true, capturedContext: true, result: data };
  }

  const item = items.find((candidate) => candidate.document_kind === step.kind);
  if (!item) throw new Error("The requested document item is missing.");
  const result = await persistFinalDocument(supabase, userId, request, item, delivery.response);

  // The document is already safely committed in private Supabase Storage before
  // Drive publication begins. A Drive permission or network error never loses
  // the downloadable version or forces a second ChatGPT response.
  try {
    const { publishApplicationDocumentItem } = await import("./google-drive");
    await publishApplicationDocumentItem(supabase, userId, item.id);
  } catch {
    // Publication state and retry UI are handled by the Drive helper.
  }
  return { ok: true, capturedDocument: true, ...result };
}
