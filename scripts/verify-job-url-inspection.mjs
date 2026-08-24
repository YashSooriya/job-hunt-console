import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const migration = read("database/migrations/0055_job_url_inspection.sql");
const tools = read("apps/web/lib/chatgpt/mcp-tools.ts");
const mcp = read("apps/web/lib/chatgpt/mcp.ts");
const route = read("apps/web/app/api/jobs/inspect/route.ts");
const form = read("apps/web/components/job-url-inspection-form.tsx");
const jobsPage = read("apps/web/app/jobs/page.tsx");
const detail = read("apps/web/app/jobs/[id]/page.tsx");
const applicationButton = read("apps/web/components/application-create-button.tsx");

function must(condition, message) {
  if (!condition) throw new Error(message);
}

must(migration.includes("create table if not exists public.job_url_inspection_requests"), "URL inspection queue table missing");
must(migration.includes("enable row level security") && migration.includes("job_url_inspection_requests_owner_select"), "URL inspection queue is not owner-protected");
must(migration.includes("chatgpt_get_pending_job_url_inspections_internal") && migration.includes("chatgpt_save_job_url_inspection_internal"), "ChatGPT URL inspection RPCs missing");
must(migration.includes("chatgpt_estimate") && migration.includes("salary_basis"), "Salary estimate provenance contract missing");
must(migration.includes("never_login_or_apply") && migration.includes("read_only_browsing"), "URL inspection safety boundary missing");
must(tools.includes('name: "get_pending_job_url_inspections"') && tools.includes('name: "save_job_url_inspection"') && tools.includes('name: "fail_job_url_inspection"'), "URL inspection MCP tools missing");
must(tools.includes('salary_source') && tools.includes('salary_confidence') && tools.includes('salary_basis'), "Salary extraction fields missing from MCP schema");
must(mcp.includes("chatgpt_get_pending_job_url_inspections") && mcp.includes("chatgpt_save_job_url_inspection"), "URL inspection MCP routing missing");
must(route.includes("normalizeJobListingUrl") && route.includes("job_url_inspection_requests"), "URL inspection API route missing validation or persistence");
must(form.includes("Inspect with ChatGPT") && form.includes("/api/jobs/inspect") && form.includes("recurring ChatGPT Task"), "Jobs UI does not expose queued ChatGPT URL inspection");
must(form.includes("const formElement = event.currentTarget") && form.includes("formElement.reset()"), "URL inspection form must retain its DOM form before awaiting the queue request");
must(jobsPage.includes("JobUrlInspectionForm"), "Jobs page does not mount URL inspection UI");
must(jobsPage.includes("Job pool") && jobsPage.includes("days") && jobsPage.includes("Choose to apply"), "Jobs page does not expose the unified application pool table");
must(jobsPage.includes("chatgpt_url") && jobsPage.includes("chatgpt_mcp"), "Job pool does not distinguish URL imports from ChatGPT discoveries");
must(applicationButton.includes("actionLabel"), "Application chooser cannot be reused from the job pool table");
must(detail.includes("ChatGPT listing extraction") && detail.includes("salarySource"), "Job detail does not show extraction provenance and salary source");

console.log("Job URL inspection verification passed.");
