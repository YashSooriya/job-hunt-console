import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { tmpdir } from "node:os";

const directory = path.dirname(fileURLToPath(import.meta.url));
const generated = await mkdtemp(path.join(tmpdir(), `jobhunt-bridge-tests-${Date.now()}-`));
await build({ entryPoints: [path.join(directory, "../src/shared/protocol.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "protocol.mjs") });
await build({ entryPoints: [path.join(directory, "../src/content/ui-adapter.ts")], bundle: true, platform: "node", format: "esm", outfile: path.join(generated, "adapter.mjs") });
const protocol = await import(pathToFileURL(path.join(generated, "protocol.mjs")));
const adapterModule = await import(pathToFileURL(path.join(generated, "adapter.mjs")));

test("protocol rejects malformed dispatch hints and normalises safe reasons", () => {
  assert.equal(protocol.parsePageMessage({ type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: "bad", correlation_id: "bad", nonce: "x" }), null);
  const id = "11111111-1111-4111-8111-111111111111";
  const message = protocol.parsePageMessage({ type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: id, correlation_id: id, nonce: "nonce-1" });
  assert.deepEqual(message, { type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: id, correlation_id: id, nonce: "nonce-1" });
  assert.equal(protocol.safeReason("line one\nline two", "fallback"), "line one line two");
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
  matches(selector) { return selector.includes("role=option") || selector.includes("role=menuitem") || selector.includes("button") || selector.includes("li") || selector.includes("role=button"); }
}
globalThis.HTMLElement = FakeElement;

function fakeDocument({ project = true, modal = false } = {}) {
  const projectElement = project ? new FakeElement("Job Hunt", { "aria-label": "Job Hunt" }) : null;
  const modalElement = modal ? new FakeElement("Allow access", { role: "dialog", "aria-modal": "true" }) : null;
  return {
    body: { innerText: project ? "Job Hunt" : "Personal" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll(selector) {
      if (selector.includes("dialog") || selector.includes("aria-modal") || selector.includes("modal")) return modalElement ? [modalElement] : [];
      if (selector.includes("button") || selector.includes("role=button") || selector.includes("role=option") || selector.includes("role=menuitem") || selector.includes("li") || selector.includes("h1") || selector.includes("nav a")) return projectElement ? [projectElement] : [];
      return [];
    },
  };
}

test("adapter fails closed on wrong conversation and blocking modal", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const location = { href: `https://chatgpt.com/c/${id}`, pathname: `/c/${id}` };
  const adapter = adapterModule.adapterErrorForTest(fakeDocument(), location);
  assert.equal(adapter.verifyBoundConversation(location.href, "Job Hunt"), null);
  assert.equal(adapter.verifyBoundConversation(`https://chatgpt.com/c/${id}-other`, "Job Hunt").code, "wrong_conversation");
  const blocked = adapterModule.adapterErrorForTest(fakeDocument({ modal: true }), location).detectBlockingModal();
  assert.equal(blocked.code, "blocking_modal");
});

test("accepts the canonical Job Hunt Project URL when ChatGPT does not expose an exact Project label", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const conversationUrl = `https://chatgpt.com/g/g-p-1234567890abcdef-job-hunt/c/${id}`;
  const location = { href: conversationUrl, pathname: new URL(conversationUrl).pathname };
  const adapter = adapterModule.adapterErrorForTest(fakeDocument({ project: false }), location);
  assert.equal(adapter.verifyBoundConversation(conversationUrl, "Job Hunt"), null);
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
