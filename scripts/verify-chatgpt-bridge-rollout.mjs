#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const migration = read("database/migrations/0089_chatgpt_bridge_rollout_telemetry.sql");
const edgeFunction = read("supabase/functions/chatgpt-bridge/index.ts");
const bridgeDocs = read("docs/CHATGPT_BRIDGE.md");
const acceptanceDocs = read("docs/CHATGPT_BRIDGE_ACCEPTANCE.md");

function fail(message) {
  console.error(`ChatGPT bridge rollout verification failed: ${message}`);
  process.exit(1);
}

function must(condition, message) {
  if (!condition) fail(message);
}

must(migration.includes("chatgpt_bridge_service_get_rollout_telemetry"), "rollout telemetry RPC is missing");
must(migration.includes("overrenewed_leases"), "lease over-renewal telemetry is missing");
must(migration.includes("orphaned_send_attempted"), "send boundary telemetry is missing");
must(migration.includes("lost_result_uploads"), "result upload telemetry is missing");
must(migration.includes("v1_compatibility_can_be_removed"), "v1 retirement gate is missing");
must(migration.includes("chatgpt_bridge_audit_metadata_guard"), "bridge audit metadata guard is missing");
must(edgeFunction.includes('"get_rollout_telemetry"'), "Edge Function telemetry operation is missing");
must(bridgeDocs.includes("Rollout telemetry and v1 retirement"), "bridge rollout runbook is missing");
must(acceptanceDocs.includes("rollout telemetry"), "acceptance telemetry gate is missing");

const endpoint = process.env.CHATGPT_BRIDGE_ENDPOINT || "";
const deviceId = process.env.CHATGPT_BRIDGE_DEVICE_ID || "";
const deviceToken = process.env.CHATGPT_BRIDGE_DEVICE_TOKEN || "";
const live = process.argv.includes("--live") || Boolean(endpoint || deviceId || deviceToken);
const requireCompletion = process.argv.includes("--require-v2-completions");

if (!live) {
  console.log("ChatGPT bridge rollout static verification passed.");
  console.log("Live telemetry skipped. Set CHATGPT_BRIDGE_ENDPOINT, CHATGPT_BRIDGE_DEVICE_ID, and CHATGPT_BRIDGE_DEVICE_TOKEN, then rerun with --live.");
  process.exit(0);
}

must(endpoint && deviceId && deviceToken, "live telemetry requires CHATGPT_BRIDGE_ENDPOINT, CHATGPT_BRIDGE_DEVICE_ID, and CHATGPT_BRIDGE_DEVICE_TOKEN");
must(deviceToken.length >= 40, "live telemetry device token is too short");

const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-chatgpt-bridge-device-id": deviceId,
    "x-chatgpt-bridge-device-token": deviceToken,
    "x-chatgpt-bridge-version": "rollout-verifier",
  },
  body: JSON.stringify({ op: "get_rollout_telemetry", since }),
});
const payload = await response.json().catch(() => ({}));
must(response.ok && payload?.ok === true, payload?.error || `telemetry request returned HTTP ${response.status}`);

const telemetry = payload.telemetry || {};
const rollout = telemetry.rollout || {};
const leases = telemetry.leases || {};
const delivery = telemetry.delivery || {};
const results = telemetry.results || {};
const audit = telemetry.audit || {};

must(telemetry.healthy === true, "telemetry reported a delivery or audit invariant failure");
must(Number(leases.expired_active_leases) === 0, "an active dispatch has an expired lease and needs reconciliation");
if (requireCompletion) {
  must(Number(results.completed_v2_in_window) > 0, "no completed v2 dispatch was observed in the telemetry window");
  must(Number(results.completed_v2_in_window) === Number(results.uploaded_v2_in_window), "a completed v2 dispatch is missing a verified response upload");
}

console.log(JSON.stringify({
  healthy: telemetry.healthy === true,
  v2_devices: rollout.v2_devices ?? 0,
  v1_devices: rollout.v1_devices ?? 0,
  recent_v1_devices: rollout.recent_v1_devices ?? 0,
  overrenewed_leases: leases.overrenewed_leases ?? 0,
  expired_active_leases: leases.expired_active_leases ?? 0,
  orphaned_send_attempted: delivery.orphaned_send_attempted ?? 0,
  pending_result_uploads: results.pending_result_uploads ?? 0,
  lost_result_uploads: results.lost_result_uploads ?? 0,
  completed_v2_in_window: results.completed_v2_in_window ?? 0,
  uploaded_v2_in_window: results.uploaded_v2_in_window ?? 0,
  unsafe_bridge_events_in_window: audit.unsafe_bridge_events_in_window ?? 0,
}, null, 2));

if (Number(rollout.v1_devices) > 0) {
  console.log("V1 compatibility must remain enabled while active paired v1 devices remain.");
} else {
  console.log("No active paired v1 devices remain; v1 retirement may be reviewed after the documented observation window.");
}
