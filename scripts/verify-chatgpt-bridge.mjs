import fs from "node:fs";
import path from "node:path";

const required = [
  "database/migrations/0057_chatgpt_browser_dispatch.sql",
  "supabase/functions/chatgpt-bridge/index.ts",
  "apps/web/lib/chatgpt/dispatch-registry.ts",
  "apps/web/lib/chatgpt/mcp-tools.ts",
  "apps/web/lib/chatgpt/mcp.ts",
  "apps/web/app/api/chatgpt-bridge/dispatch/route.ts",
  "apps/web/app/api/chatgpt-bridge/pairing/route.ts",
  "apps/web/app/api/chatgpt-bridge/status/route.ts",
  "apps/web/components/chatgpt-bridge-settings.tsx",
  "apps/chatgpt-bridge-extension/manifest.template.json",
  "docs/CHATGPT_BRIDGE.md",
  "docs/CHATGPT_BRIDGE_ACCEPTANCE.md",
];
let failed = false;
const fail = (message) => { console.error(`ChatGPT bridge verification: ${message}`); failed = true; };
for (const relative of required) if (!fs.existsSync(path.resolve(relative))) fail(`missing ${relative}`);

const migration = fs.readFileSync(path.resolve("database/migrations/0057_chatgpt_browser_dispatch.sql"), "utf8");
for (const marker of [
  "create table if not exists public.chatgpt_bridge_devices",
  "create table if not exists public.chatgpt_bridge_pairing_codes",
  "create table if not exists public.chatgpt_dispatch_requests",
  "alter table public.chatgpt_bridge_devices enable row level security",
  "chatgpt_bridge_devices_no_direct_client_access",
  "grant select, insert, update, delete on public.chatgpt_bridge_devices to service_role",
  "chatgpt_bridge_service_pair_device",
  "chatgpt_bridge_service_claim_dispatch",
  "chatgpt_claim_dispatch_request_internal",
  "chatgpt_save_document_draft_internal",
  "unique(user_id, idempotency_key)",
]) if (!migration.includes(marker)) fail(`migration is missing ${marker}`);
for (const forbidden of [
  "grant select, insert, update, delete on public.chatgpt_bridge_devices to authenticated",
  "grant select, insert, update, delete on public.chatgpt_dispatch_requests to authenticated",
  "OPENAI_API_KEY",
]) if (migration.includes(forbidden)) fail(`unsafe bridge marker present: ${forbidden}`);

const registry = fs.readFileSync(path.resolve("apps/web/lib/chatgpt/dispatch-registry.ts"), "utf8");
for (const action of ["job.inspect_url", "jobs.search.manual", "jobs.analyse_selected", "documents.cv.create", "documents.cover_letter.create", "emails.process_now", "tracker.sync_now", "bridge.diagnostic"]) if (!registry.includes(`"${action}"`)) fail(`dispatch registry is missing ${action}`);
const mcpTools = fs.readFileSync(path.resolve("apps/web/lib/chatgpt/mcp-tools.ts"), "utf8");
for (const tool of ["claim_dispatch_request", "update_dispatch_progress", "complete_dispatch_request", "fail_dispatch_request", "request_dispatch_user_action", "save_document_draft"]) if (!mcpTools.includes(`name: "${tool}"`)) fail(`MCP tool registry is missing ${tool}`);

const extensionSource = fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/background.ts"), "utf8") + fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/content/ui-adapter.ts"), "utf8");
for (const forbidden of ["OPENAI_API_KEY", "api.openai.com", "chrome.cookies", "webRequest", "<all_urls>"]) if (extensionSource.includes(forbidden)) fail(`extension contains forbidden capability ${forbidden}`);
if (!/(never resends automatically|Do not resend automatically|no automatic resend)/.test(extensionSource) || !extensionSource.includes("bound conversation")) fail("extension safe-stop or binding language is missing");

const employerHelper = fs.readFileSync(path.resolve("supabase/functions/form-agent-bridge/index.ts"), "utf8");
if (!employerHelper.includes("form-agent")) fail("existing employer-form helper was unexpectedly replaced or unrecognisable");
const bridge = fs.readFileSync(path.resolve("supabase/functions/chatgpt-bridge/index.ts"), "utf8");
if (bridge.includes("form-agent") || bridge.includes("FORM_AGENT")) fail("ChatGPT bridge references the employer-form helper boundary");

if (failed) process.exit(1);
console.log("ChatGPT bridge repository verification passed.");
