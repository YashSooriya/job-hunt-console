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
await build({ entryPoints: [path.join(directory, "../src/content/ui-adapter.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "adapter.mjs") });
const protocol = await import(pathToFileURL(path.join(generated, "protocol.mjs")));
const storage = await import(pathToFileURL(path.join(generated, "storage.mjs")));
const runtimeMessaging = await import(pathToFileURL(path.join(generated, "runtime-messaging.mjs")));
const concurrency = await import(pathToFileURL(path.join(generated, "concurrency.mjs")));
const adapterModule = await import(pathToFileURL(path.join(generated, "adapter.mjs")));

test("protocol rejects malformed dispatch hints and normalises safe reasons", () => {
  assert.equal(protocol.EXTENSION_BUILD_ID, "test-build-1");
  assert.equal(protocol.parsePageMessage({ type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: "bad", correlation_id: "bad", nonce: "x" }), null);
  const id = "11111111-1111-4111-8111-111111111111";
  const message = protocol.parsePageMessage({ type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: id, correlation_id: id, nonce: "nonce-1", emitted_at: "2026-09-07T15:00:00.000Z" });
  assert.deepEqual(message, { type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: id, correlation_id: id, nonce: "nonce-1", emitted_at: "2026-09-07T15:00:00.000Z" });
  assert.deepEqual(protocol.parsePageMessage({ type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 1 }), { type: "JOBHUNT_BRIDGE_RESET_LOCAL", version: 1 });
  assert.equal(protocol.safeReason("line one\nline two", "fallback"), "line one line two");
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
  assert.equal(timers.length, 1);
  helper.dispose();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.kind, "context_invalidated");
  assert.equal(clearCalls, 1);
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
    concurrent_response_capture: 2,
  });
  assert.equal(protocol.supportsBridgeV2(protocol.BRIDGE_CAPABILITIES), true);
  assert.equal(protocol.supportsBridgeV2({ ...protocol.BRIDGE_CAPABILITIES, protocol_version: 1 }), false);
  assert.equal(protocol.supportsBridgeV2({ ...protocol.BRIDGE_CAPABILITIES, protocol_version: 2 }), true);
  assert.equal(protocol.supportsBridgeV2({ durable_dispatch_v2: true, send_authorization_v2: true, result_outbox_v1: true, concurrent_response_capture: 1 }), false);
  assert.equal(protocol.DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS, 15);
  assert.equal(protocol.MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS, 0);
  assert.equal(protocol.MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS, 300);
  assert.equal(protocol.CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS, 900000);
  assert.equal(protocol.RESPONSE_CHECK_DISPLAY_TITLE, "Check completed professional profile response");
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
globalThis.HTMLElement = FakeElement;
globalThis.window = { setTimeout };
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

test("verifies a setup message when ChatGPT normalises composer whitespace", () => {
  const expected = "This conversation is dedicated to my professional background.\n\nRemember every detail I present here.";
  const composer = new FakeElement("This conversation is dedicated to my professional background.\n \nRemember   every detail I present here.", { contenteditable: "true", role: "textbox" });
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ authenticated: true }), { href: "https://chatgpt.com/g/g-p-jobhuntai/project", pathname: "/g/g-p-jobhuntai/project" });
  assert.equal(adapter.verifyComposerText(composer, expected, "workflow setup message"), null);
});

test("accepts a long Memory interview instruction within the Website Bridge limit", () => {
  const instruction = `Prepare the complete profile interview below. ${"Ask for any missing onboarding detail. ".repeat(70)}`;
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const document = {
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: () => false,
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  assert.ok(instruction.length > 2000);
  assert.equal(adapter.setComposerText(composer, instruction), null);
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

test("accepts a complete structured profile while ChatGPT's stop control is still visible", async () => {
  const structured = new FakeElement('{"profile":{"first_name":"Ada"},"questions":[]}', { "data-message-author-role": "assistant" });
  const stop = new FakeElement("", { "aria-label": "Stop generating", role: "button" });
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [structured];
      if (selector.includes("button[aria-label]") || selector.includes("role=button][aria-label")) return [stop];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "" }, 3000, "profile.background", true);
  assert.equal(result.ok, true);
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"},"questions":[]}');
});

test("opens a visible professional-profile.json artifact when the assistant text has no JSON", async () => {
  let viewerOpen = false;
  const artifactButton = new FakeElement("Open file", { "aria-label": "Open file", role: "button" });
  artifactButton.parentElement = new FakeElement("professional-profile.json", {});
  artifactButton.onclick = () => { viewerOpen = true; };
  const assistant = new FakeElement("professional-profile.json", { "data-message-author-role": "assistant" });
  assistant.querySelectorAll = (selector) => selector.includes("button") ? [artifactButton] : [];
  const profileCode = new FakeElement('{"profile":{"first_name":"Ada"}}');
  const composer = new FakeElement("", { contenteditable: "true", role: "textbox" });
  const document = {
    title: "JobHuntAI | ChatGPT",
    body: { innerText: "JobHuntAI" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("data-message-author-role") || selector.includes("data-message-author")) return [assistant];
      if (selector.includes("contenteditable") || selector.includes("textarea")) return [composer];
      if (selector.includes("[id^=\"artifact-code-preview-\"]")) return viewerOpen ? [profileCode] : [];
      if (selector.includes("button[aria-label]") || selector.includes("role=button")) return [artifactButton];
      return [];
    },
  };
  const adapter = adapterModule.adapterErrorForTest(document, { href: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", pathname: "/c/11111111-1111-4111-8111-111111111111" });
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "", artifactCount: 0 }, 3000, "profile.background", true);
  assert.equal(result.ok, true);
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"}}');
  assert.equal(viewerOpen, true);
});

test("captures a profile artifact card rendered outside the assistant message", async () => {
  let viewerOpen = false;
  const assistant = new FakeElement("I created the requested file.", { "data-message-author-role": "assistant" });
  const artifactButton = new FakeElement("onboarding-profile.json JSON Open file", { "aria-label": "onboarding-profile.json", role: "button" });
  artifactButton.onclick = () => { viewerOpen = true; };
  const artifactCard = new FakeElement("onboarding-profile.json JSON Open file", {});
  artifactButton.parentElement = artifactCard;
  const profileCode = new FakeElement('{"profile":{"first_name":"Ada"}}');
  const assistantMessages = [assistant];
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
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "", artifactCount: 0 }, 3000, "profile.background", true);
  assert.equal(result.ok, true);
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"}}');
  assert.equal(viewerOpen, true);
});

test("captures a profile artifact even while ChatGPT has not mounted an assistant message node", async () => {
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
  const result = await adapter.waitForAssistantResponse({ count: 0, lastText: "", artifactCount: 0 }, 3000, "profile.background", true);
  assert.equal(result.ok, true);
  assert.equal(result.artifactJson, '{"profile":{"first_name":"Ada"}}');
  assert.equal(viewerOpen, true);
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
