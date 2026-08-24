import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error("M19 verification failed: " + message);
};

const migration = read("database/migrations/0039_chatgpt_mcp_work_queue.sql");
const securityFollowUp = read("database/migrations/0040_m19_invoker_boundaries_and_indexes.sql");
const runtimeFix = read("database/migrations/0048_chatgpt_invoker_wrapper_runtime_fix.sql");
const auditFix = read("database/migrations/0049_chatgpt_audit_actor_type.sql");
const dispatcherFix = read("database/migrations/0050_chatgpt_internal_dispatchers.sql");
const tools = read("apps/web/lib/chatgpt/mcp-tools.ts");
const mcp = read("apps/web/app/api/chatgpt/mcp/route.ts");
const oauth = read("apps/web/app/api/chatgpt/oauth/token/route.ts") + read("apps/web/lib/chatgpt/oauth.ts") + read("apps/web/lib/chatgpt/mcp.ts");
const consent = read("apps/web/app/api/chatgpt/oauth/authorize/consent/route.ts");
const proxy = read("apps/web/lib/supabase/proxy.ts");
const setup = read("apps/web/app/chatgpt/page.tsx");

for (const table of ["chatgpt_work_items", "chatgpt_reasoning_results", "chatgpt_oauth_authorization_codes", "chatgpt_oauth_access_tokens"]) {
  must(migration.includes(table), "missing " + table);
}
for (const tool of [
  "get_candidate_profile", "get_search_preferences", "get_pending_work", "get_application_context",
  "get_verified_evidence", "get_reusable_answers", "get_browser_agent_question_context",
  "save_discovered_job", "save_job_analysis", "save_application_package", "report_user_required_question",
  "queue_application_for_review", "save_reasoning_result", "mark_work_item_complete", "mark_work_item_failed",
]) must(tools.includes('name: "' + tool + '"'), "missing MCP tool " + tool);
for (const forbidden of ["approve_application", "submit_application", "approve_gate1", "approve_gate2", "promote_evidence"]) {
  must(!tools.includes(forbidden), "forbidden approval/submission tool " + forbidden);
}
must(migration.includes("code_challenge_method = 'S256'"), "OAuth PKCE S256 constraint missing");
must(migration.includes("private.chatgpt_token_hash"), "hashed OAuth token boundary missing");
must(migration.includes("alter table public.chatgpt_work_items enable row level security"), "work-item RLS missing");
must(migration.includes("chatgpt_work_items_no_direct_client_access"), "work-item direct-access deny missing");
must(migration.includes("unique(user_id, idempotency_key)"), "per-user idempotency constraint missing");
must(migration.includes("perform private.assert_active_app_membership(v_user)"), "active-membership guard missing");
must(securityFollowUp.includes("set schema private") && securityFollowUp.includes("chatgpt_mcp_call_internal"), "private MCP implementation boundary missing");
must((securityFollowUp.match(/security invoker/g) || []).length >= 6, "public OAuth/MCP invoker wrappers missing");
must(securityFollowUp.includes("chatgpt_oauth_codes_user_idx") && securityFollowUp.includes("chatgpt_reasoning_results_work_item_idx"), "M19 foreign-key indexes missing");
must(mcp.includes("Bearer") && mcp.includes("tools/list") && mcp.includes("tools/call"), "MCP Streamable HTTP JSON-RPC boundary incomplete");
must(mcp.includes("unauthorizedMcpResponse") && mcp.includes("WWW-Authenticate"), "MCP OAuth challenge missing");
must(oauth.includes("code_verifier") && oauth.includes("code_challenge_methods_supported"), "OAuth token/PKCE flow incomplete");
must(consent.includes("NextResponse.redirect(redirect, 303)"), "OAuth POST consent must redirect to the callback with 303/GET");
must(runtimeFix.includes("security definer") && runtimeFix.includes("chatgpt_exchange_authorization_code") && runtimeFix.includes("chatgpt_mcp_call"), "REST-callable OAuth/MCP wrappers must resolve their private implementations without exposing private schema usage");
must(auditFix.includes("audit_events_actor_type_check") && auditFix.includes("'chatgpt'"), "ChatGPT audit actor type must be allowed by the audit event constraint");
must(dispatcherFix.includes("create schema if not exists chatgpt_internal") && dispatcherFix.includes("security invoker") && dispatcherFix.includes("chatgpt_internal.exchange_authorization_code"), "ChatGPT public wrappers must remain invoker-bound through a dedicated non-exposed dispatcher schema");
must(proxy.includes("/api/chatgpt/mcp") && proxy.includes("/api/chatgpt/oauth"), "middleware does not leave OAuth/MCP boundary reachable");
must(setup.includes("user_created_chatgpt_task") || setup.includes("User-created ChatGPT Task"), "recurring setup/status page missing");

console.log("Milestone 19 ChatGPT MCP/OAuth contracts passed.");
