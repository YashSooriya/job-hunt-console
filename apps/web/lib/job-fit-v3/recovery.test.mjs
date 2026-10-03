import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponseRecoveryCandidate, RESPONSE_RECOVERY_STATUSES } from "./recovery.ts";

const candidate = {
  task_id: "10000000-0000-4000-8000-000000000001",
  batch_id: "20000000-0000-4000-8000-000000000002",
  job_id: "30000000-0000-4000-8000-000000000003",
  dispatch_id: "40000000-0000-4000-8000-000000000004",
  status: "eligible",
  reason_code: null,
  retry_after_seconds: 0,
};

test("recovery RPC accepts each documented status and clamps retry duration", () => {
  assert.deepEqual(RESPONSE_RECOVERY_STATUSES, ["eligible", "cooldown", "active_check", "captured", "exhausted", "ineligible"]);
  for (const status of RESPONSE_RECOVERY_STATUSES) {
    const value = normalizeResponseRecoveryCandidate({ ...candidate, status, retry_after_seconds: 86401 });
    assert.equal(value?.status, status);
    assert.equal(value?.retry_after_seconds, 86400);
  }
  assert.equal(normalizeResponseRecoveryCandidate({ ...candidate, status: "future_status" })?.status, "ineligible");
  assert.equal(normalizeResponseRecoveryCandidate({ ...candidate, retry_after_seconds: -2 })?.retry_after_seconds, 0);
});

test("recovery RPC rejects malformed owner/task identity instead of surfacing or acting on it", () => {
  assert.equal(normalizeResponseRecoveryCandidate(null), null);
  assert.equal(normalizeResponseRecoveryCandidate({ ...candidate, task_id: "not-a-uuid" }), null);
  assert.equal(normalizeResponseRecoveryCandidate({ ...candidate, dispatch_id: "not-a-uuid" }), null);
  assert.equal(normalizeResponseRecoveryCandidate({ ...candidate, job_id: null }), null);
});
