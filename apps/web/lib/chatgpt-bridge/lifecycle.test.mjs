import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BRIDGE_REQUIRED_EXTENSION_CAPABILITIES,
  bridgeCapabilityGaps,
  bridgeCompatibilityMessage,
  bridgeBuildState,
  bridgeConnectionLabel,
  bridgeConnectionState,
  dispatchDiagnostics,
  hasMonotonicLifecycleSequence,
  lifecycleStatus,
  visibleRecoveryPhase,
} from "./lifecycle.ts";

const id = "11111111-1111-4111-8111-111111111111";
const currentBridge = { extensionVersion: "0.2.18", extensionBuildId: "0.2.18-build-1", extensionCapabilities: { ...BRIDGE_REQUIRED_EXTENSION_CAPABILITIES, build_id: "0.2.18-build-1" }, serverCapabilities: { result_completion_v3: true, response_provenance_v3: true }, online: true };

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
  assert.equal(bridgeBuildState(currentBridge), "current");
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "queued" }), { extensionVersion: "0.2.2", extensionBuildId: "old" }), "Bridge compatibility issue");
});

test("completed dispatches do not display a stale result-pending recovery phase", () => {
  const completed = dispatchDiagnostics({ state: "completed", progress: { lifecycle: { recovery_phase: "result_pending" } } });
  assert.equal(lifecycleStatus(completed, currentBridge), "Completed");
  assert.equal(visibleRecoveryPhase(completed), null);

  const uploading = dispatchDiagnostics({ state: "running", progress: { lifecycle: { recovery_phase: "result_pending" } } });
  assert.equal(visibleRecoveryPhase(uploading), "result_pending");
});

test("manual retry is allowed only when the server says no send boundary was crossed", () => {
  assert.equal(dispatchDiagnostics({ id, state: "user_required", retry_allowed: true }).retryAllowed, true);
  assert.equal(dispatchDiagnostics({ id, state: "user_required", retry_allowed: true, send_attempted_at: "2026-09-07T15:00:00.000Z" }).retryAllowed, false);
  assert.equal(dispatchDiagnostics({ id, state: "user_required", retry_allowed: true, sent_at: "2026-09-07T15:00:00.000Z" }).retryAllowed, false);
});

test("diagnostics distinguishes missing, unpaired, mismatched, and live local bridges", () => {
  const local = { available: true, paired: true, deviceId: "11111111-1111-4111-8111-111111111111", extensionVersion: "0.2.18", extensionBuildId: "0.2.18-build" };
  const compatibleServer = {
    serverDeviceId: local.deviceId,
    extensionVersion: "0.2.18",
    extensionBuildId: local.extensionBuildId,
    extensionCapabilities: { ...BRIDGE_REQUIRED_EXTENSION_CAPABILITIES, build_id: local.extensionBuildId },
    serverCapabilities: { result_completion_v3: true, response_provenance_v3: true },
    online: true,
  };
  assert.equal(bridgeConnectionState(null, null), "extension_missing");
  assert.equal(bridgeConnectionState({ serverDeviceId: local.deviceId, extensionVersion: "0.2.18", extensionBuildId: "stale-server-build", online: true }, { available: false }), "extension_missing");
  assert.equal(bridgeConnectionState(null, { available: true, paired: false }), "not_paired");
  assert.equal(bridgeConnectionState({ serverDeviceId: "22222222-2222-4222-8222-222222222222", online: true }, local), "device_mismatch");
  assert.equal(bridgeConnectionState(compatibleServer, local), "online");
  assert.equal(bridgeConnectionLabel("device_mismatch"), "Different device paired");

  const missingCapability = {
    ...compatibleServer,
    extensionCapabilities: { ...compatibleServer.extensionCapabilities, response_provenance_v3: false },
  };
  assert.equal(bridgeConnectionState(missingCapability, local), "outdated");
  assert.match(bridgeCompatibilityMessage(missingCapability, local), /extension\.response_provenance_v3/);
  assert.deepEqual(bridgeCapabilityGaps(compatibleServer.extensionCapabilities, compatibleServer.serverCapabilities), []);
  assert.equal(bridgeConnectionState({ ...compatibleServer, online: false }, local), "offline");
  assert.equal(bridgeConnectionState({ ...compatibleServer, extensionBuildId: "other-build" }, local), "outdated");
  assert.equal(bridgeConnectionLabel("outdated"), "Bridge incompatible");
  const serverGap = { ...compatibleServer, serverCapabilities: { result_completion_v3: true } };
  assert.equal(bridgeConnectionState(serverGap, local), "outdated");
  assert.match(bridgeCompatibilityMessage(serverGap, local), /server\.response_provenance_v3.*server needs a deployment/i);
  assert.equal(lifecycleStatus(dispatchDiagnostics({ state: "queued" }), serverGap, local), "Bridge compatibility issue");
  assert.equal(bridgeConnectionState({ ...compatibleServer, extensionVersion: "0.2.19" }, local), "outdated");
});

test("the frontend capability contract stays aligned with the extension and Bridge backend", () => {
  const extensionSource = readFileSync(new URL("../../../../apps/chatgpt-bridge-extension/src/shared/protocol.ts", import.meta.url), "utf8");
  const edgeSource = readFileSync(new URL("../../../../supabase/functions/chatgpt-bridge/index.ts", import.meta.url), "utf8");
  const readinessSource = readFileSync(new URL("./readiness.ts", import.meta.url), "utf8");
  const extensionAdvertisement = extensionSource.match(/export const BRIDGE_CAPABILITIES = \{([\s\S]*?)\} as const/)?.[1] || "";
  const serverV2Requirements = edgeSource.match(/const V2_CAPABILITY_NAMES = \[([\s\S]*?)\] as const/)?.[1] || "";
  const serverV3Requirements = edgeSource.match(/function supportsResultCompletionV3Device\([\s\S]*?\n\}/)?.[0] || "";
  const serverV3Advertisement = edgeSource.match(/const SERVER_CAPABILITIES = \{([\s\S]*?)\} as const/)?.[1] || "";

  for (const name of Object.keys(BRIDGE_REQUIRED_EXTENSION_CAPABILITIES)) {
    assert.ok(extensionAdvertisement.includes(name), `extension must advertise ${name}`);
  }
  for (const name of ["durable_dispatch_v2", "send_authorization_v2", "result_outbox_v1"]) {
    assert.ok(serverV2Requirements.includes(name), `Bridge backend must require ${name}`);
  }
  assert.match(edgeSource, /Number\(capabilities\.protocol_version\)\s*>=\s*2/);
  assert.match(edgeSource, /Number\(capabilities\.concurrent_response_capture\)\s*>=\s*2/);
  assert.match(serverV3Requirements, /capabilities\.result_completion_v3\s*===\s*true/);
  assert.match(serverV3Requirements, /capabilities\.response_provenance_v3\s*===\s*true/);
  assert.ok(serverV3Advertisement.includes("result_completion_v3"));
  assert.ok(serverV3Advertisement.includes("response_provenance_v3"));
  assert.match(readinessSource, /capabilities\.background_focus_policy_v2\s*===\s*true/);
});
