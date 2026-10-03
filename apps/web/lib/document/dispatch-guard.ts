import { createHash } from "node:crypto";
import { CHATGPT_TESTING_MODE_PREFIX } from "../chatgpt/testing-mode.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Document actions may only dispatch the exact saved Memory-only step created
 * by the durable document-generation flow. This prevents legacy UI/API callers
 * from bypassing that contract with a profile-bearing free-form prompt.
 */
export function assertMemoryOnlyDocumentDispatch(input: {
  actionType: string;
  websiteInstruction: string;
  idempotencyKey: string | undefined;
  subjectRefs: Record<string, unknown>;
  generation: Record<string, any> | null;
}) {
  const match = typeof input.idempotencyKey === "string"
    ? input.idempotencyKey.match(/^docgen-([0-9a-f-]{36}):(0|[1-9][0-9]{0,2})$/i)
    : null;
  if (!match || !UUID.test(match[1])) throw new Error("Document drafts must use the saved Memory-only generation flow.");
  const generation = input.generation;
  const chunkIndex = Number(match[2]);
  if (!generation || generation.id !== match[1] || generation.current_chunk !== chunkIndex
    || !["preparing_context", "writing"].includes(String(generation.state))) {
    throw new Error("This document step is not the current saved Memory-only request; refresh the document page before continuing.");
  }
  const applicationIds = input.subjectRefs.application_ids;
  if (!UUID.test(String(generation.application_id || "")) || !Array.isArray(applicationIds)
    || applicationIds.length !== 1 || applicationIds[0] !== generation.application_id) {
    throw new Error("The document dispatch does not match its saved application.");
  }
  const step = Array.isArray(generation.context_chunks) ? generation.context_chunks[chunkIndex] : null;
  if (!step || !["cv", "cover_letter"].includes(String(step.kind)) || !["context", "final"].includes(String(step.phase))
    || typeof step.text !== "string" || !step.text.trim() || typeof step.sha256 !== "string"
    || sha256(step.text) !== step.sha256) {
    throw new Error("The frozen document instruction is invalid; no ChatGPT message was sent.");
  }
  const expectedAction = step.kind === "cv" ? "documents.cv.create" : "documents.cover_letter.create";
  if (input.actionType !== expectedAction) throw new Error("The document type does not match the saved generation step.");
  const testingMode = generation.testing_mode === true;
  const expectedInstruction = testingMode && !step.text.startsWith(CHATGPT_TESTING_MODE_PREFIX)
    ? `${CHATGPT_TESTING_MODE_PREFIX}\n\n${step.text}`
    : step.text;
  if (input.websiteInstruction !== expectedInstruction) {
    throw new Error("Only the exact saved Memory-only document instruction may be sent; no modified prompt was dispatched.");
  }
  return { requestId: generation.id as string, chunkIndex, testingMode };
}
