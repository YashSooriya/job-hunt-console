import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(path.join(root, relative), "utf8");
const manifest = JSON.parse(await read("dist/manifest.json").catch(() => "{}"));
assert.equal(manifest.manifest_version, 3, "The built extension must be Manifest V3.");
assert.deepEqual(manifest.permissions?.slice().sort(), ["alarms", "storage", "tabs"], "The extension permissions must stay minimal.");
assert.ok(!manifest.host_permissions?.includes("<all_urls>"), "The extension must not request all-sites access.");
assert.deepEqual(manifest.host_permissions?.filter((value) => value.includes("chatgpt") || value.includes("openai")), ["https://chatgpt.com/*", "https://chat.openai.com/*"], "Only the supported ChatGPT origins may be granted.");
assert.equal(manifest.background?.service_worker, "background.js");
for (const file of ["background.js", "chatgpt.js", "jobhunt-bridge.js", "popup.js", "options.js", "popup.html", "options.html", "styles.css"]) await read(`dist/${file}`);

const source = await Promise.all(["src/background.ts", "src/content/chatgpt.ts", "src/content/jobhunt-bridge.ts", "src/content/ui-adapter.ts", "src/shared/backend-client.ts"].map(read));
const combined = source.join("\n");
for (const forbidden of ["OPENAI_API_KEY", "api.openai.com", "webRequest", "debugger", "chrome.cookies", "<all_urls>"]) assert.ok(!combined.includes(forbidden), `Bridge source contains forbidden capability: ${forbidden}`);
assert.match(combined, /EXECUTE_DISPATCH/);
assert.match(combined, /delivery_uncertain/);
assert.match(combined, /boundConversationUrl/);
console.log("ChatGPT bridge extension verification passed.");
