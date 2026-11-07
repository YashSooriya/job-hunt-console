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
const m05 = read("database/migrations/20261107163734_m05_explicit_apply_choice.sql");

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
const m05Preparation = m05.match(/create or replace function private\.prepare_application_for_user\([\s\S]*?\$\$;/)?.[0] || "";
must(m05Preparation.includes("explicit_application_choice_required") && m05Preparation.includes("'user_required'"), "M05 does not park legacy preparation requests behind explicit apply choice");
must(!/insert\s+into\s+public\.(applications|automation_tasks|documents|document_generation_requests|form_agent_sessions)/i.test(m05Preparation), "M22 preparation can still create application work without the Job Pool choice");

console.log("Milestone 22 automatic application-preparation contracts passed.");
