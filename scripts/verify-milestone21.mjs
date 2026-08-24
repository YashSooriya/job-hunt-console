import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error("M21 verification failed: " + message);
};

const migration = read("database/migrations/0043_m21_search_runs_and_context.sql");
const tools = read("apps/web/lib/chatgpt/mcp-tools.ts");
const mcp = read("apps/web/lib/chatgpt/mcp.ts");
const runsRoute = read("apps/web/app/api/search/runs/route.ts");
const sourcesRoute = read("apps/web/app/api/search/sources/route.ts");
const panel = read("apps/web/components/search-automation-panel.tsx");
const jobsPage = read("apps/web/app/jobs/page.tsx");

for (const table of ["job_search_sources", "job_search_runs", "job_search_run_jobs"]) must(migration.includes(`create table if not exists public.${table}`), "missing " + table);
must((migration.match(/enable row level security/g) || []).length >= 3, "search tables are not all RLS-enabled");
must(migration.includes("job_search_sources_owner") && migration.includes("job_search_runs_owner") && migration.includes("job_search_run_jobs_owner"), "search ownership policies missing");
must(migration.includes("private.attach_job_to_search_run") && migration.includes("private.attach_job_analysis_to_search_run"), "search result/run association triggers missing");
must(migration.includes("private.finalize_job_search_run_work_item"), "work-item finalization trigger missing");
must(migration.includes("public.chatgpt_ensure_search_run") && migration.includes("public.chatgpt_get_search_context"), "scoped MCP search RPCs missing");
must(tools.includes('name: "ensure_search_run"') && tools.includes('name: "get_search_context"'), "M21 MCP tools missing");
must(mcp.includes("chatgpt_get_search_context") && mcp.includes("chatgpt_ensure_search_run"), "M21 MCP routing missing");
must(runsRoute.includes("enqueue_job_search_run") && runsRoute.includes("job_search_runs"), "search run API missing queue/history path");
must(sourcesRoute.includes("sourceKey") && sourcesRoute.includes("job_search_sources"), "source controls missing");
must(panel.includes("Run search now") && panel.includes("jobs_deduped") && panel.includes("Last run"), "search automation dashboard missing");
must(jobsPage.includes("SearchAutomationPanel"), "Jobs dashboard does not expose recurring search status");
must(!runsRoute.includes("body.user_id") && !sourcesRoute.includes("body.user_id"), "search routes accept caller-supplied user identity");

console.log("Milestone 21 autonomous job-discovery contracts passed.");
