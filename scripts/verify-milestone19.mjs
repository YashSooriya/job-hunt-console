import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const must = (condition, message) => {
  if (!condition) throw new Error("M19 verification failed: " + message);
};

const retirement = read("database/migrations/0108_bridge_bulk_job_url_imports.sql");
const bridgeSecurity = read("database/migrations/0101_chatgpt_bridge_v3_security_boundary.sql");
const settingsPage = read("apps/web/app/settings/page.tsx");
const bridgeSettings = read("apps/web/components/chatgpt-bridge-settings.tsx");
const appNav = read("apps/web/components/app-nav.tsx");
const retiredPage = read("apps/web/app/chatgpt/page.tsx");
const proxy = read("apps/web/lib/supabase/proxy.ts");
const memorySetup = read("apps/web/components/chatgpt-memory-setup.tsx");

must(retirement.includes("update private.chatgpt_oauth_access_tokens") && retirement.includes("set revoked_at"), "retired plugin OAuth credentials are not revoked");
must(!retirement.includes("chatgpt_bridge_devices") && !retirement.includes("chatgpt_bridge_pairing_codes"), "plugin retirement must not revoke Website Bridge device credentials");
must(bridgeSecurity.includes("security invoker") && bridgeSecurity.includes("to service_role"), "v3 Website Bridge invoker wrappers/service-role boundary must remain intact");
for (const retired of [
  "apps/web/app/api/chatgpt/mcp/route.ts",
  "apps/web/app/api/chatgpt/status/route.ts",
  "apps/web/app/api/chatgpt/oauth/token/route.ts",
  "apps/web/app/api/chatgpt/oauth/authorize/route.ts",
  "apps/web/app/api/chatgpt/metadata/protected-resource/route.ts",
  "apps/web/lib/chatgpt/mcp.ts",
  "apps/web/lib/chatgpt/mcp-tools.ts",
  "apps/web/lib/chatgpt/oauth.ts",
]) must(!exists(retired), "retired ChatGPT plugin implementation still exists: " + retired);
must(retiredPage.includes('redirect("/settings#chatgpt-bridge")'), "old ChatGPT setup bookmarks do not lead to bridge settings");
must(!appNav.includes("ChatGPT integration") && !appNav.includes("/chatgpt"), "navigation still advertises the deleted plugin");
must(settingsPage.includes("ChatGptBridgeSettings") && !settingsPage.includes("ChatGptReasoningWorkerSettings"), "Settings does not present bridge-only setup");
must(bridgeSettings.includes("Website Bridge response capture with exact-turn provenance"), "bridge settings do not explain the current exact-turn result path");
must(!proxy.includes("/api/chatgpt/mcp") && !proxy.includes("/api/chatgpt/oauth") && !proxy.includes(".well-known"), "middleware still exposes retired plugin routes as public auth exceptions");
must(memorySetup.includes("notifyBridgeHints") && memorySetup.includes("/api/onboarding/memory"), "ChatGPT Memory setup no longer queues its work through the Website Bridge");

console.log("Milestone 19 bridge-only ChatGPT integration contracts passed.");
