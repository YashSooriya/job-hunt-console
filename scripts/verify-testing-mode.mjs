import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [migration, setting, route, diagnosticsPage, dispatch, diagnosticMessage, bridgeTest, inspect, preferences, manualSearch, professionalDispatch, memory, controls] = await Promise.all([
  read("database/migrations/0106_chatgpt_testing_mode.sql"),
  read("apps/web/lib/chatgpt/testing-mode.ts"),
  read("apps/web/app/api/diagnostics/testing-mode/route.ts"),
  read("apps/web/app/diagnostics/page.tsx"),
  read("apps/web/app/api/chatgpt-bridge/dispatch/route.ts"),
  read("apps/web/app/api/chatgpt-bridge/diagnostic-message/route.ts"),
  read("apps/web/app/api/chatgpt-bridge/test/route.ts"),
  read("apps/web/app/api/jobs/inspect/route.ts"),
  read("apps/web/app/api/onboarding/preferences/route.ts"),
  read("apps/web/app/api/search/manual/route.ts"),
  read("apps/web/lib/chatgpt/professional-background-dispatch.ts"),
  read("apps/web/app/api/onboarding/memory/route.ts"),
  read("apps/web/lib/diagnostics/job-search-control-setting.ts"),
]);

assert.match(migration, /add column if not exists testing_mode_enabled boolean not null default false/i);
assert.doesNotMatch(migration, /create or replace function|service_role|security definer/i);
assert.match(setting, /TEST ONLY — The following message is a test\./);
assert.match(setting, /ChatGPT Memory or long-term memory/);
assert.match(route, /profile\.user_id/);
assert.match(diagnosticsPage, /DiagnosticsTestingModeToggle/);
for (const [name, source] of Object.entries({ dispatch, bridgeTest })) {
  assert.match(source, /prepareChatGptInstruction/, `${name} dispatch path lacks testing-mode enforcement`);
}
for (const [name, source] of Object.entries({ diagnosticMessage, preferences, manualSearch })) {
  assert.match(source, /applyChatGptTestingMode/, `${name} dispatch path lacks testing-mode enforcement`);
  assert.match(source, /chatGptInstructionBodyLimit/, `${name} does not reserve room for the test warning`);
}
assert.match(professionalDispatch, /applyChatGptTestingMode/);
assert.match(professionalDispatch, /readChatGptTestingMode/);
assert.match(professionalDispatch, /allowMemoryUpdate = args\.allowMemoryUpdate && !testingModeEnabled/, "test mode must disable Memory-writing prompts");
assert.match(memory, /prepareChatGptInstruction/);
assert.match(memory, /userId: user\.id/);
assert.match(inspect, /readChatGptTestingMode/);
assert.match(inspect, /applyChatGptTestingMode\([\s\S]*?testingModeEnabled\s*,\s*\)/);
assert.match(inspect, /create_chatgpt_dispatch_request_with_website_instruction/, "job URL inspection must use the Website Bridge path");
assert.doesNotMatch(inspect, /directOpenAiInspectionConfigured|openai\.responses\.create/, "job URL inspection must not bypass the Website Bridge");
assert.match(controls, /\.update\(setting\)/);
assert.doesNotMatch(controls, /\.upsert\(/, "upserting a diagnostics control could reset its sibling setting");

console.log("ChatGPT testing-mode verification passed.");
