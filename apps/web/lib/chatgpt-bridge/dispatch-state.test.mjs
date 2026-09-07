import assert from "node:assert/strict";
import test from "node:test";
import { effectiveDispatchState, isDispatchActive } from "./dispatch-state.ts";
import { DISPATCH_ACTIVE_POLL_INTERVAL_MS, DISPATCH_RETRY_DELAYS_MS, dispatchRetryDelayMs, dispatchStateLabel } from "./dispatch-state.ts";

test("an initial queued state stays active until the live poller reports a terminal state", () => {
  assert.equal(effectiveDispatchState(null, "queued"), "queued");
  assert.equal(isDispatchActive(effectiveDispatchState(null, "queued")), true);

  assert.equal(effectiveDispatchState("completed", "queued"), "completed");
  assert.equal(isDispatchActive(effectiveDispatchState("completed", "queued")), false);
});

test("every terminal dispatch state enables a subsequent submission", () => {
  for (const state of ["completed", "failed", "user_required", "expired", "cancelled"]) {
    assert.equal(isDispatchActive(state), false, state);
  }
});

test("unknown or missing states fail closed as active", () => {
  assert.equal(effectiveDispatchState(undefined, undefined), "queued");
  assert.equal(isDispatchActive(undefined), true);
  assert.equal(isDispatchActive("running"), true);
  assert.equal(isDispatchActive("send_attempted"), true);
});

test("shared dispatch polling uses the required active cadence and bounded retry schedule", () => {
  assert.equal(DISPATCH_ACTIVE_POLL_INTERVAL_MS, 2000);
  assert.deepEqual([...DISPATCH_RETRY_DELAYS_MS], [3000, 5000, 10000, 15000]);
  assert.deepEqual([1, 2, 3, 4, 5, 99].map(dispatchRetryDelayMs), [3000, 5000, 10000, 15000, 15000, 15000]);
});

test("dispatch labels expose the one-time send and result-upload phases", () => {
  assert.equal(dispatchStateLabel("send_attempted"), "Confirming delivery");
  assert.equal(dispatchStateLabel("sent"), "Waiting for ChatGPT");
  assert.equal(dispatchStateLabel("sent", { progress: { stage: "result_pending" } }), "Answer captured; saving result");
  assert.equal(dispatchStateLabel("completed", { progress: { stage: "result_pending" } }), "Completed");
});
