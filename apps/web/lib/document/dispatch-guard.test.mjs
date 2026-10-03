import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertMemoryOnlyDocumentDispatch } from "./dispatch-guard.ts";
import { CHATGPT_TESTING_MODE_PREFIX } from "../chatgpt/testing-mode.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const source = "Use only ChatGPT Memory for candidate background. Public job URL: https://example.com/job";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function generation(overrides = {}) {
  return {
    id: requestId,
    application_id: applicationId,
    current_chunk: 0,
    state: "preparing_context",
    testing_mode: true,
    context_chunks: [{ kind: "cv", phase: "context", text: source, sha256: sha256(source) }],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    actionType: "documents.cv.create",
    websiteInstruction: `${CHATGPT_TESTING_MODE_PREFIX}\n\n${source}`,
    idempotencyKey: `docgen-${requestId}:0`,
    subjectRefs: { application_ids: [applicationId] },
    generation: generation(),
    ...overrides,
  };
}

test("only the exact saved Memory-only document step is dispatchable", () => {
  assert.deepEqual(assertMemoryOnlyDocumentDispatch(input()), { requestId, chunkIndex: 0, testingMode: true });
  assert.throws(() => assertMemoryOnlyDocumentDispatch(input({ websiteInstruction: `${source}\nCandidate profile: private facts` })), /exact saved Memory-only/);
  assert.throws(() => assertMemoryOnlyDocumentDispatch(input({ subjectRefs: { application_ids: [requestId] } })), /saved application/);
  assert.throws(() => assertMemoryOnlyDocumentDispatch(input({ actionType: "documents.cover_letter.create" })), /document type/);
  assert.throws(() => assertMemoryOnlyDocumentDispatch(input({ idempotencyKey: undefined })), /saved Memory-only generation flow/);
  assert.throws(() => assertMemoryOnlyDocumentDispatch(input({ generation: generation({ current_chunk: 1 }) })), /not the current saved/);
  assert.throws(() => assertMemoryOnlyDocumentDispatch(input({ generation: generation({ context_chunks: [{ ...generation().context_chunks[0], sha256: "0".repeat(64) }] }) })), /frozen document instruction is invalid/);
});

test("the saved Testing Mode choice, not a later global toggle, controls the exact prefix", () => {
  const regular = generation({ testing_mode: false });
  assert.deepEqual(assertMemoryOnlyDocumentDispatch(input({ generation: regular, websiteInstruction: source })), { requestId, chunkIndex: 0, testingMode: false });
  assert.throws(() => assertMemoryOnlyDocumentDispatch(input({ generation: regular })), /exact saved Memory-only/);
});
