import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const must = (condition, message) => { if (!condition) throw new Error("M23 verification failed: " + message); };

const migration = read("database/migrations/0046_m23_browser_reasoning_loop.sql");
const bridge = read("supabase/functions/form-agent-bridge/index.ts");
const panel = read("apps/web/components/form-agent-panel.tsx");
const statusRoute = read("apps/web/app/api/applications/[id]/form/status/route.ts");
const cli = read("apps/browser-agent/src/cli.mjs");

must(migration.includes("browser_agent_reasoning") && migration.includes("enable row level security"), "browser reasoning table/RLS missing");
must(migration.includes("private.enqueue_browser_question_work_item") && migration.includes("browser_helper_question_work_item"), "needs-user work-item trigger missing");
must(migration.includes("public.chatgpt_get_browser_question_context") && migration.includes("public.chatgpt_propose_browser_reasoning"), "token-bound browser reasoning RPCs missing");
must(migration.includes("requires_user") && migration.includes("automatic_actions_allowed"), "browser reasoning safety response missing");
must(migration.includes("review_browser_reasoning_current_user") && migration.includes("resumed',false"), "explicit user review boundary missing");
must(!migration.includes("update public.form_agent_sessions set status='active'"), "M23 migration must not resume browser sessions");
must(bridge.includes("browser_agent_reasoning") && bridge.includes("browserReasoning"), "browser bridge does not return reasoning proposals");
must(panel.includes("Accept proposal") && panel.includes("Resume helper"), "user review/resume controls missing");
must(statusRoute.includes("browser_agent_reasoning"), "form status route does not expose reasoning proposals");
must(cli.includes("advisory only") && cli.includes("browserReasoning"), "local helper advisory loop missing");
must(!exists("apps/web/app/api/chatgpt/mcp/route.ts"), "retired plugin browser-reasoning route is still active");

console.log("Milestone 23 browser-helper reasoning-loop contracts passed.");
