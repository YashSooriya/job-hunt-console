import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const must = (condition, message) => { if (!condition) throw new Error("M22 verification failed: " + message); };

const migration = read("database/migrations/0044_m22_automatic_application_preparation.sql");
const route = read("apps/web/app/api/applications/preparation/route.ts");
const panel = read("apps/web/components/preparation-automation-panel.tsx");
const appsPage = read("apps/web/app/applications/page.tsx");

must(migration.includes("application_preparation_requests"), "preparation request table missing");
must(migration.includes("enable row level security") && migration.includes("application_preparation_requests_owner"), "preparation request RLS missing");
must(migration.includes("private.prepare_application_for_user"), "trusted automatic preparation helper missing");
must(migration.includes("private.chatgpt_prepare_application_internal") && migration.includes("public.chatgpt_prepare_application"), "token-bound preparation RPC missing");
must(migration.includes("private.chatgpt_get_application_preparation_status_internal") && migration.includes("public.chatgpt_get_application_preparation_status"), "preparation status RPC missing");
must(migration.includes("Gate 1 remains mandatory") && migration.includes("submission_allowed"), "Gate 1/submission safety contract missing");
must(!migration.includes("grant execute on function private.prepare_application_for_user"), "arbitrary-user preparation helper is directly executable");
must(route.includes("application_preparation_requests") && !route.includes("body.user_id"), "preparation status route is not owner-scoped");
must(panel.includes("M22 automatic preparation") && panel.includes("Gate 1") && panel.toLowerCase().includes("no employer form"), "preparation status UI missing");
must(appsPage.includes("PreparationAutomationPanel"), "Applications page does not expose preparation requests");
must(!exists("apps/web/app/api/chatgpt/mcp/route.ts"), "retired plugin preparation route is still active");

console.log("Milestone 22 automatic application-preparation contracts passed.");
