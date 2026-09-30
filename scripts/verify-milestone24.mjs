import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const must = (condition, message) => { if (!condition) throw new Error("M24 verification failed: " + message); };

const migration = read("database/migrations/0047_m24_reliability_operations.sql");
const route = read("apps/web/app/api/operations/status/route.ts");
const panel = read("apps/web/components/automation-operations-panel.tsx");
const settings = read("apps/web/app/settings/page.tsx");
const runbook = read("docs/TWO_USER_ACCEPTANCE_RUNBOOK.md");

must(migration.includes("automation_rate_limits") && migration.includes("enable row level security"), "rate-limit table/RLS missing");
must(migration.includes("private.consume_automation_rate_limit_for_user") && migration.includes("public.chatgpt_consume_rate_limit"), "rate-limit RPC boundary missing");
must(migration.includes("chatgpt_recover_stale_work") && migration.includes("retry_cap_exceeded"), "stale-work recovery/retry cap missing");
must(migration.includes("chatgpt_get_pending_work_context") && migration.includes("limit"), "bounded pending-work RPC missing");
must(migration.includes("public.get_automation_operations_status") && migration.includes("active_runs"), "operations status RPC missing");
must(!migration.includes("grant execute on function private.consume_automation_rate_limit_for_user"), "arbitrary-user rate-limit helper is directly executable");
must(route.includes("get_automation_operations_status") && !route.includes("body.user_id"), "operations route is not current-user scoped");
must(panel.includes("M24 reliability") && panel.includes("Stale leases") && panel.includes("rate-limit"), "operations UI missing");
must(settings.includes("AutomationOperationsPanel"), "Settings page does not expose operations status");
must(runbook.includes("TWO-USER ACCEPTANCE PENDING") && runbook.toLowerCase().includes("do not fabricate"), "two-user acceptance runbook must be explicit about pending human work");
must(runbook.includes("membership") && runbook.includes("Gmail") && runbook.includes("browser helper") && runbook.includes("Gate 2"), "two-user isolation checklist incomplete");
must(!exists("apps/web/app/api/chatgpt/mcp/route.ts"), "retired plugin reliability route is still active");

console.log("Milestone 24 reliability, operations and acceptance contracts passed.");
