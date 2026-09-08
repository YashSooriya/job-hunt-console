import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeBuildState,
  dispatchDiagnostics,
  hasMonotonicLifecycleSequence,
  lifecycleStatus,
} from "./lifecycle.ts";

const id = "11111111-1111-4111-8111-111111111111";
const currentBridge = { extensionVersion: "0.2.7", extensionBuildId: "0.2.7-build-1", online: true };

test("successful lifecycle markers are monotonic and diagnostics project only safe fields", () => {
  const raw = {
    id,
    state: "completed",
    website_instruction: "secret prompt",
    manual_instruction: "secret prompt",
    bridge_response: "secret response",
    progress: {
      lifecycle: {
        browser_hint_emitted_at: "2026-09-07T15:00:00.000Z",
        extension_hint_received_at: "2026-09-07T15:00:00.100Z",
        server_claimed_at: "2026-09-07T15:00:00.200Z",
        response_uploaded_at: "2026-09-07T15:00:01.000Z",
        recovery_phase: "terminal",
      },
      instruction: "secret prompt",
      token: "secret token",
    },
  };
  const diagnostics = dispatchDiagnostics(raw);
  assert.equal(hasMonotonicLifecycleSequence(diagnostics.lifecycle), true);
  assert.deepEqual(Object.keys(diagnostics.lifecycle).sort(), [
    "browser_hint_emitted_at",
    "extension_hint_received_at",
    "recovery_phase",
    "response_uploaded_at",
    "server_claimed_at",
  ].sort());
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
  assert.equal(JSON.stringify(diagnostics).includes("token"), false);
});

test("lifecycle status separates extension transport, recovery, generation, and upload", () => {
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "queued" }), currentBridge), "Waiting for extension");
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "opening_chatgpt", progress: { lifecycle: { recovery_phase: "recovering_stale_chatgpt_tab" } } }), currentBridge), "Recovering stale ChatGPT tab");
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "sent", send_attempted_at: "2026-09-07T15:00:00.000Z" }), currentBridge), "Message sent; waiting for ChatGPT");
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "sent", send_attempted_at: "2026-09-07T15:00:00.000Z", progress: { lifecycle: { response_detected_at: "2026-09-07T15:00:01.000Z" } } }), currentBridge), "Response captured; retrying upload");
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "completed", progress: { lifecycle: { response_detected_at: "2026-09-07T15:00:01.000Z" } } }), currentBridge), "Completed");
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "opening_chatgpt", error: { code: "content_script_unavailable" } }), currentBridge), "Bridge transport failed; retrying");
  assert.equal(bridgeBuildState({ extensionVersion: "0.2.2", extensionBuildId: "old", online: true }), "outdated");
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "queued" }), { extensionVersion: "0.2.2", extensionBuildId: "old" }), "Extension build is outdated");
});

test("manual retry is allowed only when the server says no send boundary was crossed", () => {
  assert.equal(dispatchDiagnostics({ id, state: "user_required", retry_allowed: true }).retryAllowed, true);
  assert.equal(dispatchDiagnostics({ id, state: "user_required", retry_allowed: true, send_attempted_at: "2026-09-07T15:00:00.000Z" }).retryAllowed, false);
  assert.equal(dispatchDiagnostics({ id, state: "user_required", retry_allowed: true, sent_at: "2026-09-07T15:00:00.000Z" }).retryAllowed, false);
});
