import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { tmpdir } from "node:os";

const directory = path.dirname(fileURLToPath(import.meta.url));
const generated = await mkdtemp(path.join(tmpdir(), `jobhunt-bridge-tests-${Date.now()}-`));
const testBuildOptions = { define: { __JOB_HUNT_BRIDGE_BUILD_ID__: JSON.stringify("test-build-1") } };
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/protocol.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "protocol.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/storage.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "storage.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/runtime-messaging.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "runtime-messaging.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/concurrency.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "concurrency.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/focus-policy.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "focus-policy.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/read-only-recovery.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "read-only-recovery.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/completed-result-reconciliation.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "completed-result-reconciliation.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/backend-response.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "backend-response.mjs") });
await build({ ...testBuildOptions, entryPoints: [path.join(directory, "../src/shared/backend-client.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "backend-client.mjs") });
await build({ entryPoints: [path.join(directory, "../src/content/ui-adapter.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "adapter.mjs") });
const protocol = await import(pathToFileURL(path.join(generated, "protocol.mjs")));
const storage = await import(pathToFileURL(path.join(generated, "storage.mjs")));
const runtimeMessaging = await import(pathToFileURL(path.join(generated, "runtime-messaging.mjs")));
const concurrency = await import(pathToFileURL(path.join(generated, "concurrency.mjs")));
const focusPolicy = await import(pathToFileURL(path.join(generated, "focus-policy.mjs")));
const readOnlyRecovery = await import(pathToFileURL(path.join(generated, "read-only-recovery.mjs")));
const completedResultReconciliation = await import(pathToFileURL(path.join(generated, "completed-result-reconciliation.mjs")));
const backendResponse = await import(pathToFileURL(path.join(generated, "backend-response.mjs")));
const backendClient = await import(pathToFileURL(path.join(generated, "backend-client.mjs")));
const adapterModule = await import(pathToFileURL(path.join(generated, "adapter.mjs")));

test("protocol rejects malformed dispatch hints and normalises safe reasons", () => {
  assert.equal(protocol.EXTENSION_BUILD_ID, "test-build-1");
  assert.equal(protocol.responseCheckMessageType("profile.background"), "CHECK_DISPATCH_RESPONSE", "professional-profile recovery keeps its artifact-aware reader");
  assert.equal(protocol.responseCheckMessageType("jobs.analyse_selected"), "CHECK_EXISTING_DISPATCH_RESPONSE", "fit recovery reads the exact assistant turn rather than a profile file");
  assert.equal(protocol.responseCheckMessageType("job.inspect_url"), "CHECK_EXISTING_DISPATCH_RESPONSE", "other workflows also use the generic exact-turn reader");
  const responseCheckDetails = {
    requestId: "11111111-1111-4111-8111-111111111111",
    workflowKey: "jobs.analyse_selected",
    instruction: "TEST ONLY — check the existing fit response.",
    boundConversationUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    boundProjectName: "JobHuntAI",
    timeoutMs: 30000,
    turnAnchor: { conversationUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222", turnCount: 8, lastUserFingerprint: "prior-user", lastAssistantFingerprint: "prior-assistant", lastUserMessageId: "old-user", lastAssistantMessageId: "old-assistant" },
    userTurnFingerprint: "current-user-fingerprint",
    userTurnMessageId: "current-user",
  };
  assert.deepEqual(protocol.buildResponseCheckMessage("jobs.analyse_selected", responseCheckDetails), {
    ...responseCheckDetails,
    type: "CHECK_EXISTING_DISPATCH_RESPONSE",
  }, "the background recovery request carries the workflow reader and original exact-turn identity together");
  assert.equal(protocol.parsePageMessage({ type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: "bad", correlation_id: "bad", nonce: "x" }), null);
  const id = "11111111-1111-4111-8111-111111111111";
  const message = protocol.parsePageMessage({ type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: id, correlation_id: id, nonce: "nonce-1", emitted_at: "2026-09-07T15:00:00.000Z" });
  assert.deepEqual(message, { type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: id, correlation_id: id, nonce: "nonce-1", emitted_at: "2026-09-07T15:00:00.000Z" });
  assert.deepEqual(protocol.parsePageMessage({ type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 1 }), { type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 1 });
  assert.deepEqual(protocol.parsePageMessage({ type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 2, deviceId: id }), { type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 2, deviceId: id });
  assert.equal(protocol.parsePageMessage({ type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 2, deviceId: "not-a-device" }), null);
  assert.deepEqual(protocol.parsePageMessage({ type: "JOBHUNT_BRIDGE_STATUS_REQUEST", version: 1, requestId: id }), { type: "JOBHUNT_BRIDGE_STATUS_REQUEST", version: 1, requestId: id });
  assert.deepEqual(protocol.resetLocalPairingDecision(id, undefined), { clear: false, reason: "device_scope_required" });
  assert.deepEqual(protocol.resetLocalPairingDecision(id, "22222222-2222-4222-8222-222222222222"), { clear: false, reason: "device_scope_mismatch" });
  assert.deepEqual(protocol.resetLocalPairingDecision(id, id), { clear: true, reason: "matched" });
  assert.equal(protocol.safeReason("line one\nline two", "fallback"), "line one line two");
});

test("backend response parsing never clears credentials for HTML or uncoded auth failures", async () => {
  assert.equal(backendResponse.isTerminalBridgeAuthCode("device_revoked"), true);
  assert.equal(backendResponse.isTerminalBridgeAuthCode("bridge_transport_error"), false);
  const html = await backendResponse.readBridgeResponse(new Response("<!DOCTYPE html><title>Gateway error</title>", { status: 401, headers: { "content-type": "text/html" } }));
  assert.deepEqual(html, { error: "Bridge returned HTTP 401.", code: "bridge_transport_error" });
  const coded = await backendResponse.readBridgeResponse(new Response(JSON.stringify({ error: "Invalid ChatGPT bridge device credentials.", code: "device_credentials_invalid" }), { status: 401, headers: { "content-type": "application/json" } }));
  assert.equal(coded.code, "device_credentials_invalid");
});

test("pairing accepts a nested loopback Supabase function URL while rejecting insecure remote hosts", async () => {
  const originalFetch = globalThis.fetch;
  const endpoint = "http://127.0.0.1:54321/functions/v1/chatgpt-bridge";
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ device: { id: "11111111-1111-4111-8111-111111111111" }, device_token: "synthetic-device-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const paired = await backendClient.pairExtension({ backendUrl: endpoint, pairingCode: "TEST-PAIRING-CODE", displayName: "M04 synthetic extension" });
    assert.equal(requestedUrl, endpoint);
    assert.equal(paired.backendUrl, endpoint);
    await assert.rejects(
      backendClient.pairExtension({ backendUrl: "http://example.com/functions/v1/chatgpt-bridge", pairingCode: "TEST-PAIRING-CODE", displayName: "M04 synthetic extension" }),
      /must be HTTPS/,
    );
    await assert.rejects(
      backendClient.pairExtension({ backendUrl: "http://127.0.0.1:54321/functions/v1/chatgpt-bridge?target=remote", pairingCode: "TEST-PAIRING-CODE", displayName: "M04 synthetic extension" }),
      /must be HTTPS/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read-only exact-turn checks recover a dropped content channel without resending", async () => {
  let checks = 0;
  let recoveries = 0;
  let waits = 0;
  const result = await readOnlyRecovery.runReadOnlyCheckWithRecovery({
    maxAttempts: 3,
    retryDelayMs: 10,
    check: async () => {
      checks += 1;
      if (checks === 1) throw new Error("Receiving end does not exist.");
      return { ok: true, sent: true, responseText: "The already-existing exact-turn response." };
    },
    recover: async () => { recoveries += 1; return true; },
    wait: async () => { waits += 1; },
  });
  assert.equal(result.responseText, "The already-existing exact-turn response.");
  assert.equal(checks, 2);
  assert.equal(recoveries, 1);
  assert.equal(waits, 1);
});

test("read-only exact-turn recovery stops after three reader attempts and never runs a send callback", async () => {
  let checks = 0;
  let recoveries = 0;
  await assert.rejects(readOnlyRecovery.runReadOnlyCheckWithRecovery({
    maxAttempts: 99,
    retryDelayMs: 0,
    check: async () => { checks += 1; throw new Error("Receiving end does not exist."); },
    recover: async () => { recoveries += 1; return true; },
  }), /Receiving end does not exist/);
  assert.equal(checks, 3, "the retry policy is hard-capped at three read-only messages");
  assert.equal(recoveries, 2);
});

test("read-only exact-turn recovery fails closed when the inactive reader cannot be re-established", async () => {
  let checks = 0;
  let recoveries = 0;
  await assert.rejects(readOnlyRecovery.runReadOnlyCheckWithRecovery({
    check: async () => { checks += 1; throw new Error("Receiving end does not exist."); },
    recover: async () => { recoveries += 1; return false; },
    retryDelayMs: 0,
  }), /Receiving end does not exist/);
  assert.equal(checks, 1);
  assert.equal(recoveries, 1);
});

test("blocked captured results reconcile only a confirmed server completion and never resend", async () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  let reads = 0;
  let clears = 0;
  const notCompleted = await completedResultReconciliation.reconcileBlockedCapturedResult({
    expectedRequestId: requestId,
    readRemoteStatus: async () => { reads += 1; return { id: requestId, state: "running" }; },
    clearLocalRecord: async () => { clears += 1; },
  });
  assert.equal(notCompleted, false);
  assert.equal(reads, 1);
  assert.equal(clears, 0, "a nonterminal server record must retain its captured local result");

  const completed = await completedResultReconciliation.reconcileBlockedCapturedResult({
    expectedRequestId: requestId,
    readRemoteStatus: async () => { reads += 1; return { id: requestId, state: "completed" }; },
    clearLocalRecord: async () => { clears += 1; },
  });
  assert.equal(completed, true);
  assert.equal(reads, 2);
  assert.equal(clears, 1, "local recovery state is cleared only after confirmed server completion");
});

test("blocked captured-result reconciliation fails closed for a mismatched remote request", async () => {
  let clears = 0;
  await assert.rejects(completedResultReconciliation.reconcileBlockedCapturedResult({
    expectedRequestId: "11111111-1111-4111-8111-111111111111",
    readRemoteStatus: async () => ({ id: "22222222-2222-4222-8222-222222222222", state: "completed" }),
    clearLocalRecord: async () => { clears += 1; },
  }), /mismatched dispatch/);
  assert.equal(clears, 0);
});

test("Website Bridge refuses legacy internal MCP instructions", () => {
  assert.equal(protocol.isPlainLanguageWebsiteInstruction("Create a tailored cover letter for this listing."), true);
  assert.equal(protocol.isPlainLanguageWebsiteInstruction("Use the connected JobHuntAI app to execute dispatch request 11111111-1111-4111-8111-111111111111."), false);
});

test("runtime messaging catches synchronous context invalidation and disposes the sender", async () => {
  let disposed = 0;
  let calls = 0;
  const helper = runtimeMessaging.createRuntimeMessageHelper({
    sendMessage() {
      calls += 1;
      throw new Error("Extension context invalidated.");
    },
    onContextInvalidated: () => { disposed += 1; },
  });
  const result = await helper.send({ type: "CHATGPT_CONTENT_HEARTBEAT" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "context_invalidated");
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(disposed, 1);
  helper.dispose();
});

test("runtime cleanup exceptions cannot escape as a new unhandled rejection", async () => {
  const helper = runtimeMessaging.createRuntimeMessageHelper({
    sendMessage: () => { throw new Error("Extension context invalidated."); },
    onContextInvalidated: () => { throw new Error("The listener was already removed."); },
  });
  const result = await helper.send({ type: "CHATGPT_CONTENT_READY" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "context_invalidated");
  helper.dispose();
});

test("runtime messaging handles rejected worker messages without an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const helper = runtimeMessaging.createRuntimeMessageHelper({
    sendMessage: () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")),
    maxAttempts: 1,
  });
  const result = await helper.send({ type: "PAGE_DISPATCH_HINT" });
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "worker_unavailable");
  assert.equal(result.attempts, 1);
  assert.deepEqual(unhandled, []);
  helper.dispose();
});

test("runtime messaging bounds a worker call that never settles", async () => {
  const started = Date.now();
  const helper = runtimeMessaging.createRuntimeMessageHelper({
    sendMessage: () => new Promise(() => {}),
    maxAttempts: 1,
    messageTimeoutMs: 5,
  });
  const result = await helper.send({ type: "CHECK_DISPATCH_OWNERSHIP" });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.kind, "worker_unavailable");
  assert.equal(result.attempts, 1);
  assert.ok(elapsed < 1000, `runtime message remained pending for ${elapsed} ms`);
  helper.dispose();
});

test("temporary worker failure retries a queued runtime message with bounded backoff", async () => {
  let attempts = 0;
  const helper = runtimeMessaging.createRuntimeMessageHelper({
    sendMessage: () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error("The message port closed before a response was received."))
        : Promise.resolve({ accepted: true });
    },
    maxAttempts: 4,
    baseDelayMs: 1,
    maxDelayMs: 2,
  });
  const result = await helper.send({ type: "PAGE_DISPATCH_HINT", hint: { request_id: "queued" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { accepted: true });
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  helper.dispose();
});

test("disposing a retrying runtime sender clears its reconnect timer", async () => {
  const timers = [];
  let clearCalls = 0;
  const helper = runtimeMessaging.createRuntimeMessageHelper({
    sendMessage: () => Promise.reject(new Error("The service worker is unavailable.")),
    maxAttempts: 4,
    baseDelayMs: 1000,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => { clearCalls += 1; },
  });
  const pending = helper.send({ type: "CHATGPT_CONTENT_READY" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 2);
  helper.dispose();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.kind, "context_invalidated");
  assert.equal(clearCalls, 2);
  assert.equal(helper.isDisposed(), true);
});

test("runtime retry delays grow exponentially but stay bounded", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => runtimeMessaging.runtimeRetryDelayMs(attempt, 250, 4000)), [250, 500, 1000, 2000, 4000]);
  assert.equal(runtimeMessaging.runtimeMessageFailureKind(new Error("Extension context invalidated.")), "context_invalidated");
  assert.equal(runtimeMessaging.runtimeMessageFailureKind(new Error("Receiving end does not exist.")), "worker_unavailable");
});

test("extracts the structured profile object from a JSON code block", () => {
  const json = protocol.extractStructuredProfileJson('Here is the file.\n```json\n{"profile":{"first_name":"Ada"},"questions":[]}\n```');
  assert.equal(json, '{"profile":{"first_name":"Ada"},"questions":[]}');
});

test("accepts the current profile-only JSON contract", () => {
  const json = protocol.extractStructuredProfileJson('{"profile":{"first_name":"Ada"}}');
  assert.equal(json, '{"profile":{"first_name":"Ada"}}');
});

test("workflow setup pause is configurable in seconds with a safe default", () => {
  assert.equal(protocol.DEFAULT_BRIDGE_ENDPOINT, "https://sgarcjiqkvlhldmrlsqo.supabase.co/functions/v1/chatgpt-bridge");
  assert.equal(protocol.BRIDGE_PROTOCOL_VERSION, 2);
  assert.deepEqual(protocol.BRIDGE_CAPABILITIES, {
    protocol_version: 2,
    build_id: "test-build-1",
    durable_dispatch_v2: true,
    send_authorization_v2: true,
    result_outbox_v1: true,
    result_completion_v3: true,
    response_provenance_v3: true,
    concurrent_response_capture: 2,
    background_focus_policy_v2: true,
  });
  assert.equal(protocol.supportsBridgeV2(protocol.BRIDGE_CAPABILITIES), true);
  assert.equal(protocol.supportsBridgeV2({ ...protocol.BRIDGE_CAPABILITIES, protocol_version: 1 }), false);
  assert.equal(protocol.supportsBridgeV2({ ...protocol.BRIDGE_CAPABILITIES, protocol_version: 2 }), true);
  assert.equal(protocol.supportsBridgeV2({ durable_dispatch_v2: true, send_authorization_v2: true, result_outbox_v1: true, concurrent_response_capture: 1 }), false);
  assert.equal(protocol.supportsBackgroundFocusPolicy({ background_focus_policy_v2: true }), true);
  assert.equal(protocol.supportsBackgroundFocusPolicy({ background_focus_policy_v2: false }), false);
  assert.equal(protocol.supportsBridgeResultV3({ result_completion_v3: true, response_provenance_v3: true }), true);
  assert.equal(protocol.supportsBridgeResultV3({ result_completion_v3: true }), false);
  assert.equal(protocol.DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS, 15);
  assert.equal(protocol.MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS, 0);
  assert.equal(protocol.MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS, 300);
  assert.equal(protocol.CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS, 900000);
  assert.equal(protocol.RESPONSE_CHECK_DISPLAY_TITLE, "Check completed professional profile response");
});

test("result upload recovery is bounded and never due while blocked", () => {
  assert.equal(protocol.resultUploadRetryDelayMs(1), 5000);
  assert.equal(protocol.resultUploadRetryDelayMs(3), 20000);
  assert.equal(protocol.resultUploadRetryDelayMs(99), 300000);
  const now = Date.parse("2026-09-07T15:00:00.000Z");
  assert.equal(protocol.resultUploadRetryDue({ resultUploadNextAttemptAt: "2026-09-07T15:00:01.000Z" }, now), false);
  assert.equal(protocol.resultUploadRetryDue({ resultUploadNextAttemptAt: "2026-09-06T15:00:00.000Z" }, now), true);
  assert.equal(protocol.resultUploadRetryDue({ resultUploadBlocked: true }, now), false);
  assert.equal(protocol.resultUploadRetryDue({}, now), true);
});

test("upload-only manual recovery is offered only for an exact blocked v2 capture", () => {
  const candidate = {
    id: "11111111-1111-4111-8111-111111111111",
    protocol: "v2",
    phase: "result_pending",
    resultUploadBlocked: true,
    deliveryAttemptId: "22222222-2222-4222-8222-222222222222",
    leaseToken: "lease-token-".padEnd(48, "x"),
    instruction: "Assess this captured diagnostic response.",
    boundConversationUrl: "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333",
    capturedResponse: "The already-captured assistant response.",
    responseProvenance: {
      conversationUrl: "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333",
      userTurnFingerprint: "exact-user-turn",
      assistantMessageId: "assistant-1",
      source: "assistant_turn",
      generationFinished: true,
    },
  };
  assert.equal(protocol.isCapturedResultUploadRetryCandidate(candidate), true);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, protocol: "v1" }), false);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, phase: "sent_confirmed" }), false);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, capturedResponse: null }), false);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, deliveryAttemptId: null }), false);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, leaseToken: "short" }), false);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, responseProvenance: null }), false);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, instruction: "Use the ChatGPT bridge dispatch request." }), false);
  assert.equal(protocol.isCapturedResultUploadRetryCandidate({ ...candidate, responseProvenance: { ...candidate.responseProvenance, generationFinished: false } }), false);
});

test("v2 recovery reconciles every persistence boundary without granting an automatic resend", () => {
  const cases = [
    ["claimed_by_extension", undefined, undefined, undefined, false, "claimed", false, false, "resume_delivery"],
    ["opening_chatgpt", undefined, undefined, undefined, false, "preparing", false, false, "resume_delivery"],
    ["send_attempted", undefined, undefined, undefined, false, "send_ambiguous", true, false, "reconcile_send"],
    ["sent", undefined, undefined, undefined, false, "sent_confirmed", true, true, "observe_response"],
    ["running", undefined, true, undefined, false, "sent_confirmed", true, true, "observe_response"],
    ["sent", undefined, undefined, "result_pending", true, "result_pending", true, true, "upload_result"],
  ];
  for (const [remoteState, remoteSendAttempted, remoteSentConfirmed, localPhase, hasCapturedResponse, phase, sendAttempted, sentVerified, action] of cases) {
    const reconciled = protocol.reconcileV2RecoveryPhase({ remoteState, remoteSendAttempted, remoteSentConfirmed, localPhase, hasCapturedResponse });
    assert.deepEqual(reconciled, { phase, sendAttempted, sentVerified }, remoteState);
    assert.equal(protocol.v2RecoveryActionForPhase(reconciled.phase, hasCapturedResponse), action, remoteState);
  }
  assert.equal(protocol.v2RecoveryActionForPhase("result_pending", false), "observe_response");
  assert.equal(protocol.v2RecoveryActionForPhase("terminal"), "release");
});

test("adaptive concurrency parses and bounds visible rate-limit retry windows", () => {
  assert.equal(concurrency.parseRetryAfterSeconds("Please retry in 45 seconds."), 45);
  assert.equal(concurrency.parseRetryAfterSeconds("Please wait 2 minutes and 30 seconds before trying again."), 150);
  assert.equal(concurrency.parseRetryAfterSeconds("Try again at 14:30."), null);
  assert.equal(concurrency.clampRateLimitDelaySeconds(5), 30);
  assert.equal(concurrency.clampRateLimitDelaySeconds(99999), 1800);
  assert.equal(concurrency.clampRateLimitDelaySeconds(null), 300);
});

test("page hints and queue polls cannot race to claim one dispatch", () => {
  const gate = concurrency.createDispatchClaimGate();
  assert.equal(gate.isHeld(), false);
  assert.equal(gate.tryAcquire("page_hint"), true);
  assert.equal(gate.tryAcquire("queue_poll"), false);
  assert.equal(gate.isHeld(), true);
  gate.release("queue_poll");
  assert.equal(gate.isHeld(), true, "a competing owner cannot release the winning claim");
  gate.release("page_hint");
  assert.equal(gate.tryAcquire("queue_poll"), true);
  assert.equal(gate.tryAcquire("page_hint"), false);
  gate.release("queue_poll");
  assert.equal(gate.isHeld(), false);
});

test("adaptive concurrency reduces to one during backoff and restores two after expiry", () => {
  const now = Date.parse("2026-09-07T15:00:00.000Z");
  assert.equal(concurrency.generationLimit("2026-09-07T15:05:00.000Z", 2, now), 1);
  assert.equal(concurrency.generationLimit("2026-09-07T14:59:59.000Z", 2, now), 2);
  assert.equal(concurrency.generationLimit(null, 1, now), 1);
  assert.equal(concurrency.shouldStopAfterManualGenerationDeferrals(4), false);
  assert.equal(concurrency.shouldStopAfterManualGenerationDeferrals(5), true);
  assert.equal(concurrency.isRateLimitCode("chatgpt_rate_limited"), true);
  assert.equal(concurrency.isManualGenerationBusyCode("already_generating"), true);
});

test("full v2 capacity polls only when expired response windows free a slot", () => {
  const now = Date.parse("2026-09-25T20:30:00.000Z");
  const expired = { responseDeadlineAt: "2026-09-25T20:00:00.000Z" };
  const waiting = { responseDeadlineAt: "2026-09-25T20:40:00.000Z" };
  assert.equal(concurrency.shouldPollV2QueueWithinCapacity([waiting, waiting], 2, now), false);
  assert.equal(concurrency.shouldPollV2QueueWithinCapacity([expired, waiting], 2, now), true);
  assert.equal(concurrency.shouldPollV2QueueWithinCapacity([expired, waiting], 1, now), false);
  assert.equal(concurrency.shouldPollV2QueueWithinCapacity([expired, expired], 2, now), true);
  assert.equal(concurrency.shouldPollV2QueueWithinCapacity([waiting], 2, now), true);
});

test("focus policy restores newly-created and reused helper activation", () => {
  const initial = { known: true, windowId: 1, tabId: 10 };
  const helperTabId = 20;
  assert.equal(focusPolicy.shouldRestoreAfterHelperOpen(initial, { known: true, windowId: 1, tabId: helperTabId }, helperTabId), true);
  assert.equal(focusPolicy.shouldRestoreAfterHelperOpen(initial, { known: true, windowId: 1, tabId: 30 }, helperTabId), false);
  assert.equal(focusPolicy.shouldRestoreAfterHelperOpen(initial, { known: true, windowId: 2, tabId: 40 }, helperTabId), false);
  assert.equal(focusPolicy.shouldRestoreAfterHelperOpen({ known: true, windowId: 1, tabId: helperTabId }, { known: true, windowId: 1, tabId: helperTabId }, helperTabId), false);
  assert.equal(focusPolicy.shouldRestoreAfterHelperOpen({ known: false, windowId: null, tabId: null }, { known: true, windowId: 1, tabId: helperTabId }, helperTabId), false);
});

test("treats ChatGPT Project slugs as presentation variants of one stable Project", () => {
  const base = "https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc/c/11111111-1111-4111-8111-111111111111";
  const slugged = "https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc-jobhuntai/c/22222222-2222-4222-8222-222222222222";
  const other = "https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc-other/c/33333333-3333-4333-8333-333333333333";
  assert.equal(protocol.projectIdentityFor(base), "g-p-6a91752965548191911f085ddfc54ecc");
  assert.equal(protocol.sameProjectUrl(base, slugged), true);
  assert.equal(protocol.sameProjectUrl(base, other), true);
  assert.equal(protocol.sameProjectUrl(base, "https://chatgpt.com/g/g-p-1234567890abcdef/project"), false);
});

test("treats a slugged and unslugged URL as the same bound conversation", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const unSlugs = `https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc/c/${conversationId}`;
  const slugged = `https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc-jobhuntai/c/${conversationId}`;
  const otherConversation = "https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc-jobhuntai/c/22222222-2222-4222-8222-222222222222";
  assert.equal(protocol.conversationIdentityFor(unSlugs), "g-p-6a91752965548191911f085ddfc54ecc:11111111-1111-4111-8111-111111111111");
  assert.equal(protocol.conversationIdentityFor(slugged), protocol.conversationIdentityFor(unSlugs));
  assert.equal(protocol.sameConversationUrl(unSlugs, slugged), true);
  assert.equal(protocol.sameConversationUrl(unSlugs, otherConversation), false);
  assert.equal(protocol.sameConversationUrl("https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", unSlugs), false);
});

test("professional background workflow has a dedicated memory-oriented initialization", () => {
  assert.ok(protocol.CONVERSATION_SLOT_DEFINITIONS.some((definition) => definition.key === "profile.background" && definition.label === "Professional background"));
  assert.match(protocol.PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE, /Remember everything I present here/i);
  assert.match(protocol.PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE, /heavy lifting of extracting, organising, reconciling/i);
  assert.match(protocol.PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE, /build and continuously refine a broad, accurate professional profile/i);
  assert.ok(!/JobHuntAI|MCP|dispatch request/i.test(protocol.PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE));
  assert.ok(protocol.PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE.length < 2000);
});

class FakeElement {
  constructor(text = "", attributes = {}) {
    this.textContent = text;
    this.innerText = text;
    this.attributes = attributes;
    this.ownerDocument = { defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) } };
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getClientRects() { return [1]; }
  contains(element) { return element === this; }
  closest() { return null; }
  focus() {}
  dispatchEvent() {}
  click() { this.onclick?.(); }
  querySelectorAll() { return []; }
  matches(selector) { return selector.includes("role=option") || selector.includes("role=menuitem") || selector.includes("button") || selector.includes("li") || selector.includes("role=button"); }
}

function bridgeMessageFingerprint(value) {
  const text = value.replace(/[\u00a0\u200b]/g, " ").replace(/\s+/gu, " ").trim();
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

globalThis.HTMLElement = FakeElement;
globalThis.window = { setTimeout, clearTimeout };
globalThis.InputEvent ||= class InputEvent {};

function fakeDocument({ project = true, modal = false, authenticated = false } = {}) {
  const projectElement = project ? new FakeElement("JobHuntAI", { "aria-label": "JobHuntAI" }) : null;
  const modalElement = modal ? new FakeElement("Allow access", { role: "dialog", "aria-modal": "true" }) : null;
  const composerElement = authenticated ? new FakeElement("", { contenteditable: "true", role: "textbox" }) : null;
  return {
    body: { innerText: project ? "JobHuntAI" : "Personal" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: () => false,
    querySelectorAll(selector) {
      if (selector.includes("dialog") || selector.includes("aria-modal") || selector.includes("modal")) return modalElement ? [modalElement] : [];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return composerElement ? [composerElement] : [];
      if (selector.includes("button") || selector.includes("role=button") || selector.includes("role=option") || selector.includes("role=menuitem") || selector.includes("li") || selector.includes("h1") || selector.includes("nav a")) return projectElement ? [projectElement] : [];
      return [];
    },
  };
}

test("adapter fails closed on wrong conversation and blocking modal", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const location = { href: `https://chatgpt.com/c/${id}`, pathname: `/c/${id}` };
  const adapter = adapterModule.adapterErrorForTest(fakeDocument(), location);
  assert.equal(adapter.verifyBoundConversation(location.href, "JobHuntAI"), null);
  assert.equal(adapter.verifyBoundConversation(`https://chatgpt.com/c/${id}-other`, "JobHuntAI").code, "wrong_conversation");
  const blocked = adapterModule.adapterErrorForTest(fakeDocument({ modal: true }), location).detectBlockingModal();
  assert.equal(blocked.code, "blocking_modal");
});

test("accepts a JobHuntAI Project URL when ChatGPT does not expose an exact Project label", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const conversationUrl = `https://chatgpt.com/g/g-p-1234567890abcdef-jobhuntai/c/${id}`;
  const location = { href: conversationUrl, pathname: new URL(conversationUrl).pathname };
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ project: false }), location);
  assert.equal(adapter.verifyBoundConversation(conversationUrl, "JobHuntAI"), null);
});

test("canonicalises Project conversation URLs before anchoring and uploading a response", () => {
  const idOnlyUrl = "https://chatgpt.com/g/g-p-6a9fe00477b08191b74992226af14ec8/c/11111111-1111-4111-8111-111111111111";
  const sluggedUrl = "https://chatgpt.com/g/g-p-6a9fe00477b08191b74992226af14ec8-jobhuntai/c/11111111-1111-4111-8111-111111111111?temporary=1#message";
  const canonicalUrl = protocol.canonicalBridgeConversationUrl(idOnlyUrl);
  assert.equal(canonicalUrl, idOnlyUrl);
  assert.equal(protocol.canonicalBridgeConversationUrl(sluggedUrl), canonicalUrl);

  const adapter = adapterModule.adapterErrorForTest(fakeDocument(), {
    href: sluggedUrl,
    pathname: new URL(sluggedUrl).pathname,
  });
  const anchor = adapter.turnAnchorForMessages([]);
  const provenance = adapter.responseProvenance({
    userTurnFingerprint: "sent-turn:1",
    assistantFingerprint: "assistant-turn:1",
    source: "assistant_turn",
  });
  assert.equal(anchor.conversationUrl, canonicalUrl);
  assert.equal(provenance.conversationUrl, canonicalUrl);
  assert.equal(protocol.sameConversationUrl(idOnlyUrl, sluggedUrl), true);
});

test("verifies ChatGPT's rich-text rendering of exact Markdown links", () => {
  const expected = "Review [the synthetic listing](https://example.com/jobs/123) and reply only Ready.";
  const composer = new FakeElement("Review the synthetic listing and reply only Ready.", { contenteditable: "true" });
  const link = new FakeElement("the synthetic listing", { href: "https://example.com/jobs/123" });
  composer.querySelectorAll = (selector) => selector === "a[href]" ? [link] : [];
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ authenticated: true }), {
    href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
    pathname: "/c/11111111-1111-4111-8111-111111111111",
  });

  assert.equal(adapter.verifyComposerText(composer, expected), null);
  link.attributes.href = "https://example.com/jobs/other";
  assert.equal(adapter.verifyComposerText(composer, expected).code, "composer_mismatch");
});

test("composer mismatch diagnostics expose only lengths and structural metadata, never prompt text", () => {
  const expected = "PRIVATE TEST PROMPT — exact URL https://example.com/jobs/role";
  const composer = new FakeElement("PRIVATE TEST PROMPT — exact URL https://example.com/jobs/other", { contenteditable: "true" });
  composer.querySelectorAll = () => [];
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ authenticated: true }), {
    href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
    pathname: "/c/11111111-1111-4111-8111-111111111111",
  });
  const mismatch = adapter.verifyComposerText(composer, expected);
  assert.equal(mismatch.code, "composer_mismatch");
  assert.match(mismatch.reason, /lens=\d+\/\d+; prefix=\d+; suffix=\d+; text=\d+\/[01]; urls=1\/1\/0; links=0; tab=visible/);
  assert.doesNotMatch(mismatch.reason, /PRIVATE TEST PROMPT|example\.com|role|other/);
});

test("exact contenteditable text remains valid when innerText adds layout-only URL whitespace", () => {
  const expected = "Inspect this exact source URL: https://example.com/jobs/role?ref=one&source=two";
  const composer = new FakeElement(expected, { contenteditable: "true", role: "textbox" });
  composer.innerText = expected.replace("https://example.com", "https: //example.com");
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ authenticated: true }), {
    href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
    pathname: "/c/11111111-1111-4111-8111-111111111111",
  });
  assert.equal(adapter.verifyComposerText(composer, expected), null);
});

test("accepts the ID-only JobHuntAI Project URL when the page title identifies the Project", () => {
  const projectUrl = `https://chatgpt.com/g/g-p-6a8d9c4023cc8191b51c14d49b397bf1/project`;
  const location = { href: projectUrl, pathname: new URL(projectUrl).pathname };
  const document = { ...fakeDocument({ project: false, authenticated: true }), title: "JobHuntAI | ChatGPT" };
  const adapter = adapterModule.adapterErrorForTest(document, location);
  assert.equal(adapter.verifyProjectContext("JobHuntAI").ok, true);
});

test("identifies the Project name field inside nested ChatGPT creation modals", () => {
  const heading = new FakeElement("Create project", { role: "heading" });
  const input = new FakeElement("", { placeholder: "Copenhagen Trip" });
  input.tagName = "INPUT";
  input.value = "";
  const field = new FakeElement("Project name Copenhagen Trip");
  input.parentElement = field;
  const inner = new FakeElement("Create project Project name Copenhagen Trip", { "data-testid": "modal-inner" });
  const outer = new FakeElement("Create project Project name Copenhagen Trip", { role: "dialog", "data-testid": "modal-new-project-enhanced" });
  heading.tagName = "H2";
  outer.querySelectorAll = (selector) => selector.includes("input") ? [input] : selector.includes("h1") || selector.includes("h2") || selector.includes("h3") || selector.includes("role=heading") ? [heading] : [];
  inner.querySelectorAll = outer.querySelectorAll;
  outer.contains = (element) => element === inner || element === input || element === heading || element === field;
  const document = {
    body: { innerText: "Create project" },
    querySelectorAll(selector) {
      return selector.includes("dialog") || selector.includes("aria-modal") || selector.includes("modal") ? [outer, inner] : [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/", pathname: "/" });
  assert.equal(adapter.projectNameInput(), input);
});

test("accepts the stored exact Project URL while a reloaded Project has not mounted its composer", () => {
  const projectUrl = "https://chatgpt.com/g/g-p-1234567890abcdef/project";
  const location = { href: projectUrl, pathname: new URL(projectUrl).pathname };
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ project: false, authenticated: false }), location);
  assert.equal(adapter.verifyProjectContext("JobHuntAI", projectUrl).ok, true);

  const conversationUrl = "https://chatgpt.com/g/g-p-1234567890abcdef/c/11111111-1111-4111-8111-111111111111";
  const conversationLocation = { href: conversationUrl, pathname: new URL(conversationUrl).pathname };
  const conversationAdapter = adapterModule.adapterErrorForTest(fakeDocument({ project: false, authenticated: false }), conversationLocation);
  assert.equal(conversationAdapter.verifyBoundConversation(conversationUrl, "JobHuntAI", projectUrl), null);

  const outsideProjectUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
  const outsideLocation = { href: outsideProjectUrl, pathname: new URL(outsideProjectUrl).pathname };
  const outsideAdapter = adapterModule.adapterErrorForTest(fakeDocument({ project: false, authenticated: false }), outsideLocation);
  assert.equal(outsideAdapter.verifyBoundConversation(outsideProjectUrl, "JobHuntAI", projectUrl).code, "conversation_wrong_project");
});

test("accepts a bound conversation whose Project slug differs from the stored Project URL", () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const projectUrl = "https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc/project";
  const location = { href: conversationUrl, pathname: new URL(conversationUrl).pathname };
  const adapter = adapterModule.adapterErrorForTest({ ...fakeDocument({ project: false, authenticated: true }), title: "JobHuntAI | ChatGPT" }, location);
  assert.equal(adapter.verifyBoundConversation(conversationUrl, "JobHuntAI", projectUrl), null);
});

test("accepts the unslugged profile tab for a slugged bound conversation", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const boundUrl = `https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc-jobhuntai/c/${conversationId}`;
  const visibleUrl = `https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc/c/${conversationId}`;
  const location = { href: visibleUrl, pathname: new URL(visibleUrl).pathname };
  const projectUrl = "https://chatgpt.com/g/g-p-6a91752965548191911f085ddfc54ecc-jobhuntai/project";
  const adapter = adapterModule.adapterErrorForTest({ ...fakeDocument({ project: false, authenticated: true }), title: "JobHuntAI | ChatGPT" }, location);
  assert.equal(adapter.verifyBoundConversation(boundUrl, "JobHuntAI", projectUrl), null);
});

test("normal dispatches reject a conversation whose Project URL does not match", async () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const document = {
    ...fakeDocument({ project: true, authenticated: true }),
    title: "JobHuntAI | ChatGPT",
    querySelectorAll(selector) {
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      return fakeDocument({ project: true, authenticated: true }).querySelectorAll(selector);
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.executeDispatch({
    requestId: "11111111-1111-4111-8111-111111111111",
    workflowKey: "job.inspect_url",
    instruction: "Inspect this listing.",
    boundConversationUrl: conversationUrl,
    boundProjectName: "JobHuntAI",
    boundProjectUrl: "https://chatgpt.com/g/g-p-other/project",
  });
  assert.equal(result.code, "conversation_wrong_project");
});

test("defers an unrelated manual generation before touching the composer", async () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const composer = new FakeElement("The user's draft", { contenteditable: "true", role: "textbox" });
  const project = new FakeElement("JobHuntAI", { "aria-label": "JobHuntAI" });
  const stop = new FakeElement("", { "aria-label": "Stop generating", role: "button" });
  const document = {
    ...fakeDocument({ project: true, authenticated: true }),
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    querySelectorAll(selector) {
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [project, stop];
      if (selector.includes("button") || selector.includes("role=button") || selector.includes("role=link")) return [project, stop];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.executeDispatch({
    requestId: "11111111-1111-4111-8111-111111111111",
    workflowKey: "job.inspect_url",
    instruction: "A queued Website Bridge instruction",
    boundConversationUrl: conversationUrl,
    boundProjectName: "JobHuntAI",
    boundProjectUrl: "https://chatgpt.com/g/g-p-jobhuntai/project",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "already_generating");
  assert.equal(composer.textContent, "The user's draft");
});

test("accepts an existing bound conversation only after its visible composer is present", async () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const conversationMessage = new FakeElement("Existing setup message", { "data-message-author-role": "user" });
  const baseDocument = fakeDocument({ project: true, authenticated: true });
  const adapter = adapterModule.adapterErrorForTest(
    {
      ...baseDocument,
      title: "JobHuntAI | ChatGPT",
      querySelectorAll(selector) {
        if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [conversationMessage];
        return baseDocument.querySelectorAll(selector);
      },
    },
    { href: conversationUrl, pathname: new URL(conversationUrl).pathname },
  );
  const result = await adapter.checkBoundConversation(conversationUrl, "JobHuntAI", 1000);
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
});

test("classifies a deleted bound conversation as repairable", async () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const document = { ...fakeDocument({ project: false }), title: "JobHuntAI | ChatGPT", body: { innerText: "Conversation not found" } };
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.checkBoundConversation(conversationUrl, "JobHuntAI", 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "conversation_missing");
});

test("classifies a deleted bound conversation redirected to the Project home as repairable", async () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const projectUrl = "https://chatgpt.com/g/g-p-jobhuntai/project";
  const adapter = adapterModule.adapterErrorForTest(
    { ...fakeDocument({ project: true, authenticated: true }), title: "JobHuntAI | ChatGPT" },
    { href: projectUrl, pathname: new URL(projectUrl).pathname },
  );
  const result = await adapter.checkBoundConversation(conversationUrl, "JobHuntAI", 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "conversation_missing");
});

test("classifies a deleted bound conversation redirected to signed-in ChatGPT home as repairable", async () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const homeUrl = "https://chatgpt.com/";
  const document = { ...fakeDocument({ project: false, authenticated: true }), title: "ChatGPT", body: { innerText: "Chat history\nNew chat\nReady to dive in" } };
  const adapter = adapterModule.adapterErrorForTest(document, { href: homeUrl, pathname: "/" });
  const result = await adapter.checkBoundConversation(conversationUrl, "JobHuntAI", 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "conversation_missing");
});

test("classifies a deleted bound conversation that keeps its URL but renders ChatGPT home", async () => {
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const document = {
    ...fakeDocument({ project: false, authenticated: true }),
    title: "ChatGPT",
    body: { innerText: "Chat history\nProjects\nNew chat\nHow can I help, Yashwanth?" },
  };
  const location = { href: conversationUrl, pathname: new URL(conversationUrl).pathname };
  const adapter = adapterModule.adapterErrorForTest(document, location);
  const result = await adapter.checkBoundConversation(conversationUrl, "JobHuntAI", 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "conversation_missing");
  assert.equal(adapter.verifyProjectContext("JobHuntAI").code, "conversation_missing");
});

test("rejects an ID-only Project URL when its page title names another Project", () => {
  const projectUrl = "https://chatgpt.com/g/g-p-6a8d9c4023cc8191b51c14d49b397bf1/project";
  const location = { href: projectUrl, pathname: new URL(projectUrl).pathname };
  const document = { ...fakeDocument({ project: false, authenticated: true }), title: "Other Project | ChatGPT" };
  const adapter = adapterModule.adapterErrorForTest(document, location);
  assert.equal(adapter.verifyProjectContext("JobHuntAI").code, "project_not_verified");
});

test("stops safely when ChatGPT displays its request-rate limit", async () => {
  const document = { ...fakeDocument({ project: false }), body: { innerText: "Too many requests. Please wait a few minutes before trying again." } };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/", pathname: "/" });
  const result = await adapter.ensureProjectContext(10);
  assert.equal(result.code, "chatgpt_rate_limited");
  assert.equal(result.retryAfterSeconds, null);
});

test("returns a safe relative retry duration from a visible rate-limit banner", () => {
  const document = { ...fakeDocument({ project: false }), body: { innerText: "Too many requests. Please retry in 45 seconds." } };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/", pathname: "/" });
  const result = adapter.detectRateLimit();
  assert.equal(result?.code, "chatgpt_rate_limited");
  assert.equal(result?.retryAfterSeconds, 45);
});

test("response capture reports a rate limit that appears after Send", async () => {
  const document = { ...fakeDocument({ project: false }), body: { innerText: "Too many requests. Please retry in 45 seconds." } };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "" }, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "chatgpt_rate_limited");
  assert.equal(result.retryAfterSeconds, 45);
});

function projectSetupFixture(mode) {
  let state = mode;
  const projectUrl = mode === "create-id-only"
    ? "https://chatgpt.com/g/g-p-1234567890abcdef/project"
    : "https://chatgpt.com/g/g-p-jobhuntai/project";
  const location = { href: "https://chatgpt.com/g/g-p-other/project", pathname: "/g/g-p-other/project" };
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const projects = new FakeElement("Projects", { "aria-label": "Projects", role: "link", ...(mode === "expanded-existing" ? { "aria-expanded": "true" } : {}) });
  const existing = new FakeElement("JobHuntAI", { "aria-label": "JobHuntAI", role: "link" });
  const projectRow = new FakeElement("", {});
  const projectHome = new FakeElement("Open project home", { "aria-label": "Open project home", role: "button" });
  existing.parentElement = projectRow;
  projectRow.querySelectorAll = (selector) => selector === "a, button, [role=link], [role=button], [role=menuitem]" ? [existing, projectHome] : [];
  const create = new FakeElement("New project", { "aria-label": "New project", role: "button" });
  const dialog = new FakeElement("Create project", { role: "dialog", "aria-modal": "true", "data-testid": "modal-new-project-enhanced" });
  const modalTrigger = new FakeElement("", { "data-testid": "project-modal-trigger", role: "button" });
  const headingSurface = new FakeElement("Create project", { role: "heading" });
  const input = new FakeElement("", { placeholder: "Copenhagen Trip", id: "project-name", name: "projectName" });
  input.tagName = "INPUT";
  input.value = "";
  const submit = new FakeElement("Create project", { "aria-label": "Create project", role: "button" });
  submit.disabled = mode === "create-disabled-submit" || mode === "create-replaced-input";
  if (mode === "create-disabled-submit") input.dispatchEvent = () => { submit.disabled = false; };
  if (mode === "create-replaced-input") {
    let replacedOnce = false;
    input.dispatchEvent = () => {
      if (!replacedOnce && input.value === "JobHuntAI") {
        input.value = "";
        replacedOnce = true;
      } else if (input.value === "JobHuntAI") {
        submit.disabled = false;
      }
    };
  }
  const document = {
    title: "Other Project | ChatGPT",
    body: { innerText: "ChatGPT" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("dialog") || selector.includes("aria-modal") || selector.includes("modal")) return state === "modal" && mode.startsWith("create") ? [dialog, modalTrigger] : [];
      if (selector.includes("h1") || selector.includes("role=heading")) return state === "modal" && mode === "create-heading" ? [headingSurface] : [];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return mode === "create-id-only" && state === "project" ? [] : [composer];
      if (selector === "a, button, [role=link], [role=button], [role=menuitem]") {
        if (state === "existing" || state === "expanded-existing") return [projects, existing];
        if (state === "create") return [projects, create];
        return [projects];
      }
      if (selector.includes("button") || selector.includes("role=button") || selector.includes("role=option") || selector.includes("role=menuitem") || selector.includes("li") || selector.includes("h1") || selector.includes("nav a")) {
        if (state === "existing" || state === "expanded-existing") return [projects, existing];
        if (state === "create") return [projects, create];
        return [];
      }
      return [];
    },
  };
  const creationRootQuery = (selector) => {
    if (selector.includes("input") || selector.includes("textarea") || selector.includes("contenteditable")) return [input];
    if (selector === "a, button, [role=link], [role=button], [role=menuitem]") return [submit];
    return [];
  };
  dialog.querySelectorAll = creationRootQuery;
  headingSurface.querySelectorAll = creationRootQuery;
  const openProject = () => {
    state = "project";
    location.href = projectUrl;
    location.pathname = "/g/g-p-jobhuntai/project";
    document.title = "JobHuntAI | ChatGPT";
  };
  projects.onclick = () => {
    if (mode === "expanded-existing") {
      state = "create";
      return;
    }
    if (mode === "existing-delayed") {
      state = "loading";
      setTimeout(() => { state = "existing"; }, 250);
      return;
    }
    state = mode === "existing" ? "existing" : "create";
  };
  existing.onclick = openProject;
  projectHome.onclick = openProject;
  create.onclick = () => { state = "modal"; };
  submit.onclick = mode === "create-returns-list"
    ? () => { state = "existing"; location.href = "https://chatgpt.com/"; location.pathname = "/"; }
    : mode === "create-returns-project"
      ? () => { state = "existing"; }
      : openProject;
  return { adapter: adapterModule.adapterErrorForTest(document, location), location, getState: () => state };
}

test("reuses an existing exact JobHuntAI Project through the visible Projects navigation", async () => {
  const fixture = projectSetupFixture("existing");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true);
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("waits for an existing Project row before falling back to New project", async () => {
  const fixture = projectSetupFixture("existing-delayed");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true);
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("does not collapse an already expanded Projects list", async () => {
  const fixture = projectSetupFixture("expanded-existing");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true);
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("creates and verifies JobHuntAI when the visible Projects page has no matching Project", async () => {
  const fixture = projectSetupFixture("create");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true);
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("creates JobHuntAI when ChatGPT exposes the creation surface by heading instead of dialog role", async () => {
  const fixture = projectSetupFixture("create-heading");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true);
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("updates ChatGPT's controlled Project field so its disabled Create action becomes enabled", async () => {
  const fixture = projectSetupFixture("create-disabled-submit");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("retries when ChatGPT replaces the controlled Project field during input", async () => {
  const fixture = projectSetupFixture("create-replaced-input");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("opens the newly created Project when ChatGPT returns to the Projects list", async () => {
  const fixture = projectSetupFixture("create-returns-list");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("opens the newly created Project when ChatGPT stays on the previous Project URL", async () => {
  const fixture = projectSetupFixture("create-returns-project");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-jobhuntai/project");
  assert.equal(fixture.getState(), "project");
});

test("accepts the newly created JobHuntAI Project when ChatGPT uses an ID-only URL", async () => {
  const fixture = projectSetupFixture("create-id-only");
  const result = await fixture.adapter.ensureProjectContext(10);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectUrl, "https://chatgpt.com/g/g-p-1234567890abcdef/project");
  assert.equal(fixture.getState(), "project");
});

test("recovers a setup conversation from its exact marker without sending again", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-jobhuntai/project";
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const marker = "This conversation is reserved for my Job inspection workflow. Reply only Ready.";
  const userMessage = new FakeElement(marker, { "data-message-author-role": "user" });
  const baseDocument = fakeDocument({ project: false, authenticated: true });
  const document = {
    ...baseDocument,
    title: "JobHuntAI | ChatGPT",
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage];
      return baseDocument.querySelectorAll(selector);
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.recoverWorkflowConversation({ marker, projectUrl });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.conversationUrl, conversationUrl);
});

test("recognises the modern role-button Send control", () => {
  const send = new FakeElement("", { role: "button", "data-testid": "send-button", "aria-label": "Send prompt" });
  const document = {
    querySelectorAll(selector) {
      return selector.includes("button") ? [send] : [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/g/g-p-job-hunt/project", pathname: "/g/g-p-job-hunt/project" });
  assert.equal(adapter.findSendControl(), send);
});

test("recognises composer-prefixed submit controls and accessible labels", () => {
  const send = new FakeElement("", { role: "button", "data-testid": "composer-submit-button" });
  const document = {
    getElementById: (id) => id === "send-label" ? { textContent: "Send message" } : null,
    querySelectorAll(selector) {
      return selector.includes("button") ? [send] : [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/g/g-p-job-hunt/project", pathname: "/g/g-p-job-hunt/project" });
  assert.equal(adapter.findSendControl(), send);

  send.attributes["data-testid"] = "composer-action-button";
  send.attributes["aria-labelledby"] = "send-label";
  assert.equal(adapter.findSendControl(), send);
});

test("waits for an inactive-chat Send control to become enabled", async () => {
  const send = new FakeElement("", { role: "button", "data-testid": "send-button", "aria-label": "Send prompt" });
  send.disabled = true;
  const document = {
    visibilityState: "hidden",
    querySelectorAll(selector) {
      return selector.includes("button") ? [send] : [];
    },
  };
  const composer = new FakeElement("A background dispatch instruction", { contenteditable: "true", role: "textbox" });
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  setTimeout(() => { send.disabled = false; }, 20);
  assert.equal(await adapter.waitForSendControl(composer, 100), send);
});

test("recognises conversation-turn author markers while nested role nodes are still mounting", () => {
  const instruction = "A diagnostic message from the JobHuntAI website.";
  const userMessage = new FakeElement(`You said: ${instruction}`, { "data-turn": "user" });
  const assistantMessage = new FakeElement("ChatGPT said: Diagnostic reply.", { "data-turn": "assistant" });
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [];
      if (selector.includes("data-turn=\"user\"") || selector.includes("data-turn=\"assistant\"")) return [userMessage, assistantMessage];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-1111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  const delivered = adapter.verifyExistingDispatchMessage(instruction);
  assert.equal(delivered.ok, true);
  assert.equal(delivered.sent, true);
  assert.deepEqual(adapter.assistantResponseSnapshot(), { count: 1, lastText: "Diagnostic reply.", artifactCount: 0 });
});

test("captures the labelled assistant sibling for the exact user turn when Project DOM markers are absent", async () => {
  const instruction = "TEST ONLY — reply exactly: BRIDGE TEST RESPONSE ONE.";
  const makeUser = (text) => new FakeElement(`You said: ${text}`, { class: "group/user-message flex flex-col items-end gap-2" });
  const makeAssistant = (text) => new FakeElement(`ChatGPT said:\n\n${text}`);
  const oldUser = makeUser("An earlier test request.");
  const oldAssistant = makeAssistant("Earlier answer.");
  const currentUser = makeUser(instruction);
  const currentAssistant = makeAssistant("BRIDGE TEST RESPONSE ONE.");
  const laterUser = makeUser("A separate later user turn.");
  const laterAssistant = makeAssistant("A separate later answer that must not be captured.");
  const turnPairs = [
    [oldUser, oldAssistant],
    [currentUser, currentAssistant],
    [laterUser, laterAssistant],
  ];
  const renderedUsers = [oldUser];
  for (const [user, assistant] of turnPairs) {
    const userWrapper = new FakeElement(user.innerText);
    const assistantWrapper = new FakeElement(assistant.innerText);
    user.parentElement = userWrapper;
    userWrapper.nextElementSibling = assistantWrapper;
    assistant.parentElement = assistantWrapper;
  }
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [];
      if (selector.includes('data-turn="user"') || selector.includes('data-turn="assistant"')) return [];
      if (selector.includes("data-content-search-unit-key") || selector.includes("data-chatgpt-search-unit-key")) return [];
      if (selector.includes('[class~="group/user-message"]')) return renderedUsers;
      if (selector.includes("button[aria-label]") || selector.includes("[role=button][aria-label]")) return [];
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const baseline = adapter.assistantResponseSnapshot(true, true);

  assert.equal(baseline.turnAnchor.turnCount, 2);
  assert.equal(baseline.lastText, "Earlier answer.");
  renderedUsers.push(currentUser, laterUser);
  const result = await adapter.waitForAssistantResponse({
    ...baseline,
    userTurnFingerprint: bridgeMessageFingerprint(instruction),
  }, 3000);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.responseText, "BRIDGE TEST RESPONSE ONE.");
  assert.equal(result.responseProvenance?.source, "assistant_turn");
  assert.equal(result.responseProvenance?.userTurnFingerprint, bridgeMessageFingerprint(instruction));
  assert.equal(result.responseProvenance?.assistantFingerprint, bridgeMessageFingerprint("BRIDGE TEST RESPONSE ONE."));
  assert.equal(result.responseProvenance?.generationFinished, true);
});

test("uses the prior durable turn identity when ChatGPT collapses the rendered message count", async () => {
  const instruction = "TEST ONLY — reply exactly: repeated diagnostic request.";
  const olderRoleMessages = Array.from({ length: 5 }, (_, index) => [
    new FakeElement(`Earlier user request ${index + 1}.`, { "data-message-author-role": "user" }),
    new FakeElement(`Earlier assistant response ${index + 1}.`, { "data-message-author-role": "assistant" }),
  ]).flat();
  const priorUser = new FakeElement(`You said: ${instruction}`, { "data-content-search-unit-key": "fallback-turn-5:0:user" });
  const priorAssistant = new FakeElement("ChatGPT said: Prior answer to the repeated diagnostic request.", {
    "data-content-search-unit-key": "fallback-turn-5:1:assistant",
    "data-chatgpt-selection-message-id": "prior-assistant-turn-id",
  });
  const currentUser = new FakeElement(`You said: ${instruction}… Show more`, { "data-chatgpt-search-unit-key": "fallback-turn-6:0:user" });
  const listingResponse = JSON.stringify({ request_id: "66fa9d24-5433-4f53-8ee9-55ec44bd6ad7", company: "UK Atomic Energy Authority", title: "Computational Scientist", description: "A source-grounded description of this research role with responsibilities and required experience.", email: "talent@ukaea.org.uk", salary_source: "not_available", salary_basis: [] });
  const currentAssistant = new FakeElement(`ChatGPT said: ${listingResponse}`, {
    "data-chatgpt-search-unit-key": "fallback-turn-6:1:assistant",
    "data-chatgpt-selection-message-id": "current-assistant-turn-id",
  });
  // innerText includes a layout newline inserted around a link, although the
  // message's text source is still valid JSON.
  currentAssistant.innerText = currentAssistant.textContent.replace("talent@ukaea.org.uk", "talent@\nukaea.org.uk");
  let collapsed = false;
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return collapsed ? [] : olderRoleMessages;
      if (selector.includes('data-turn="user"') || selector.includes('data-turn="assistant"')) return [];
      if (selector.includes("data-content-search-unit-key") || selector.includes("data-chatgpt-search-unit-key")) {
        return collapsed ? [priorUser, priorAssistant, currentUser, currentAssistant] : [priorUser, priorAssistant];
      }
      if (selector.includes('[class~="group/user-message"]')) return [];
      if (selector.includes("button[aria-label]") || selector.includes("[role=button][aria-label]")) return [];
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const baseline = adapter.assistantResponseSnapshot(true, true);
  assert.equal(baseline.turnAnchor.turnCount, 12);
  assert.equal(baseline.turnAnchor.lastAssistantMessageId, "prior-assistant-turn-id");
  assert.equal(baseline.userTurnMessageId, undefined);

  // The same prompt already exists, and the renderer has replaced its 12-node
  // history with four search-unit nodes. The dispatch must use the last
  // durable pre-send assistant identity, not the stale numeric turn count.
  collapsed = true;
  const messages = adapter.messageElements();
  assert.equal(adapter.userTurnAfterBoundary(instruction, baseline.turnAnchor), currentUser);
  assert.equal(adapter.matchingUserMessageIndex(instruction, messages, baseline.turnAnchor, bridgeMessageFingerprint(instruction), null), 2);
  const result = await adapter.waitForAssistantResponse({
    ...baseline,
    userTurnFingerprint: bridgeMessageFingerprint(instruction),
  }, 3000);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.responseText, listingResponse);
  assert.equal(JSON.parse(result.responseText).email, "talent@ukaea.org.uk");
  assert.equal(result.responseProvenance?.source, "assistant_turn");
  assert.equal(result.responseProvenance?.userTurnFingerprint, bridgeMessageFingerprint(instruction));
  assert.equal(result.responseProvenance?.assistantMessageId, "current-assistant-turn-id");
});

test("captures and recovers the exact turn when ChatGPT collapses a long prompt without exposing its message id", async () => {
  const instruction = `TEST ONLY — compare this job with the verified candidate profile. ${"evidence and criteria ".repeat(280)}`;
  const oldUser = new FakeElement("You said: Earlier request.", { "data-message-author-role": "user", "data-message-id": "old-user" });
  const oldAssistant = new FakeElement("ChatGPT said: Earlier answer.", { "data-message-author-role": "assistant", "data-message-id": "old-assistant" });
  const visiblePrefix = bridgeMessageFingerprint(instruction);
  const normalisedInstruction = instruction.replace(/\s+/gu, " ").trim();
  const currentUser = new FakeElement(`You said: ${normalisedInstruction.slice(0, 128)}… Show more`, { "data-message-author-role": "user" });
  const currentAssistant = new FakeElement("ChatGPT said: {\"fit_score\":82,\"summary\":\"Evidence-based fit\"}", {
    "data-message-author-role": "assistant",
    "data-message-id": "current-assistant",
  });
  const messages = [oldUser, oldAssistant, currentUser, currentAssistant];
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return messages;
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [];
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/g/g-p-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const anchor = {
    conversationUrl,
    turnCount: 2,
    lastUserFingerprint: bridgeMessageFingerprint("Earlier request."),
    lastAssistantFingerprint: bridgeMessageFingerprint("Earlier answer."),
    lastUserMessageId: "old-user",
    lastAssistantMessageId: "old-assistant",
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const baseline = {
    count: 1,
    lastText: "Earlier answer.",
    turnAnchor: anchor,
    userTurnFingerprint: visiblePrefix,
    userTurnMessageId: null,
    userTurnPrefix: normalisedInstruction.slice(0, 128),
  };
  assert.equal(adapter.messageElements().length, 4);
  assert.equal(adapter.userTurnIndicesAfterBoundary(adapter.messageElements(), anchor).length, 1);
  assert.equal(adapter.visiblePromptPrefixMatches(currentUser, baseline.userTurnPrefix), true);
  assert.equal(adapter.preSendMessageBoundaryIndex(adapter.messageElements(), anchor), 1);
  assert.equal(adapter.assistantResponseText(currentAssistant), '{"fit_score":82,"summary":"Evidence-based fit"}');
  assert.equal(adapter.detectGenerationStarted(), false);

  const captured = await adapter.waitForAssistantResponse(baseline, 3000);
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(captured.responseText, '{"fit_score":82,"summary":"Evidence-based fit"}');
  assert.equal(captured.responseProvenance?.userTurnFingerprint, visiblePrefix);
  assert.equal(captured.responseProvenance?.userTurnMessageId, null);
  assert.equal(captured.responseProvenance?.assistantMessageId, "current-assistant");

  const recovered = await adapter.checkExistingDispatchResponse(
    instruction,
    1000,
    undefined,
    undefined,
    undefined,
    anchor,
    visiblePrefix,
    null,
  );
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.existingResponseText, captured.responseText);
  assert.equal(recovered.responseProvenance?.assistantMessageId, "current-assistant");
});

test("fails closed when a collapsed prompt has multiple candidate user turns after its boundary", async () => {
  const instruction = `TEST ONLY — compare this job with the verified candidate profile. ${"evidence and criteria ".repeat(280)}`;
  const normalisedInstruction = instruction.replace(/\s+/gu, " ").trim();
  const oldUser = new FakeElement("Earlier request.", { "data-message-author-role": "user", "data-message-id": "old-user" });
  const oldAssistant = new FakeElement("Earlier answer.", { "data-message-author-role": "assistant", "data-message-id": "old-assistant" });
  const currentUser = new FakeElement(`You said: ${normalisedInstruction.slice(0, 128)}… Show more`, { "data-message-author-role": "user" });
  const unrelatedUser = new FakeElement("A separate user message.", { "data-message-author-role": "user" });
  const currentAssistant = new FakeElement("Potentially ambiguous answer.", { "data-message-author-role": "assistant", "data-message-id": "current-assistant" });
  const messages = [oldUser, oldAssistant, currentUser, unrelatedUser, currentAssistant];
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return messages;
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [];
      return [];
    },
  };
  const anchor = {
    conversationUrl,
    turnCount: 2,
    lastUserFingerprint: bridgeMessageFingerprint("Earlier request."),
    lastAssistantFingerprint: bridgeMessageFingerprint("Earlier answer."),
    lastUserMessageId: "old-user",
    lastAssistantMessageId: "old-assistant",
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  assert.equal(adapter.matchingUserMessageIndex(instruction, messages, anchor, bridgeMessageFingerprint(instruction), null), -1);
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: "Earlier answer.",
    turnAnchor: anchor,
    userTurnFingerprint: bridgeMessageFingerprint(instruction),
    userTurnPrefix: normalisedInstruction.slice(0, 128),
  }, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "response_not_captured");
});

test("does not capture a hydrated pre-send assistant node even when it appears after the new user turn", async () => {
  const instruction = "TEST ONLY — assess this exact saved job source.";
  const oldUser = new FakeElement("Earlier request", { "data-message-author-role": "user", "data-message-id": "old-user" });
  const oldAssistant = new FakeElement("ChatGPT said: Previous job assessment", { "data-message-author-role": "assistant", "data-message-id": "assistant-before-send" });
  const currentUser = new FakeElement(`You said: ${instruction}`, { "data-message-author-role": "user", "data-message-id": "new-user" });
  // Project history hydration can transiently reorder a pre-existing answer
  // after the new user turn and increase the count. Its durable ID must still
  // fence it out of the current response.
  const rendered = [oldUser, currentUser, oldAssistant];
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return rendered;
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [];
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: "Previous job assessment",
    turnAnchor: {
      conversationUrl,
      turnCount: 2,
      lastUserFingerprint: bridgeMessageFingerprint("Earlier request"),
      lastAssistantFingerprint: bridgeMessageFingerprint("Previous job assessment"),
      lastUserMessageId: "old-user",
      lastAssistantMessageId: "assistant-before-send",
    },
    userTurnFingerprint: bridgeMessageFingerprint(instruction),
    userTurnMessageId: "new-user",
  }, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "response_not_captured");
});

test("read-only response recovery rejects the pre-send assistant turn even when it is rendered after the matching user turn", async () => {
  const instruction = "TEST ONLY — assess this exact saved job source.";
  const oldUser = new FakeElement("Earlier request", { "data-message-author-role": "user", "data-message-id": "old-user" });
  const oldAssistant = new FakeElement("ChatGPT said: Previous job assessment", { "data-message-author-role": "assistant", "data-message-id": "assistant-before-send" });
  const currentUser = new FakeElement(`You said: ${instruction}`, { "data-message-author-role": "user", "data-message-id": "new-user" });
  const rendered = [oldUser, currentUser, oldAssistant];
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return rendered;
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const anchor = {
    conversationUrl,
    turnCount: 2,
    lastUserFingerprint: bridgeMessageFingerprint("Earlier request"),
    lastAssistantFingerprint: bridgeMessageFingerprint("Previous job assessment"),
    lastUserMessageId: "old-user",
    lastAssistantMessageId: "assistant-before-send",
  };
  const result = await adapter.checkExistingDispatchResponse(
    instruction,
    1000,
    conversationUrl,
    undefined,
    undefined,
    anchor,
    bridgeMessageFingerprint(instruction),
    "new-user",
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "response_not_ready");
  assert.match(result.reason, /completed assistant response is not available/i);
  assert.match(result.reason, /pre-send turns excluded: 1/i);
});

test("fit recovery reads its exact assistant JSON turn without using the profile-file reader or sending again", async () => {
  const instruction = "TEST ONLY — prepare criteria for this exact saved job source.";
  const responseText = JSON.stringify({ criteria: [{ text: "C++", dimension: "technical", importance: "essential" }] });
  const oldUser = new FakeElement("Earlier fit request", { "data-message-author-role": "user", "data-message-id": "old-user" });
  const oldAssistant = new FakeElement("Earlier fit response", { "data-message-author-role": "assistant", "data-message-id": "old-assistant" });
  const currentUser = new FakeElement(`You said: ${instruction}`, { "data-message-author-role": "user", "data-message-id": "new-user" });
  const currentAssistant = new FakeElement(`ChatGPT said: ${responseText}`, { "data-message-author-role": "assistant", "data-message-id": "current-assistant" });
  const messages = [oldUser, oldAssistant, currentUser, currentAssistant];
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return messages;
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  adapter.detectGenerationStarted = () => true;
  adapter.assistantHasCompletionMarker = () => true;
  const result = await adapter.checkExistingDispatchResponse(
    instruction,
    1000,
    conversationUrl,
    undefined,
    undefined,
    {
      conversationUrl,
      turnCount: 2,
      lastUserFingerprint: bridgeMessageFingerprint("Earlier fit request"),
      lastAssistantFingerprint: bridgeMessageFingerprint("Earlier fit response"),
      lastUserMessageId: "old-user",
      lastAssistantMessageId: "old-assistant",
    },
    bridgeMessageFingerprint(instruction),
    "new-user",
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.delivery, "reused");
  assert.equal(result.existingResponseText, responseText);
  assert.equal(result.responseProvenance?.source, "assistant_turn");
  assert.equal(result.responseProvenance?.userTurnMessageId, "new-user");
  assert.equal(result.responseProvenance?.assistantMessageId, "current-assistant");
  assert.equal(result.responseProvenance?.generationFinished, true);
});

test("read-only exact-turn recovery does not label a partial assistant stream as finished", async () => {
  const instruction = "TEST ONLY — assess this exact saved job source.";
  const oldUser = new FakeElement("Earlier request", { "data-message-author-role": "user", "data-message-id": "old-user" });
  const oldAssistant = new FakeElement("Earlier answer", { "data-message-author-role": "assistant", "data-message-id": "old-assistant" });
  const currentUser = new FakeElement(`You said: ${instruction}`, { "data-message-author-role": "user", "data-message-id": "new-user" });
  const partialAssistant = new FakeElement("{\"summary\":\"still streaming", { "data-message-author-role": "assistant", "data-message-id": "current-assistant" });
  const messages = [oldUser, oldAssistant, currentUser, partialAssistant];
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return messages;
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  adapter.detectGenerationStarted = () => true;
  adapter.assistantHasCompletionMarker = () => false;
  const result = await adapter.checkExistingDispatchResponse(
    instruction, 1000, conversationUrl, undefined, undefined,
    {
      conversationUrl, turnCount: 2,
      lastUserFingerprint: bridgeMessageFingerprint("Earlier request"),
      lastAssistantFingerprint: bridgeMessageFingerprint("Earlier answer"),
      lastUserMessageId: "old-user", lastAssistantMessageId: "old-assistant",
    },
    bridgeMessageFingerprint(instruction), "new-user",
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "response_not_ready");
  assert.match(result.reason, /still appears to be generating/i);
});

test("captures the exact response through ChatGPT fallback turn keys in a background-rendered conversation", async () => {
  const instruction = "TEST ONLY — Please reply with exactly: BRIDGE LIVE TEST 1";
  const oldUser = new FakeElement("You said: Earlier diagnostic.", { "data-content-search-unit-key": "fallback-turn-4:0:user" });
  const oldAssistant = new FakeElement("ChatGPT said: OK", {
    "data-content-search-unit-key": "fallback-turn-4:1:assistant",
    "data-chatgpt-selection-message-id": "old-assistant-id",
  });
  const currentUser = new FakeElement(`You said: ${instruction}`, { "data-content-search-unit-key": "fallback-turn-5:0:user" });
  // The current ChatGPT renderer can stamp the same fallback search-unit key
  // on multiple wrappers. It is one user turn, not two adjacent turns.
  const duplicateCurrentUser = new FakeElement(`You said: ${instruction}`, { "data-chatgpt-search-unit-key": "fallback-turn-5:0:user" });
  const currentAssistant = new FakeElement("ChatGPT said: OK", { "data-content-search-unit-key": "fallback-turn-5:2:assistant" });
  const assistantContent = new FakeElement("OK", { "data-chatgpt-selection-message-id": "current-assistant-id" });
  const currentTurn = new FakeElement("", { "data-content-search-turn-key": "fallback-turn-5" });
  currentAssistant.parentElement = currentTurn;
  currentAssistant.querySelectorAll = (selector) => selector.includes("data-chatgpt-selection-message-id") ? [assistantContent] : [];
  const rendered = [oldUser, oldAssistant, currentUser, duplicateCurrentUser, currentAssistant];
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [];
      if (selector.includes('data-turn="user"') || selector.includes('data-turn="assistant"')) return [];
      if (selector.includes("data-content-search-unit-key") || selector.includes("data-chatgpt-search-unit-key")) return rendered;
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: "OK",
    turnAnchor: {
      conversationUrl,
      turnCount: 2,
      lastUserFingerprint: bridgeMessageFingerprint("Earlier diagnostic."),
      lastAssistantFingerprint: bridgeMessageFingerprint("OK"),
      lastAssistantMessageId: "old-assistant-id",
    },
    userTurnFingerprint: bridgeMessageFingerprint(instruction),
  }, 3000);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.responseText, "OK");
  assert.equal(result.responseProvenance?.source, "assistant_turn");
  assert.equal(result.responseProvenance?.userTurnFingerprint, bridgeMessageFingerprint(instruction));
  assert.equal(result.responseProvenance?.assistantMessageId, "current-assistant-id");
  assert.equal(adapter.assistantTurnBoundary(currentAssistant), currentTurn);
});

test("captures a long formatted prompt by its renderer turn id when visible text changes", async () => {
  const instruction = `Review these job listings and summarize the best match.\n\n${Array.from({ length: 42 }, (_, index) => `- [Role ${index + 1}](https://example.com/jobs/${index + 1}) — assess the title, location, and application link.`).join("\n")}`;
  const oldUser = new FakeElement("You said: Earlier request.", { "data-content-search-unit-key": "fallback-turn-4:0:user" });
  const oldAssistant = new FakeElement("ChatGPT said: Earlier answer.", { "data-content-search-unit-key": "fallback-turn-4:1:assistant", "data-chatgpt-selection-message-id": "old-assistant-id" });
  // The page renderer flattens the Markdown links and changes punctuation, so
  // its visible text no longer has the prompt's exact input fingerprint.
  const currentUser = new FakeElement("You said: Review these job listings and summarize the best match. Role 1 — assess the title, location and application link.", { "data-content-search-unit-key": "fallback-turn-5:0:user" });
  const currentAssistant = new FakeElement("ChatGPT said: BRIDGE LONG PROMPT CAPTURED", { "data-content-search-unit-key": "fallback-turn-5:2:assistant", "data-chatgpt-selection-message-id": "current-assistant-id" });
  const rendered = [oldUser, oldAssistant, currentUser, currentAssistant];
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [];
      if (selector.includes('data-turn="user"') || selector.includes('data-turn="assistant"')) return [];
      if (selector.includes("data-content-search-unit-key") || selector.includes("data-chatgpt-search-unit-key")) return rendered;
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: "Earlier answer.",
    turnAnchor: {
      conversationUrl,
      turnCount: 2,
      lastUserFingerprint: bridgeMessageFingerprint("Earlier request."),
      lastAssistantFingerprint: bridgeMessageFingerprint("Earlier answer."),
      lastAssistantMessageId: "old-assistant-id",
    },
    userTurnFingerprint: bridgeMessageFingerprint(instruction),
    userTurnMessageId: "fallback-turn-5:0:user",
  }, 3000);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.responseText, "BRIDGE LONG PROMPT CAPTURED");
  assert.equal(result.responseProvenance?.userTurnMessageId, "fallback-turn-5:0:user");
  assert.equal(result.responseProvenance?.userTurnFingerprint, bridgeMessageFingerprint(instruction));
  assert.equal(result.responseProvenance?.assistantMessageId, "current-assistant-id");
});

test("verifies a setup message when ChatGPT normalises composer whitespace", () => {
  const expected = "This conversation is dedicated to my professional background.\n\nRemember every detail I present here.";
  const composer = new FakeElement("This conversation is dedicated to my professional background.\n \nRemember   every detail I present here.", { contenteditable: "true", role: "textbox" });
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ authenticated: true }), { href: "https://chatgpt.com/g/g-p-jobhuntai/project", pathname: "/g/g-p-jobhuntai/project" });
  assert.equal(adapter.verifyComposerText(composer, expected, "workflow setup message"), null);
});

test("recovers one transient background-composer mismatch before the send boundary", async () => {
  const expected = "Frozen test-only assessment context. Do not update Memory.";
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ authenticated: true }), { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  let writes = 0;
  adapter.findComposer = () => composer;
  adapter.setComposerText = async (_composer, text) => {
    writes += 1;
    composer.textContent = writes === 1 ? "Frozen test-only assessment" : text;
    composer.innerText = composer.textContent;
    return null;
  };

  assert.equal(await adapter.setAndVerifyComposerText(composer, expected), null);
  assert.equal(writes, 2, "the exact composer text is retried once, before Send is authorized");
  assert.equal(adapter.verifyComposerText(composer, expected), null);
});

test("preserves ChatGPT's rendered Markdown editor state when verifying exact links and list items", async () => {
  const expected = [
    "- [Synthetic role 1](https://example.com/jobs/1) — Example City 1; inert text only.",
    "- [Synthetic role 2](https://example.com/jobs/2) — Example City 2; inert text only.",
  ].join("\n");
  const rendered = "Synthetic role 1 — Example City 1; inert text only.\nSynthetic role 2 — Example City 2; inert text only.";
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const anchors = [
    new FakeElement("Synthetic role 1", { href: "https://example.com/jobs/1" }),
    new FakeElement("Synthetic role 2", { href: "https://example.com/jobs/2" }),
  ];
  composer.querySelectorAll = (selector) => selector === "a[href]" ? anchors : [];
  const document = {
    baseURI: "https://chatgpt.com/",
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(command, _showUi, chunk) {
      assert.equal(command, "insertText");
      assert.equal(chunk, expected);
      composer.textContent = rendered;
      composer.innerText = rendered;
      return true;
    },
  };
  composer.ownerDocument = document;
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  assert.equal(await adapter.setComposerText(composer, expected), null);
  assert.equal(composer.textContent, rendered, "the bridge must not overwrite ChatGPT's page-owned rich-text state");
  assert.equal(adapter.verifyComposerText(composer, expected), null);

  anchors[1] = new FakeElement("Synthetic role 2", { href: "https://example.com/jobs/wrong" });
  assert.equal(adapter.verifyComposerText(composer, expected).code, "composer_mismatch");
});

test("accepts ChatGPT's inserted spaces around a Markdown URL only when the complete URL matches", async () => {
  const expected = "- [Synthetic role](https://example.com/jobs/test)";
  const rendered = "- [Synthetic role]( https://example.com/jobs/test )";
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  composer.querySelectorAll = () => [];
  const document = {
    baseURI: "https://chatgpt.com/",
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(command, _showUi, chunk) {
      assert.equal(command, "insertText");
      assert.equal(chunk, expected);
      composer.textContent = rendered;
      composer.innerText = rendered;
      return true;
    },
  };
  composer.ownerDocument = document;
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  assert.equal(await adapter.setComposerText(composer, expected), null);
  assert.equal(composer.textContent, rendered, "the semantically equivalent editor value must remain untouched");
  assert.equal(adapter.verifyComposerText(composer, expected), null);

  composer.innerText = rendered.replace("/test", "/different");
  assert.equal(adapter.verifyComposerText(composer, expected).code, "composer_mismatch");
});

test("accepts an auto-linked raw JSON listing URL only when its exact href and surrounding text match", async () => {
  const url = "https://www.linkedin.com/jobs/view/4470948947/?alternateChannel=search&trackingId=Exact%3DValue";
  const expected = `{"jobs":[{"job_id":"11111111-1111-4111-8111-111111111111","listing_url":"${url}"}]}`;
  const label = "linkedin.com/jobs/view/4470948947/";
  const rendered = expected.replace(url, label);
  const anchor = new FakeElement(label, { href: url });
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  composer.querySelectorAll = (selector) => selector === "a[href]" ? [anchor] : [];
  const document = {
    baseURI: "https://chatgpt.com/",
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(command, _showUi, chunk) {
      assert.equal(command, "insertText");
      assert.equal(chunk, expected);
      composer.textContent = rendered;
      composer.innerText = rendered;
      return true;
    },
  };
  composer.ownerDocument = document;
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });

  assert.equal(await adapter.setComposerText(composer, expected), null);
  assert.equal(composer.textContent, rendered, "the verified editor-owned link rendering must remain untouched");
  assert.equal(adapter.verifyComposerText(composer, expected), null);

  anchor.attributes.href = `${url}&different=1`;
  assert.equal(adapter.verifyComposerText(composer, expected).code, "composer_mismatch", "a shortened display must never hide a changed destination");
  anchor.attributes.href = url;
  composer.innerText = rendered.replace("job_id", "wrong_id");
  assert.equal(adapter.verifyComposerText(composer, expected).code, "composer_mismatch", "unrelated composer text must still match exactly");
});

test("inserts long instructions as bounded contenteditable transactions and verifies the complete text", async () => {
  const instruction = `Prepare the complete profile interview below. ${"Ask for any missing onboarding detail. ".repeat(70)}`;
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const insertedChunks = [];
  const document = {
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(command, _showUi, chunk) {
      assert.equal(command, "insertText");
      insertedChunks.push(chunk);
      composer.textContent += chunk;
      composer.innerText = composer.textContent;
      return true;
    },
  };
  composer.ownerDocument = document;
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  assert.ok(instruction.length > 2000);
  assert.equal(await adapter.setComposerText(composer, instruction), null);
  assert.ok(insertedChunks.length > 1);
  assert.ok(insertedChunks.every((chunk) => chunk.length <= 1600));
  assert.equal(insertedChunks.join(""), instruction);
  assert.equal(adapter.verifyComposerText(composer, instruction), null);
});

test("inactive composer settling avoids Chrome-throttled page timers and still verifies every chunk", async () => {
  const instruction = `TEST ONLY — background insertion. ${"Use only this exact public job URL and do not change Memory. ".repeat(55)}`;
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  let selectionRange = null;
  let timerRequests = 0;
  const document = {
    visibilityState: "hidden",
    baseURI: "https://chatgpt.com/",
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    getSelection: () => ({ removeAllRanges() {}, addRange(range) { selectionRange = range; } }),
    createRange: () => ({
      target: null,
      atEnd: false,
      selectNodeContents(element) { this.target = element; this.atEnd = false; },
      collapse(toStart) { this.atEnd = !toStart; },
    }),
    execCommand(command, _showUi, chunk) {
      assert.equal(command, "insertText");
      const target = selectionRange.target;
      target.textContent = selectionRange.atEnd ? `${target.textContent}${chunk}` : chunk;
      target.innerText = target.textContent;
      return true;
    },
    querySelectorAll(selector) { return selector.includes("contenteditable") ? [composer] : []; },
  };
  composer.ownerDocument = document;
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = (...args) => { timerRequests += 1; return originalSetTimeout(...args); };
  try {
    assert.equal(await adapter.setComposerText(composer, instruction), null);
    assert.equal(adapter.verifyComposerText(composer, instruction), null);
    assert.equal(timerRequests, 0, "inactive composer setup must not wait on background-throttled page timers");
  } finally {
    window.setTimeout = originalSetTimeout;
  }
});

test("restarts long background insertion when ChatGPT replaces the composer before preserving its text", async () => {
  const instruction = `TEST ONLY — exact background composer recovery. ${"Assess only the supplied public job URL and do not change Memory. ".repeat(55)}`;
  const originalComposer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  let activeComposer = originalComposer;
  let selectionRange = null;
  let replacedOnce = false;
  const insertedChunks = [];
  const document = {
    getSelection: () => ({ removeAllRanges() {}, addRange(range) { selectionRange = range; } }),
    createRange: () => ({
      target: null,
      atEnd: false,
      selectNodeContents(element) { this.target = element; this.atEnd = false; },
      collapse(toStart) { this.atEnd = !toStart; },
    }),
    execCommand(command, _showUi, chunk) {
      assert.equal(command, "insertText");
      insertedChunks.push(chunk);
      const target = selectionRange.target;
      target.textContent = selectionRange.atEnd ? `${target.textContent}${chunk}` : chunk;
      target.innerText = target.textContent;
      if (!replacedOnce) {
        replacedOnce = true;
        activeComposer = new FakeElement("", { contenteditable: "true", role: "textbox" });
        activeComposer.ownerDocument = document;
      }
      return true;
    },
    querySelectorAll(selector) {
      return selector.includes("contenteditable") ? [activeComposer] : [];
    },
  };
  originalComposer.ownerDocument = document;
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  assert.ok(instruction.length > 2000);

  assert.equal(await adapter.setAndVerifyComposerText(originalComposer, instruction), null);
  assert.notEqual(activeComposer, originalComposer, "the composer was replaced during the first background insertion");
  assert.equal(adapter.verifyComposerText(activeComposer, instruction), null);
  assert.equal(insertedChunks.slice(-Math.ceil(instruction.length / 1600)).join(""), instruction, "the replacement composer receives the complete exact instruction once");
  assert.ok(insertedChunks.length > Math.ceil(instruction.length / 1600), "the test exercised a safe restart after the first partial write");
});

test("uses one semantic submit control but fails closed when Send is ambiguous", () => {
  const submit = new FakeElement("", { type: "submit" });
  const document = {
    querySelectorAll(selector) {
      return selector.includes("button") ? [submit] : [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/g/g-p-job-hunt/project", pathname: "/g/g-p-job-hunt/project" });
  const composer = new FakeElement("", {});
  composer.closest = () => ({ contains: (element) => element === submit });
  assert.equal(adapter.findSendControl(composer), submit);

  const first = new FakeElement("", { role: "button", "data-testid": "send-button" });
  const second = new FakeElement("", { role: "button", "data-testid": "send-button" });
  const ambiguousDocument = {
    querySelectorAll(selector) {
      return selector.includes("button") || selector.includes("data-testid") ? [first, second] : [];
    },
  };
  const ambiguousAdapter = adapterModule.adapterErrorForTest(ambiguousDocument, { href: "https://chatgpt.com/g/g-p-job-hunt/project", pathname: "/g/g-p-job-hunt/project" });
  assert.equal(ambiguousAdapter.findSendControl(), null);
});

test("accepts a send when ChatGPT starts generating before the composer clears", async () => {
  let generating = false;
  const send = new FakeElement("", { role: "button", "aria-label": "Send" });
  const stop = new FakeElement("", { role: "button", "aria-label": "Stop generating" });
  const composer = new FakeElement("A long-running profile request", { contenteditable: "true", role: "textbox" });
  send.onclick = () => { generating = true; };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author") || selector.includes("role=article")) return [];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return generating ? [stop] : [];
      if (selector.includes("button") || selector.includes("role=button")) return generating ? [stop] : [send];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-1111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  const result = await adapter.sendMessage(composer.textContent, composer);
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
});

test("sends from a background document without waiting for animation frames", async () => {
  let generating = false;
  let frameCalls = 0;
  const send = new FakeElement("", { role: "button", "aria-label": "Send" });
  const stop = new FakeElement("", { role: "button", "aria-label": "Stop generating" });
  const composer = new FakeElement("A background diagnostic message", { contenteditable: "true", role: "textbox" });
  send.onclick = () => { generating = true; };
  const document = {
    defaultView: {
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      requestAnimationFrame: () => { frameCalls += 1; },
    },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author") || selector.includes("role=article")) return [];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return generating ? [stop] : [send];
      if (selector.includes("button") || selector.includes("role=button")) return generating ? [stop] : [send];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-1111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  const result = await adapter.sendMessage(composer.textContent, composer);
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(frameCalls, 0);
});

test("ignores ChatGPT's disabled stop control after a response finishes", () => {
  const stop = new FakeElement("", { role: "button", "aria-label": "Stop answering" });
  stop.disabled = true;
  const document = {
    querySelectorAll(selector) {
      return selector.includes("button[aria-label]") || selector.includes("role=button][aria-label") ? [stop] : [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  assert.equal(adapter.detectGenerationStarted(), false);
});

test("records the one-time send boundary before clicking ChatGPT Send", async () => {
  let generating = false;
  let marked = false;
  let clicks = 0;
  const send = new FakeElement("", { role: "button", "aria-label": "Send" });
  const stop = new FakeElement("", { role: "button", "aria-label": "Stop generating" });
  const composer = new FakeElement("A diagnostic message", { contenteditable: "true", role: "textbox" });
  send.onclick = () => {
    assert.equal(marked, true);
    clicks += 1;
    generating = true;
  };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author") || selector.includes("role=article")) return [];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return generating ? [stop] : [send];
      if (selector.includes("button") || selector.includes("role=button")) return generating ? [stop] : [send];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-1111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  const result = await adapter.sendMessage(composer.textContent, composer, async () => { marked = true; });
  assert.equal(result.ok, true);
  assert.equal(clicks, 1);
});

test("keeps the pre-send turn boundary when the rendered user turn has no message id", async () => {
  let generating = false;
  let markedAnchor = null;
  const instruction = "A diagnostic message without a stable ChatGPT message id";
  const existingMessages = [
    new FakeElement("Earlier request", { "data-message-author-role": "user" }),
    new FakeElement("Earlier response", { "data-message-author-role": "assistant" }),
  ];
  const send = new FakeElement("", { role: "button", "aria-label": "Send" });
  const stop = new FakeElement("", { role: "button", "aria-label": "Stop generating" });
  const composer = new FakeElement(instruction, { contenteditable: "true", role: "textbox" });
  send.onclick = () => {
    existingMessages.push(new FakeElement(instruction, { "data-message-author-role": "user" }));
    generating = true;
  };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return existingMessages;
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return generating ? [stop] : [send];
      if (selector.includes("button") || selector.includes("role=button")) return generating ? [stop] : [send];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-1111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  const result = await adapter.sendMessage(instruction, composer, async (anchor) => { markedAnchor = anchor; });
  assert.equal(result.ok, true);
  assert.equal(markedAnchor?.turnCount, 2);
  assert.equal(result.turnAnchor?.turnCount, 2);
  assert.equal(result.userTurnMessageId, null);
  const recovered = adapter.verifyExistingDispatchMessage(instruction, undefined, undefined, undefined, result.turnAnchor, result.userTurnFingerprint, result.userTurnMessageId);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
});

test("persists ChatGPT's fallback turn key when it reformats a long prompt", async () => {
  const instruction = `Review the listings below.\n\n${Array.from({ length: 35 }, (_, index) => `- [Role ${index + 1}](https://example.com/jobs/${index + 1}) — compare these details.`).join("\n")}`;
  const oldUser = new FakeElement("Earlier prompt", { "data-content-search-unit-key": "fallback-turn-4:0:user" });
  const oldAssistant = new FakeElement("Earlier answer", { "data-content-search-unit-key": "fallback-turn-4:1:assistant" });
  let currentUser = null;
  let generating = false;
  let markedAnchor = null;
  const composer = new FakeElement(instruction, { contenteditable: "true", role: "textbox" });
  const send = new FakeElement("", { role: "button", "aria-label": "Send" });
  const stop = new FakeElement("", { role: "button", "aria-label": "Stop generating" });
  send.onclick = () => {
    currentUser = new FakeElement("You said: Review the listings below. Role 1 — compare these details.", { "data-content-search-unit-key": "fallback-turn-5:0:user" });
    generating = true;
  };
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [];
      if (selector.includes('data-turn="user"') || selector.includes('data-turn="assistant"')) return [];
      if (selector.includes("data-content-search-unit-key") || selector.includes("data-chatgpt-search-unit-key")) return [oldUser, oldAssistant, ...(currentUser ? [currentUser] : [])];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return generating ? [stop] : [send];
      if (selector.includes("button") || selector.includes("role=button")) return generating ? [stop] : [send];
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.sendMessage(instruction, composer, async (anchor) => { markedAnchor = anchor; });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.userTurnFingerprint, bridgeMessageFingerprint(instruction));
  assert.equal(result.userTurnMessageId, "fallback-turn-5:0:user");
  assert.equal(result.turnAnchor?.turnCount, 2);
  assert.equal(markedAnchor?.turnCount, 2);
  const recovered = adapter.verifyExistingDispatchMessage(instruction, undefined, undefined, undefined, result.turnAnchor, result.userTurnFingerprint, result.userTurnMessageId);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
});

test("does not click Send when the one-time send boundary cannot be recorded", async () => {
  let clicks = 0;
  const send = new FakeElement("", { role: "button", "aria-label": "Send" });
  send.onclick = () => { clicks += 1; };
  const composer = new FakeElement("A diagnostic message", { contenteditable: "true", role: "textbox" });
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [send];
      if (selector.includes("button") || selector.includes("role=button")) return [send];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-1111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  const result = await adapter.sendMessage(composer.textContent, composer, async () => { throw new Error("worker unavailable"); });
  assert.equal(result.ok, false);
  assert.equal(result.code, "send_state_unrecorded");
  assert.equal(clicks, 0);
});

test("does not treat a cleared composer as proof of delivery", async () => {
  const composer = new FakeElement("A short activation update", { contenteditable: "true", role: "textbox" });
  composer.value = "A short activation update";
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author") || selector.includes("role=article")) return [];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-1111-8111-111111111111", pathname: "/c/11111111-1111-1111-8111-111111111111" });
  composer.value = "";
  const result = await adapter.verifyMessageSent("A short activation update", composer, 5, "A short activation update");
  assert.equal(result.ok, false);
  assert.equal(result.code, "delivery_uncertain");
});

test("reuses an already visible complete professional-background response instead of duplicating it", async () => {
  const instruction = "Use the relevant information you already remember about me to prepare my professional profile.";
  const userMessage = new FakeElement(instruction, { "data-message-author-role": "user" });
  const assistantMessage = new FakeElement('{"profile":{},"questions":[]}Show moreShow less', { "data-message-author-role": "assistant" });
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const document = {
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage, assistantMessage];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/g/g-p-6a8de18b9f888191b4f97a5ad3d634f8-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.executeDispatch({
    requestId: "11111111-1111-4111-8111-111111111111",
    workflowKey: "profile.background",
    instruction,
    boundConversationUrl: conversationUrl,
    boundProjectName: "JobHuntAI",
  });
  assert.equal(result.ok, true);
  assert.equal(result.delivery, "reused");
  assert.equal(result.existingResponseText, '{"profile":{},"questions":[]}');
  assert.equal(result.artifactJson, '{"profile":{},"questions":[]}');
});

test("manual response check reuses a completed JSON response without sending", async () => {
  const instruction = "Use the relevant information you already remember about me to prepare my professional profile.";
  const userMessage = new FakeElement(instruction, { "data-message-author-role": "user" });
  const assistantMessage = new FakeElement('{"profile":{"first_name":"Ada"},"questions":[]}', { "data-message-author-role": "assistant" });
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage, assistantMessage];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.checkExistingProfessionalBackgroundResponse(instruction, 1000);
  assert.equal(result.ok, true);
  assert.equal(result.delivery, "reused");
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"},"questions":[]}');
});

test("recovery check reuses a completed plain response for a sent profile part without sending", async () => {
  const instruction = "Please remember source bundle part 1 of 4 and reply exactly Source bundle part 1 remembered.";
  const userMessage = new FakeElement(instruction, { "data-message-author-role": "user" });
  const assistantMessage = new FakeElement("Source bundle part 1 remembered.", { "data-message-author-role": "assistant" });
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage, assistantMessage];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.checkExistingDispatchResponse(instruction, 1000);
  assert.equal(result.ok, true);
  assert.equal(result.delivery, "reused");
  assert.equal(result.existingResponseText, "Source bundle part 1 remembered.");
});

test("confirms an already visible dispatch message without changing the composer", () => {
  const instruction = "Create a cover letter for the listing at https://example.com/job/1.";
  const userMessage = new FakeElement(instruction, { "data-message-author-role": "user" });
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = adapter.verifyExistingDispatchMessage(instruction);
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.delivery, "verified");
});

test("ignores matching messages outside the active conversation surface", () => {
  const instruction = "Create a cover letter for the listing at https://example.com/job/1.";
  const sidebarDecoy = new FakeElement(instruction, { "data-message-author-role": "user" });
  const realConversationMessage = new FakeElement("A different request", { "data-message-author-role": "user" });
  const conversationRoot = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [realConversationMessage];
      return [];
    },
  };
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelector(selector) { return selector === "#thread" ? conversationRoot : null; },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [sidebarDecoy];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = adapter.verifyExistingDispatchMessage(instruction);
  assert.equal(result.ok, false);
  assert.equal(result.code, "dispatch_message_not_found");
});

test("does not treat an unanswered visible professional-background prompt as a duplicate", async () => {
  const instruction = "Use the relevant information you already remember about me to prepare my professional profile.";
  const userMessage = new FakeElement(instruction, { "data-message-author-role": "user" });
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  composer.closest = () => null;
  const document = {
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: () => false,
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      return [];
    },
  };
  const conversationUrl = "https://chatgpt.com/g/g-p-6a8de18b9f888191b4f97a5ad3d634f8-jobhuntai/c/11111111-1111-4111-8111-111111111111";
  const adapter = adapterModule.adapterErrorForTest(document, { href: conversationUrl, pathname: new URL(conversationUrl).pathname });
  const result = await adapter.executeDispatch({
    requestId: "11111111-1111-4111-8111-111111111111",
    workflowKey: "profile.background",
    instruction,
    boundConversationUrl: conversationUrl,
    boundProjectName: "JobHuntAI",
  });
  assert.equal(result.code, "send_not_verified");
});

test("ignores ChatGPT's transient Thinking placeholder for structured profile responses", async () => {
  const thinking = new FakeElement("Thinking", { "data-message-author-role": "assistant" });
  const structured = new FakeElement('{"profile":{"first_name":"Ada"},"questions":[]}', { "data-message-author-role": "assistant" });
  const assistantMessages = [thinking];
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return assistantMessages;
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const baseline = { count: 0, lastText: "" };
  setTimeout(() => { assistantMessages.splice(0, assistantMessages.length, structured); }, 100);
  const result = await adapter.waitForAssistantResponse(baseline, 3000, "profile.background");
  assert.equal(result.ok, true);
  assert.equal(result.responseText, structured.textContent);
});

test("captures only the next stable assistant response after delivery", async () => {
  const oldResponse = new FakeElement("Earlier response", { "data-message-author-role": "assistant" });
  const nextResponse = new FakeElement("New bridge response", { "data-message-author-role": "assistant" });
  const assistantMessages = [oldResponse];
  let generating = true;
  const stop = new FakeElement("", { "aria-label": "Stop generating", role: "button" });
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return assistantMessages;
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return generating ? [stop] : [];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const baseline = adapter.assistantResponseSnapshot();
  setTimeout(() => { assistantMessages.push(nextResponse); generating = false; }, 100);
  const result = await adapter.waitForAssistantResponse(baseline, 3000);
  assert.equal(result.ok, true);
  assert.equal(result.responseText, "New bridge response");
});

test("accepts a turn-local Copy response marker when Stop answering is stale", async () => {
  const assistant = new FakeElement("Background reply", { "data-message-author-role": "assistant" });
  const copy = new FakeElement("", { "aria-label": "Copy response", role: "button", "data-testid": "copy-turn-action-button" });
  const actionBar = new FakeElement("", {});
  actionBar.querySelectorAll = (selector) => selector.includes("button") || selector.includes("role=button") ? [copy] : [];
  assistant.parentElement = actionBar;
  const stop = new FakeElement("", { "aria-label": "Stop answering", role: "button" });
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [assistant];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [stop];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "" }, 3000);
  assert.equal(result.ok, true);
  assert.equal(result.responseText, "Background reply");
});

test("captures a repeated response when ChatGPT virtualises the previous assistant turn", async () => {
  // A long ChatGPT thread can keep the visible assistant count unchanged by
  // evicting the previous node as the new response mounts. The durable turn
  // ids must still distinguish two identical diagnostic replies.
  const userMessage = new FakeElement("Point 3 diagnostic", {
    "data-message-author-role": "user",
    "data-message-id": "new-user",
  });
  const nextResponse = new FakeElement("OK", {
    "data-message-author-role": "assistant",
    "data-message-id": "new-assistant",
  });
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage, nextResponse];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: "OK",
    turnAnchor: { conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", turnCount: 1, lastUserFingerprint: "old-user", lastAssistantFingerprint: "old-assistant", lastAssistantMessageId: "old-assistant" },
    userTurnFingerprint: "new-user-fingerprint",
    userTurnMessageId: "new-user",
  }, 3000);
  assert.equal(result.ok, true);
  assert.equal(result.responseText, "OK");
});

test("waits for the current structured profile generation to finish before accepting JSON", async () => {
  const userMessage = new FakeElement("Build my current profile", { "data-message-author-role": "user", "data-message-id": "new-user" });
  const structured = new FakeElement('{"profile":{"first_name":"Ada"},"questions":[]}', { "data-message-author-role": "assistant" });
  const stop = new FakeElement("", { "aria-label": "Stop generating", role: "button" });
  let generating = true;
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [userMessage, structured];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return generating ? [stop] : [];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  setTimeout(() => { generating = false; }, 100);
  const result = await adapter.waitForAssistantResponse({
    count: 0,
    lastText: "",
    turnAnchor: { conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", turnCount: 0, lastUserFingerprint: "", lastAssistantFingerprint: "" },
    userTurnFingerprint: "new-user-fingerprint",
    userTurnMessageId: "new-user",
  }, 3000, "profile.background", true);
  assert.equal(result.ok, true);
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"},"questions":[]}');
  assert.equal(result.responseProvenance?.source, "assistant_turn");
  assert.equal(result.responseProvenance?.artifactKey, null);
  assert.equal(typeof result.responseProvenance?.assistantFingerprint, "string");
});

test("opens a visible professional-profile.json artifact when the assistant text has no JSON", async () => {
  let viewerOpen = false;
  const artifactButton = new FakeElement("Open file", { "aria-label": "Open file", role: "button" });
  artifactButton.parentElement = new FakeElement("professional-profile.json", {});
  artifactButton.onclick = () => { viewerOpen = true; };
  const user = new FakeElement("Build my current profile", { "data-message-author-role": "user", "data-message-id": "new-user" });
  const assistant = new FakeElement("professional-profile.json", { "data-message-author-role": "assistant" });
  assistant.querySelectorAll = (selector) => selector.includes("button") ? [artifactButton] : [];
  const profileCode = new FakeElement('{"profile":{"first_name":"Ada"}}');
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const document = {
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [user, assistant];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("[id^=\"artifact-code-preview-\"]")) return viewerOpen ? [profileCode] : [];
      if (selector.includes("button[aria-label]") || selector.includes("role=button")) return [artifactButton];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "", artifactCount: 0, userTurnFingerprint: "new-user-fingerprint", userTurnMessageId: "new-user" }, 3000, "profile.background", true);
  assert.equal(result.ok, true);
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"}}');
  assert.equal(result.responseProvenance?.source, "assistant_artifact");
  assert.equal(typeof result.responseProvenance?.artifactKey, "string");
  assert.equal(viewerOpen, true);
});

test("captures a profile artifact card rendered outside the assistant message", async () => {
  let viewerOpen = false;
  const user = new FakeElement("Build my current profile", { "data-message-author-role": "user", "data-message-id": "new-user" });
  const assistant = new FakeElement("I created the requested file.", { "data-message-author-role": "assistant" });
  const artifactButton = new FakeElement("onboarding-profile.json JSON Open file", { "aria-label": "onboarding-profile.json", role: "button" });
  artifactButton.onclick = () => { viewerOpen = true; };
  const artifactCard = new FakeElement("onboarding-profile.json JSON Open file", {});
  artifactButton.parentElement = artifactCard;
  const profileCode = new FakeElement('{"profile":{"first_name":"Ada"}}');
  const assistantMessages = [user, assistant];
  const document = {
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return assistantMessages;
      if (selector.includes("data-artifact-preview-surface-mount")) return viewerOpen ? [profileCode] : [];
      if (selector.includes("button[aria-label]") || selector.includes("[role=\"button\"]") || selector.includes("button, [role=button]")) return [artifactButton];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "", artifactCount: 0, userTurnFingerprint: "new-user-fingerprint", userTurnMessageId: "new-user" }, 3000, "profile.background", true);
  assert.equal(result.ok, true);
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"}}');
  assert.equal(result.responseProvenance?.source, "assistant_artifact");
  assert.equal(typeof result.responseProvenance?.artifactKey, "string");
  assert.equal(viewerOpen, true);
});

test("captures the artifact inside the exact current assistant turn", async () => {
  let viewerJson = null;
  const oldAssistant = new FakeElement("Earlier profile response", { "data-message-author-role": "assistant", "data-message-id": "old-assistant" });
  const oldSection = new FakeElement("", { "data-turn": "assistant" });
  const oldArtifactButton = new FakeElement("professional-profile.json JSON Open file", { "aria-label": "professional-profile.json", role: "button" });
  oldArtifactButton.onclick = () => { viewerJson = '{"profile":{"first_name":"Old"}}'; };
  oldArtifactButton.parentElement = oldSection;
  oldSection.querySelectorAll = (selector) => selector.includes("data-message-author-role") || selector.includes("data-message-author")
    ? [oldAssistant]
    : selector.includes("button") || selector.includes("role=button") ? [oldArtifactButton] : [];
  oldSection.querySelector = (selector) => selector.includes("data-message-author-role") || selector.includes("data-message-author") ? oldAssistant : null;
  oldAssistant.parentElement = oldSection;

  const currentUser = new FakeElement("Build my current profile", { "data-message-author-role": "user", "data-message-id": "new-user" });
  const currentAssistant = new FakeElement("I created the current profile file.", { "data-message-author-role": "assistant", "data-message-id": "new-assistant" });
  const currentSection = new FakeElement("", { "data-turn": "assistant" });
  const currentArtifactButton = new FakeElement("professional-profile.json JSON Open file", { "aria-label": "professional-profile.json", role: "button" });
  currentArtifactButton.onclick = () => { viewerJson = '{"profile":{"first_name":"Current"}}'; };
  currentArtifactButton.parentElement = currentSection;
  currentSection.querySelectorAll = (selector) => selector.includes("data-message-author-role") || selector.includes("data-message-author")
    ? [currentAssistant]
    : selector.includes("button") || selector.includes("role=button") ? [currentArtifactButton] : [];
  currentSection.querySelector = (selector) => selector.includes("data-message-author-role") || selector.includes("data-message-author") ? currentAssistant : null;
  currentAssistant.parentElement = currentSection;
  const profileCode = new FakeElement('{"profile":{"first_name":"Current"}}');
  const document = {
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [oldAssistant, currentUser, currentAssistant];
      if (selector.includes('data-turn="user"') || selector.includes('data-turn="assistant"')) return [oldSection, currentSection];
      if (selector.includes("data-artifact-preview-surface-mount")) return viewerJson ? [profileCode] : [];
      if (selector.includes("button[aria-label]") || selector.includes("role=button") || selector.includes("button, [role=button]")) return [oldArtifactButton, currentArtifactButton];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: "Earlier profile response",
    artifactCount: 1,
    turnAnchor: { conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", turnCount: 2, lastUserFingerprint: "old-user", lastAssistantFingerprint: "old-assistant", lastAssistantMessageId: "old-assistant", artifactCount: 1 },
    userTurnFingerprint: "new-user-fingerprint",
    userTurnMessageId: "new-user",
  }, 3000, "profile.background", true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Current"}}');
  assert.equal(result.responseProvenance?.assistantMessageId, "new-assistant");
  assert.equal(viewerJson, '{"profile":{"first_name":"Current"}}');
});

test("does not import an older JSON artifact while the current turn is mounting", async () => {
  const oldAssistant = new FakeElement('{"profile":{"first_name":"Old"}}', { "data-message-author-role": "assistant", "data-message-id": "old-assistant" });
  const currentUser = new FakeElement("Build my current profile", { "data-message-author-role": "user", "data-message-id": "new-user" });
  const currentAssistant = new FakeElement('{"profile":{"first_name":"Current"}}', { "data-message-author-role": "assistant", "data-message-id": "new-assistant" });
  const messages = [oldAssistant];
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return messages;
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  setTimeout(() => { messages.push(currentUser); }, 100);
  setTimeout(() => { messages.push(currentAssistant); }, 220);
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: '{"profile":{"first_name":"Old"}}',
    turnAnchor: { conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", turnCount: 1, lastUserFingerprint: "", lastAssistantFingerprint: "old", lastAssistantMessageId: "old-assistant" },
    userTurnFingerprint: "new-user-fingerprint",
    userTurnMessageId: "new-user",
  }, 3000, "profile.background", true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Current"}}');
  assert.equal(result.responseProvenance?.source, "assistant_turn");
  assert.equal(result.responseProvenance?.artifactKey, null);
  assert.equal(result.responseProvenance?.userTurnMessageId, "new-user");
  assert.equal(result.responseProvenance?.assistantMessageId, "new-assistant");
});

test("does not capture a profile artifact before the exact current user turn mounts", async () => {
  let viewerOpen = false;
  const artifactButton = new FakeElement("onboarding-profile.json JSON Open file", { "aria-label": "onboarding-profile.json", role: "button" });
  artifactButton.onclick = () => { viewerOpen = true; };
  const profileCode = new FakeElement('{"profile":{"first_name":"Ada"}}');
  const document = {
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [];
      if (selector.includes("data-artifact-preview-surface-mount")) return viewerOpen ? [profileCode] : [];
      if (selector.includes("button[aria-label]")) return [artifactButton];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({
    count: 0,
    lastText: "",
    artifactCount: 0,
    turnAnchor: { conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", turnCount: 0, lastUserFingerprint: "", lastAssistantFingerprint: "" },
    userTurnFingerprint: "new-user-fingerprint",
  }, 1000, "profile.background", true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "response_not_captured");
  assert.equal(viewerOpen, false);
});

test("fences a late-hydrated old artifact until the current assistant turn exists", async () => {
  let artifactVisible = false;
  let viewerOpen = false;
  const oldAssistant = new FakeElement("Earlier profile response", { "data-message-author-role": "assistant", "data-message-id": "old-assistant" });
  const currentUser = new FakeElement("Build my current profile", { "data-message-author-role": "user", "data-message-id": "new-user" });
  const currentAssistant = new FakeElement("I am still preparing the current profile.", { "data-message-author-role": "assistant", "data-message-id": "new-assistant" });
  const artifactButton = new FakeElement("professional-profile.json JSON Open file", { "aria-label": "professional-profile.json", role: "button" });
  artifactButton.parentElement = new FakeElement("professional-profile.json JSON Open file", {});
  artifactButton.onclick = () => { viewerOpen = true; };
  const oldProfileCode = new FakeElement('{"profile":{"first_name":"Old"}}');
  const messages = [oldAssistant];
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return messages;
      if (selector.includes("data-artifact-preview-surface-mount")) return viewerOpen ? [oldProfileCode] : [];
      if (selector.includes("button[aria-label]") || selector.includes("role=button")) return artifactVisible ? [artifactButton] : [];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  setTimeout(() => { artifactVisible = true; }, 80);
  setTimeout(() => { messages.push(currentUser); }, 180);
  setTimeout(() => { messages.push(currentAssistant); }, 300);
  const result = await adapter.waitForAssistantResponse({
    count: 1,
    lastText: "Earlier profile response",
    artifactCount: 0,
    turnAnchor: { conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", turnCount: 1, lastUserFingerprint: "", lastAssistantFingerprint: "old", lastAssistantMessageId: "old-assistant" },
    userTurnFingerprint: "new-user-fingerprint",
    userTurnMessageId: "new-user",
  }, 1000, "profile.background", true);
  assert.equal(result.ok, false);
  assert.equal(viewerOpen, false);
});

test("fixtures preserve the semantic safety markers", async () => {
  const ready = await readFile(path.join(directory, "fixtures/chatgpt-ready.html"), "utf8");
  const wrong = await readFile(path.join(directory, "fixtures/wrong-conversation.html"), "utf8");
  const permission = await readFile(path.join(directory, "fixtures/permission-modal.html"), "utf8");
  assert.match(ready, /contenteditable="true"/);
  assert.match(ready, /aria-label="Send"/);
  assert.match(wrong, />Personal</);
  assert.match(permission, /role="dialog"/);
});

test("serializes concurrent durable dispatch-record mutations", async () => {
  const stored = { ...storage.DEFAULT_SETTINGS, dispatchRecords: {} };
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return { ...stored, dispatchRecords: { ...stored.dispatchRecords } };
        },
        async set(patch) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          Object.assign(stored, patch);
        },
        async remove(keys) {
          for (const key of keys) delete stored[key];
        },
      },
    },
  };
  const record = (id) => ({ id, workflowKey: "bridge.diagnostic", instruction: id, boundConversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", boundProjectName: "JobHuntAI", sentVerified: false });
  await Promise.all([
    storage.mutateDispatchRecords((_settings, records) => { records.first = record("first"); return { patch: { dispatchRecords: records }, result: true }; }),
    storage.mutateDispatchRecords((_settings, records) => { records.second = record("second"); return { patch: { dispatchRecords: records }, result: true }; }),
  ]);
  assert.deepEqual(Object.keys(stored.dispatchRecords).sort(), ["first", "second"]);
});
