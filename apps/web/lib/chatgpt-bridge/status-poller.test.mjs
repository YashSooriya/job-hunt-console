import assert from "node:assert/strict";
import test from "node:test";
import { bindDispatchWakeEvents, createDispatchStatusPoller } from "./status-poller.ts";

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Timed out waiting for the dispatch poller");
};

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("HTTP 500 JSON errors publish an error and continue on the bounded retry schedule", async () => {
  let calls = 0;
  const updates = [];
  const poller = createDispatchStatusPoller({
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(500, { ok: false, error: "temporary database outage" })
        : jsonResponse(200, { ok: true, dispatch: { state: "completed", bridge_response: "finished" } });
    },
    retryDelayMs: () => 0,
  });
  const unsubscribe = poller.subscribe("11111111-1111-4111-8111-111111111111", undefined, (snapshot, error) => {
    updates.push({ state: snapshot?.state, response: snapshot?.response, error });
  });
  try {
    await waitFor(() => calls === 2);
    assert.equal(updates.some((update) => update.error === "temporary database outage"), true);
    assert.deepEqual(updates.at(-1), { state: "completed", response: "finished", error: null });
  } finally {
    unsubscribe();
    poller.dispose();
  }
});

test("one shared poller collapses concurrent subscribers and remounting resumes from the server", async () => {
  let calls = 0;
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const poller = createDispatchStatusPoller({
    fetch: async () => {
      calls += 1;
      return calls === 1 ? fetchPromise : jsonResponse(200, { ok: true, dispatch: { state: "completed" } });
    },
  });
  const first = [];
  const second = [];
  const unsubscribeFirst = poller.subscribe("22222222-2222-4222-8222-222222222222", { state: "queued" }, (snapshot) => first.push(snapshot?.state));
  const unsubscribeSecond = poller.subscribe("22222222-2222-4222-8222-222222222222", undefined, (snapshot) => second.push(snapshot?.state));
  let unsubscribeRemount = () => undefined;
  try {
    await waitFor(() => calls === 1);
    assert.equal(calls, 1, "two components must not start two HTTP requests");
    unsubscribeFirst();
    resolveFetch(jsonResponse(200, { ok: true, dispatch: { state: "completed" } }));
    await waitFor(() => second.at(-1) === "completed");
    assert.deepEqual(first, ["queued"], "an unmounted component must stop receiving updates");
    assert.deepEqual(second, ["queued", "completed"]);
    unsubscribeSecond();

    // A later mount gets a new authoritative read after the previous shared
    // entry has been released; it never inherits a stale in-flight promise.
    const remount = [];
    unsubscribeRemount = poller.subscribe("22222222-2222-4222-8222-222222222222", undefined, (snapshot) => remount.push(snapshot?.state));
    await waitFor(() => calls === 2 && remount.at(-1) === "completed");
    assert.deepEqual(remount, [undefined, "completed"]);
  } finally {
    unsubscribeRemount();
    poller.dispose();
  }
});

test("authentication expiry stops polling and publishes an actionable error", async () => {
  let calls = 0;
  const updates = [];
  const poller = createDispatchStatusPoller({
    fetch: async () => {
      calls += 1;
      return jsonResponse(401, { ok: false, error: "expired" });
    },
    retryDelayMs: () => 0,
  });
  const unsubscribe = poller.subscribe("33333333-3333-4333-8333-333333333333", undefined, (_snapshot, error) => updates.push(error));
  try {
    await waitFor(() => updates.some((message) => message?.includes("session has expired")));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
  } finally {
    unsubscribe();
    poller.dispose();
  }
});

test("terminal completion clears the active timer and keeps the captured answer", async () => {
  const timers = [];
  const poller = createDispatchStatusPoller({
    fetch: async () => jsonResponse(200, { ok: true, dispatch: { state: "completed", bridge_response: "already visible" } }),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
  });
  const updates = [];
  const unsubscribe = poller.subscribe("44444444-4444-4444-8444-444444444444", undefined, (snapshot) => updates.push(snapshot));
  try {
    await waitFor(() => updates.at(-1)?.state === "completed");
    assert.equal(timers.length, 0, "a terminal dispatch must not retain an active poll timer");
    assert.equal(updates.at(-1)?.response, "already visible");
  } finally {
    unsubscribe();
    poller.dispose();
  }
});

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

test("browser lifecycle and extension completion events wake the same request, while hidden visibility is ignored", () => {
  const view = new FakeEventTarget();
  view.location = { origin: "https://job-hunt-console.example" };
  const documentRef = new FakeEventTarget();
  documentRef.visibilityState = "hidden";
  const environment = { window: view, document: documentRef };
  const requestId = "55555555-5555-4555-8555-555555555555";
  let wakes = 0;
  const unbind = bindDispatchWakeEvents(requestId, () => { wakes += 1; }, environment);
  for (const type of ["JOBHUNT_DISPATCH_ACCEPTED", "JOBHUNT_DISPATCH_REJECTED", "JOBHUNT_DISPATCH_UPDATED"]) {
    view.emit("message", { source: view, origin: view.location.origin, data: { request_id: requestId, type } });
  }
  view.emit("message", { source: view, origin: view.location.origin, data: { request_id: "other", type: "JOBHUNT_DISPATCH_UPDATED" } });
  view.emit("message", { source: {}, origin: view.location.origin, data: { request_id: requestId, type: "JOBHUNT_DISPATCH_UPDATED" } });
  view.emit("online");
  view.emit("focus");
  view.emit("jobhunt:dispatch-signal", { detail: { requestId } });
  documentRef.emit("visibilitychange");
  assert.equal(wakes, 6, "extension completion events, online, focus, and the matching page signal should wake the poller");
  documentRef.visibilityState = "visible";
  documentRef.emit("visibilitychange");
  assert.equal(wakes, 7);
  unbind();
  view.emit("online");
  assert.equal(wakes, 7, "unmount cleanup must remove lifecycle listeners");
});
