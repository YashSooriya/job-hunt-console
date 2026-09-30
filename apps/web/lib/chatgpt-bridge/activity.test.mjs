import assert from "node:assert/strict";
import test from "node:test";
import { isWaitingForChatGpt } from "./activity.ts";

test("spinner is hidden before send and only starts while a dispatched message waits for ChatGPT", () => {
  for (const state of ["queued", "claimed_by_extension", "opening_chatgpt", "composer_ready", "send_attempted"]) {
    assert.equal(isWaitingForChatGpt({ state }), false, `${state} should not display the ChatGPT waiting spinner`);
  }
  for (const state of ["sent", "acknowledged_by_mcp", "running"]) {
    assert.equal(isWaitingForChatGpt({ state }), true, `${state} should display the ChatGPT waiting spinner`);
  }
});

test("spinner stops when an assistant answer is captured or its upload is pending", () => {
  assert.equal(isWaitingForChatGpt({ state: "running", raw: { progress: { stage: "result_pending" } } }), false);
  assert.equal(isWaitingForChatGpt({ state: "running", raw: { progress: { stage: "result_upload_pending" } } }), false);
  assert.equal(isWaitingForChatGpt({ state: "running", raw: { progress: { answer_captured: true } } }), false);
  assert.equal(isWaitingForChatGpt({ state: "running", raw: { progress: { lifecycle: { response_detected_at: "2026-09-26T10:00:00Z" } } } }), false);
  assert.equal(isWaitingForChatGpt({ state: "running", raw: { progress: { lifecycle: { response_uploaded_at: "2026-09-26T10:00:00Z" } } } }), false);
});

test("empty lifecycle placeholders do not suppress a real wait", () => {
  assert.equal(isWaitingForChatGpt({
    state: "sent",
    raw: { progress: { lifecycle: { response_detected_at: null, response_uploaded_at: "" } } },
  }), true);
});
