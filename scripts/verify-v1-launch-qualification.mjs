import fs from "node:fs";
import assert from "node:assert/strict";

const sql=fs.readFileSync("database/migrations/0031_ats_acceptance_and_launch_status.sql","utf8");
const bridge=fs.readFileSync("supabase/functions/form-agent-bridge/index.ts","utf8");
const daemon=fs.readFileSync("apps/browser-agent/src/daemon.mjs","utf8");
const cli=fs.readFileSync("apps/browser-agent/src/cli.mjs","utf8");
const launchApi=fs.readFileSync("apps/web/app/api/launch-status/route.ts","utf8");
const settings=fs.readFileSync("apps/web/components/launch-qualification.tsx","utf8");
const acceptance=fs.readFileSync("scripts/verify-real-ats-acceptance.mjs","utf8");

assert(sql.includes("ats_acceptance_runs"));
assert(sql.includes("submit_clicked boolean not null default false check (submit_clicked = false)"));
assert(sql.includes("block_acceptance_session_submission"));
assert(sql.includes("Acceptance sessions are hard no-submit sessions"));
assert(sql.includes("start_form_agent_acceptance_session_for_device"));
assert(sql.includes("record_form_agent_acceptance_result"));
assert(sql.includes("get_v1_launch_status"));
assert(sql.includes("provider_family='greenhouse'") && sql.includes("provider_family='lever'") && sql.includes("provider_family='workday'"));
assert(sql.includes("'ashby','smartrecruiters','successfactors'"));
assert(sql.includes("provider_family='custom'"));
assert(bridge.includes('op === "acceptance_result"'));
assert(daemon.includes('childArgs.push("--no-submit")'));
assert(cli.includes('bridge.call("acceptance_result"'));
assert(launchApi.includes("v1_operational"));
assert(settings.includes("Source-backed browser fixtures are development evidence only"));
assert(acceptance.includes("Production form-agent remains provider-independent"));

console.log("V1 launch-qualification contract passed.");
console.log("Live operational status remains external until hosted OAuth, paired Mac and genuine live ATS acceptance records exist.");
