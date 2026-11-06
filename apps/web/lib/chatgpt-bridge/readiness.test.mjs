import assert from "node:assert/strict";
import test from "node:test";
import { bridgeReadinessError, bridgeReadyForDispatch, readBridgeReadiness } from "./readiness.ts";

const readyDevice = {
  preferred: true,
  online: true,
  automatic_send_enabled: true,
  extension_version: "0.2.18",
  capabilities: {
    build_id: "0.2.18-commit-deadbeef-0123456789ab",
    protocol_version: 2,
    durable_dispatch_v2: true,
    send_authorization_v2: true,
    result_outbox_v1: true,
    concurrent_response_capture: 2,
    background_focus_policy_v2: true,
    result_completion_v3: true,
    response_provenance_v3: true,
  },
  conversations: [{ workflow_key: "profile.background", project_verified: true }],
};

const serverCapabilities = {
  result_completion_v3: true,
  response_provenance_v3: true,
};

function fakeSupabase(device = readyDevice, server = serverCapabilities) {
  return {
    rpc(name) {
      if (name === "get_chatgpt_bridge_status") return Promise.resolve({ data: { devices: [device], server_capabilities: server }, error: null });
      throw new Error(`unexpected RPC ${name}`);
    },
  };
}

test("dispatch readiness requires the paired online v3 bridge and bound profile conversation", async () => {
  const readiness = await readBridgeReadiness(fakeSupabase());
  assert.equal(bridgeReadyForDispatch(readiness), true);
  assert.equal(readiness.extensionBuildId, readyDevice.capabilities.build_id);
});

test("readiness fails closed when the bridge is offline or the server contract is incomplete", async () => {
  const offline = await readBridgeReadiness(fakeSupabase({ ...readyDevice, online: false }));
  assert.equal(bridgeReadyForDispatch(offline), false);
  assert.match(bridgeReadinessError(offline), /offline/i);

  const oldBackend = await readBridgeReadiness(fakeSupabase(readyDevice, { result_completion_v3: true }));
  assert.equal(bridgeReadyForDispatch(oldBackend), false);
  assert.match(bridgeReadinessError(oldBackend), /server is missing required capabilities/i);
});

test("readiness fails closed for a missing extension capability or build identity", async () => {
  const missingFocusPolicy = await readBridgeReadiness(fakeSupabase({
    ...readyDevice,
    capabilities: { ...readyDevice.capabilities, background_focus_policy_v2: false },
  }));
  assert.equal(bridgeReadyForDispatch(missingFocusPolicy), false);
  assert.match(bridgeReadinessError(missingFocusPolicy), /extension\.background_focus_policy_v2/);

  const missingBuild = await readBridgeReadiness(fakeSupabase({
    ...readyDevice,
    capabilities: { ...readyDevice.capabilities, build_id: undefined },
  }));
  assert.equal(bridgeReadyForDispatch(missingBuild), false);
  assert.match(bridgeReadinessError(missingBuild), /build identity/i);
});

test("a status or capability RPC failure never creates a false-ready dispatch", async () => {
  const supabase = { rpc: () => Promise.resolve({ data: null, error: new Error("RPC unavailable") }) };
  const readiness = await readBridgeReadiness(supabase);
  assert.equal(readiness, null);
  assert.equal(bridgeReadyForDispatch(readiness), false);
  assert.match(bridgeReadinessError(readiness), /could not be checked/i);
});
