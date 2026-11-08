import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const migration = await read("database/migrations/0094_supabase_security_hardening.sql");
const followUpMigration = await read("database/migrations/0095_supabase_security_definer_inventory.sql");
const operationMigration = await read("database/migrations/0114_chatgpt_operation_lock_and_captured_import_recovery.sql");
const operationOverrideMigration = await read("database/migrations/0115_diagnostics_chatgpt_action_lock_override.sql");
const bridgeInspectionMigration = await read("database/migrations/0116_chatgpt_bridge_job_inspection_capture_v3.sql");
const jobAnalysisMigration = await read("database/migrations/0123_durable_job_analysis_batches.sql");
const currentAnalysisApplicationMigration = await read("database/migrations/0124_current_analysis_and_manual_application_choice.sql");
const jobFitV3Migration = await read("database/migrations/0129_job_fit_v3_evidence_assessment.sql");
const jobFitV3IntegrityMigration = await read("database/migrations/0130_job_fit_v3_trusted_worker_integrity.sql");
const jobFitV3MembershipClaimsMigration = await read("database/migrations/0131_job_fit_v3_worker_membership_claims.sql");
const jobFitV3RecoveryMigration = await read("database/migrations/0132_job_fit_v3_exact_turn_recovery.sql");
const jobFitV3RecoveryGuardMigration = await read("database/migrations/0133_job_fit_v3_capture_guard_hardening.sql");
const jobFitV3RecoveryRateLimitMigration = await read("database/migrations/0134_job_fit_v3_rate_limited_exact_turn_recovery.sql");
const jobFitV3RecoveryDiscoveryMigration = await read("database/migrations/0135_job_fit_v3_response_check_discovery.sql");
const memoryFitCaptureBoundaryMigration = await read("database/migrations/20261001233457_job_fit_memory_v4_capture_dispatch_boundary.sql");
const memoryFitBackgroundMigration = await read("database/migrations/20261003093708_job_fit_memory_v4_background_progress.sql");
const m08ReviewIntegrityMigration = await read("database/migrations/20261108130000_m08_reviewed_artifact_integrity.sql");
const analysisMembershipMigration = await read("database/migrations/0125_pause_job_analysis_for_revoked_members.sql");
const jobPoolSheetMigration = await read("database/migrations/0117_job_pool_google_sheet_mirror.sql");
const jobPoolSchedulerVaultMigration = await read("database/migrations/0118_job_pool_scheduler_vault_secret.sql");
const documentation = await read("docs/SUPABASE_SECURITY.md");
const evidence = JSON.parse(await read("docs/evidence/supabase-security-2026-10-03.json"));
const liveSql = await read("database/security/verify_supabase_security.sql");
const allowlist = JSON.parse(await read("database/security/security-definer-allowlist.json"));
const advisorAllowlist = JSON.parse(await read("database/security/security-advisor-allowlist.json"));

const privateTables = [
  "bootstrap_import_batches",
  "gmail_oauth_credentials",
  "app_memberships",
  "app_invitations",
  "chatgpt_oauth_authorization_codes",
  "chatgpt_oauth_access_tokens",
];

for (const table of privateTables) {
  assert.match(migration, new RegExp(`private\\.${table}\\b`), `Missing private table ${table}.`);
  assert.match(migration, new RegExp(`alter table private\\.${table} enable row level security`, "i"), `RLS is not enabled for ${table}.`);
  assert.match(migration, new RegExp(`create policy service_role_only on private\\.${table}`, "i"), `Missing service-role policy for ${table}.`);
}

assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated/i, "Client table privileges are not revoked.");
assert.match(migration, /grant select, insert, update, delete on table[\s\S]*to service_role/i, "Service-role table privileges are not explicit.");
for (const marker of ["chatgpt\\_bridge\\_service\\_", "browser\\_agent\\_service\\_", "form\\_agent\\_service\\_", "record_form_agent_acceptance_result"]) {
  assert.ok(migration.includes(marker), `Service RPC audit is missing ${marker}.`);
}
assert.match(migration, /revoke execute on function[\s\S]*from public, authenticated/i, "The documented rate-limit exception is not explicit.");
assert.match(migration, /to anon, service_role/i, "The rate-limit wrapper grant is not explicit.");

assert.match(followUpMigration, /alter function private\.owns_application\(uuid\) set search_path = ''/i, "Ownership predicates are not pinned to an empty search_path.");
assert.match(followUpMigration, /revoke execute on function private\.owns_profile\(uuid\) from public/i, "Ownership predicates still inherit PUBLIC execution.");
assert.match(followUpMigration, /alter function public\.get_automation_settings\(\) security definer/i, "The automation wrapper does not own its private call boundary.");
assert.match(followUpMigration, /alter function public\.complete_job_url_inspection\(uuid, jsonb, text, text\) security definer/i, "The job inspection wrapper does not own its private call boundary.");
assert.match(followUpMigration, /revoke execute on function private\.start_job_url_inspection_for_user\(uuid, uuid, text\) from public, anon, authenticated/i, "Arbitrary-user job inspection helper remains client-executable.");
assert.match(followUpMigration, /alter default privileges for role postgres in schema public[\s\S]*revoke execute on functions from public/i, "Future public functions do not default to closed execution.");

assert.match(operationMigration, /create table private\.chatgpt_user_operation_locks/i, "The ChatGPT operation lock is missing.");
assert.match(operationMigration, /alter table private\.chatgpt_user_operation_locks enable row level security/i, "The ChatGPT operation lock does not enable RLS.");
assert.match(operationMigration, /create policy service_role_only on private\.chatgpt_user_operation_locks/i, "The operation lock is missing its service-role-only RLS policy.");
assert.match(operationMigration, /revoke all on table private\.chatgpt_user_operation_locks from public, anon, authenticated/i, "The operation lock is directly accessible to client roles.");
assert.match(operationMigration, /create or replace function public\.manage_chatgpt_user_operation[\s\S]*?security invoker/i, "The public operation endpoint is not SECURITY INVOKER.");
assert.match(operationMigration, /create or replace function public\.retry_captured_job_url_inspection[\s\S]*?security invoker/i, "The captured-result recovery endpoint is not SECURITY INVOKER.");
assert.match(operationMigration, /revoke all on function public\.manage_chatgpt_user_operation\(uuid,text,text,uuid\[\]\) from public, anon, service_role[\s\S]*?grant execute on function public\.manage_chatgpt_user_operation\(uuid,text,text,uuid\[\]\) to authenticated/i, "The operation wrapper role grant is too broad.");
assert.match(operationMigration, /revoke all on function public\.retry_captured_job_url_inspection\(uuid,uuid\) from public, anon, service_role[\s\S]*?grant execute on function public\.retry_captured_job_url_inspection\(uuid,uuid\) to authenticated/i, "The captured-result recovery wrapper role grant is too broad.");
assert.match(bridgeInspectionMigration, /create or replace function private\.chatgpt_bridge_apply_job_url_inspection_v3[\s\S]*?security definer[\s\S]*?set search_path = ''/i, "Captured job-import persistence is missing its empty-search-path service boundary.");
assert.match(bridgeInspectionMigration, /action_type <> 'job\.inspect_url'[\s\S]*?state <> 'completed'[\s\S]*?response_provenance is null[\s\S]*?response_provenance_recorded/i, "Captured job-import persistence does not require a completed, exact-turn v3 job-inspection response.");
assert.match(bridgeInspectionMigration, /chatgpt_validate_response_provenance[\s\S]*?dispatch_request_id = p_dispatch_id[\s\S]*?response_hash/i, "Captured job imports are not bound to exact dispatch provenance, response hash, and linked request ownership.");
assert.match(bridgeInspectionMigration, /create or replace function public\.chatgpt_bridge_service_apply_job_url_inspection_v3[\s\S]*?security invoker[\s\S]*?set search_path = ''/i, "The PostgREST bridge import wrapper must remain SECURITY INVOKER.");
assert.match(bridgeInspectionMigration, /revoke all on function public\.chatgpt_bridge_service_apply_job_url_inspection_v3\(uuid, uuid, text, text, jsonb, text\)[\s\S]*?from public, anon, authenticated, service_role[\s\S]*?grant execute on function public\.chatgpt_bridge_service_apply_job_url_inspection_v3\(uuid, uuid, text, text, jsonb, text\)[\s\S]*?to service_role/i, "The job-import wrapper must grant execute only to service_role.");
assert.match(jobPoolSheetMigration, /revoke all on table public\.job_pool_sheet_sync from public,anon,authenticated,service_role[\s\S]*?grant select on table public\.job_pool_sheet_sync,public\.job_pool_sheet_publications to authenticated/i, "The job-pool Sheet tables have an overly broad table grant.");
assert.match(jobPoolSheetMigration, /create or replace function public\.create_manual_job_search_dispatch_with_pool_snapshot[\s\S]*?security invoker[\s\S]*?revoke all on function public\.create_manual_job_search_dispatch_with_pool_snapshot\([\s\S]*?from public,anon,service_role[\s\S]*?grant execute on function public\.create_manual_job_search_dispatch_with_pool_snapshot\([\s\S]*?to authenticated/i, "Manual searches must use the owner-scoped SECURITY INVOKER snapshot wrapper.");
for (const rpc of ["claim_due_job_pool_sheet_checks", "finish_job_pool_sheet_drive_check"]) {
  assert.match(jobPoolSheetMigration, new RegExp(`create or replace function public\\.${rpc}[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`, "i"), `${rpc} must have a fixed-path service boundary.`);
  assert.match(jobPoolSheetMigration, new RegExp(`revoke all on function public\\.${rpc}\\([\\s\\S]*?from public,anon,authenticated,service_role[\\s\\S]*?grant execute on function public\\.${rpc}\\([\\s\\S]*?to service_role`, "i"), `${rpc} must be service-role-only.`);
}
assert.match(jobPoolSchedulerVaultMigration, /public\.get_job_pool_scheduler_secret\(\)[\s\S]*security definer[\s\S]*set search_path = ''[\s\S]*vault\.decrypted_secrets[\s\S]*revoke all[\s\S]*from public,anon,authenticated,service_role[\s\S]*grant execute[\s\S]*to service_role/i, "The scheduler Vault accessor must use a fixed path and remain service-role-only.");
assert.match(jobPoolSheetMigration, /drive_verified_at is null[\s\S]*drive_verified_version is distinct from v_pool\.drive_file_version/i, "Scheduled searches must fail closed unless the live Drive version is fresh and matches.");
assert.match(operationOverrideMigration, /add column if not exists chatgpt_action_lock_disabled boolean not null default false/i, "The diagnostics override must default off and remain non-null.");
assert.match(operationOverrideMigration, /primary key \(user_id, operation_id\)/i, "Concurrent operations are not independently tracked by owner and operation.");
assert.match(operationOverrideMigration, /p_action = 'set_action_lock_disabled'[\s\S]*?The site-wide ChatGPT lock cannot be restored while a ChatGPT action is active/is, "The normal lock can be restored while ChatGPT work is active.");
assert.match(operationOverrideMigration, /perform pg_advisory_xact_lock\(hashtextextended\(v_user::text, 0\)\)/i, "The override setting and new operation claims are not serialized per owner.");
assert.match(operationOverrideMigration, /create or replace function private\.manage_chatgpt_user_operation_internal[\s\S]*?security definer[\s\S]*?set search_path = ''/i, "The lock helper lost its SECURITY DEFINER empty-search-path boundary.");
assert.doesNotMatch(operationOverrideMigration, /grant (?:select|insert|update|delete)[^;]*chatgpt_action_lock_disabled[^;]*to authenticated/i, "The diagnostics override unexpectedly widens direct table permissions.");
assert.match(jobAnalysisMigration, /create table public\.job_analysis_batches[\s\S]*?create table public\.job_analysis_tasks/i, "Durable owner-visible analysis batches and tasks are missing.");
assert.match(jobAnalysisMigration, /alter table public\.job_analysis_batches enable row level security[\s\S]*?alter table public\.job_analysis_tasks enable row level security/i, "Durable analysis task tables must retain RLS.");
assert.match(jobAnalysisMigration, /create policy job_analysis_batches_owner_select[\s\S]*?private\.current_user_active_member\(\)/i, "Analysis batch reads must be scoped to active owners.");
assert.match(jobAnalysisMigration, /create policy job_analysis_tasks_owner_select[\s\S]*?private\.current_user_active_member\(\)/i, "Analysis task reads must be scoped to active owners.");
assert.match(jobAnalysisMigration, /create or replace function public\.create_job_analysis_batch[\s\S]*?security definer[\s\S]*?auth\.uid\(\)[\s\S]*?revoke all on function public\.create_job_analysis_batch\([\s\S]*?from public, anon, authenticated, service_role[\s\S]*?grant execute on function public\.create_job_analysis_batch\([\s\S]*?to authenticated/i, "Batch creation must derive ownership from auth.uid() and have an authenticated-only boundary.");
assert.match(jobAnalysisMigration, /create or replace function public\.claim_job_analysis_tasks[\s\S]*?security invoker[\s\S]*?grant execute on function public\.claim_job_analysis_tasks\(integer\) to service_role/i, "Task claiming must remain a SECURITY INVOKER service-only wrapper.");
assert.match(jobAnalysisMigration, /create or replace function public\.finish_job_analysis_task[\s\S]*?security invoker[\s\S]*?grant execute on function public\.finish_job_analysis_task\(uuid,uuid,jsonb,text,text,text\) to service_role/i, "Task completion must remain a SECURITY INVOKER service-only wrapper.");
assert.match(jobAnalysisMigration, /create or replace function public\.get_job_analysis_batch[\s\S]*?security invoker[\s\S]*?grant execute on function public\.get_job_analysis_batch\(uuid\) to authenticated/i, "Batch status must use an authenticated SECURITY INVOKER wrapper.");
assert.match(jobAnalysisMigration, /create or replace function public\.get_retryable_job_analysis_count\(\)[\s\S]*?security invoker[\s\S]*?private\.current_user_active_member\(\)[\s\S]*?revoke all on function public\.get_retryable_job_analysis_count\(\) from public, anon, authenticated, service_role[\s\S]*?grant execute on function public\.get_retryable_job_analysis_count\(\) to authenticated/i, "Retryable failures must be counted through an authenticated owner-scoped invoker RPC.");
assert.match(jobAnalysisMigration, /create unique index job_analysis_tasks_one_active_per_job[\s\S]*?where state in \('queued','running'\)/i, "Only one active leased task per owner/job may be scheduled.");
assert.match(jobAnalysisMigration, /lease_token=gen_random_uuid\(\)[\s\S]*?lease_expires_at=now\(\)\+interval '3 minutes'/i, "Worker tasks must use bounded leases.");
assert.match(jobAnalysisMigration, /for update skip locked/i, "Concurrent workers must claim tasks without blocking one another.");
assert.match(jobAnalysisMigration, /v_job\.analysis_revision is distinct from v_task\.job_revision[\s\S]*?v_profile\.analysis_revision is distinct from v_task\.profile_revision[\s\S]*?state='queued'/i, "Results from stale analysis inputs must be discarded and requeued.");
assert.match(jobAnalysisMigration, /date_trunc\('milliseconds',now\(\)\)/i, "Hash-bound task timestamps must match JavaScript millisecond precision.");
assert.match(jobAnalysisMigration, /new\.discovery_source[\s\S]*?old\.discovery_source/i, "The hashed discovery source must bump the job revision.");
assert.match(jobAnalysisMigration, /new\.company_id[\s\S]*?old\.company_id[\s\S]*?bump_job_analysis_revision_from_company_update/i, "Every hashed job input, including the joined company name, must bump the job revision.");
assert.match(jobAnalysisMigration, /bump_job_analysis_revision_from_snapshot_update[\s\S]*?current_snapshot_id=new\.id/i, "The current vacancy description and company fallback must invalidate an in-flight or saved analysis when they change.");
assert.match(analysisMembershipMigration, /create or replace function private\.claim_job_analysis_tasks[\s\S]*?private\.app_memberships[\s\S]*?m\.status='active'[\s\S]*?grant execute on function private\.claim_job_analysis_tasks\(integer\) to service_role/i, "The analysis scheduler must not load revoked members' profile data into background work.");
assert.match(currentAnalysisApplicationMigration, /create or replace function public\.create_application_from_job\(\s*p_job_id uuid,\s*p_origin text default 'manual'[\s\S]*?security invoker[\s\S]*?set search_path = ''/i, "Application creation must preserve its SECURITY INVOKER signature and fixed search path.");
assert.match(currentAnalysisApplicationMigration, /v_analysis\.engine_version is distinct from 'job-fit-v2'[\s\S]*?v_analysis\.job_revision is distinct from v_job\.analysis_revision[\s\S]*?v_analysis\.profile_revision is distinct from v_profile_revision[\s\S]*?input_hash/i, "New applications must bind to the current input revisions and provenance hash.");
assert.match(currentAnalysisApplicationMigration, /if v_analysis\.eligibility='ineligible' then raise exception/i, "Hard ineligibility must still prevent application creation.");
assert.match(currentAnalysisApplicationMigration, /if p_origin='auto_prepare' and \(v_analysis\.triage <> 'auto_prepare' or v_analysis\.eligibility <> 'eligible'\)/i, "Automatic preparation must retain its strict triage and eligibility gate.");
assert.doesNotMatch(currentAnalysisApplicationMigration, /v_analysis\.triage\s*=\s*'reject'/i, "A low fit decision should remain advice for explicit user choice.");
assert.match(currentAnalysisApplicationMigration, /revoke all on function public\.create_application_from_job\(uuid,text\) from public,anon,service_role[\s\S]*?grant execute on function public\.create_application_from_job\(uuid,text\) to authenticated/i, "Application creation must remain an authenticated-only user RPC.");

assert.match(jobFitV3Migration, /create table public\.job_fit_v3_batches[\s\S]*?create table public\.job_fit_v3_tasks/i, "V3 fit analysis must persist durable owner-scoped work.");
assert.match(jobFitV3Migration, /alter table public\.job_fit_v3_batches enable row level security[\s\S]*?alter table public\.job_fit_v3_tasks enable row level security/i, "V3 fit task tables must retain RLS.");
assert.match(jobFitV3Migration, /revoke all on public\.job_fit_v3_batches,public\.job_fit_v3_tasks from public,anon,authenticated,service_role[\s\S]*?grant select,insert,update on public\.job_fit_v3_batches,public\.job_fit_v3_tasks to authenticated/i, "V3 fit table grants must exclude anon and service_role.");
assert.match(jobFitV3Migration, /create policy job_fit_v3_tasks_owner_select[\s\S]*?private\.current_user_active_member\(\)[\s\S]*?private\.owns_job\(job_id\)[\s\S]*?b\.user_id=\(select auth\.uid\(\)\)/i, "V3 tasks must be readable only by the active owner of both the job and batch.");
assert.match(jobFitV3Migration, /create or replace function public\.create_job_fit_v3_batch[\s\S]*?security invoker[\s\S]*?private\.current_user_active_member\(\)[\s\S]*?revoke all on function public\.create_job_fit_v3_batch\([\s\S]*?from public,anon,service_role[\s\S]*?grant execute on function public\.create_job_fit_v3_batch\([\s\S]*?to authenticated/i, "V3 batch creation must use a narrowly granted SECURITY INVOKER wrapper.");
assert.match(jobFitV3Migration, /create or replace function public\.save_job_fit_v3_result[\s\S]*?security invoker[\s\S]*?v_job\.analysis_revision is distinct from v_task\.job_revision[\s\S]*?v_profile\.analysis_revision is distinct from v_task\.profile_revision[\s\S]*?job_fit_v3_task_id/i, "V3 persistence must recheck current revisions and be idempotently linked to its task.");
assert.match(jobFitV3Migration, /alter table public\.job_analyses[\s\S]*?alter column fit_score drop not null[\s\S]*?alter column priority_score drop not null/i, "Incomplete evidence must remain unscored instead of being coerced into a numeric zero.");
assert.match(jobFitV3Migration, /create or replace function public\.create_application_from_job[\s\S]*?security invoker[\s\S]*?engine_version is distinct from 'job-fit-v3'[\s\S]*?job_fit_v3_task_id is null/i, "New applications must require current, complete V3 provenance.");
assert.doesNotMatch(jobFitV3Migration, /grant (?:select|insert|update|delete)[^;]*job_fit_v3_[^;]*to service_role/i, "V3 fit persistence must not broaden service_role table permissions.");

assert.match(jobFitV3IntegrityMigration, /create table public\.job_fit_v3_inputs[\s\S]*?create table public\.job_fit_v3_captures[\s\S]*?create table public\.job_fit_v3_results[\s\S]*?create table public\.job_fit_v3_evidence_references/i, "V3 must persist immutable source inputs, exact Bridge captures, results and evidence references.");
assert.match(jobFitV3IntegrityMigration, /alter table public\.job_fit_v3_inputs enable row level security[\s\S]*?alter table public\.job_fit_v3_evidence_references enable row level security/i, "Every V3 input and result table must retain RLS.");
assert.match(jobFitV3IntegrityMigration, /revoke all on public\.job_fit_v3_batches,public\.job_fit_v3_tasks,[\s\S]*?from public,anon,authenticated,service_role/i, "V3 mutable work tables must not have direct client or service-role DML.");
assert.doesNotMatch(jobFitV3IntegrityMigration, /grant (?:select|insert|update|delete)[^;]*job_fit_v3_[^;]*to service_role/i, "V3 worker wrappers must not broaden direct service_role table privileges.");
assert.match(jobFitV3IntegrityMigration, /create trigger job_fit_v3_inputs_append_only[\s\S]*?create trigger job_fit_v3_evidence_append_only/i, "Frozen V3 inputs, captures, results and evidence must be append-only.");
assert.match(jobFitV3IntegrityMigration, /safe_unsent_retry_count[\s\S]*?Only one server-confirmed unsent V2 dispatch may resume this fit step/i, "Unsent fit recovery must be server-confirmed and bounded to one retry per step.");
assert.match(jobFitV3IntegrityMigration, /create or replace function public\.job_fit_v3_worker_transition[\s\S]*?security invoker/i, "V3 worker RPCs must keep their narrow SECURITY INVOKER boundary.");
assert.match(jobFitV3IntegrityMigration, /grant execute on function public\.job_fit_v3_worker_claim\(integer,uuid\) to service_role/i, "The trusted worker must have its narrow RPC grant.");
assert.match(jobFitV3IntegrityMigration, /revoke all on function public\.save_job_fit_v3_result\(uuid\) from public,anon,authenticated,service_role/i, "Legacy user result writes must be closed after V3 moves to the trusted worker.");
assert.doesNotMatch(jobFitV3IntegrityMigration, /0101_chatgpt_bridge_v3_security_boundary/i, "V3 hardening must not alter or roll back the protected 0101 bridge security boundary.");
assert.match(jobFitV3RecoveryMigration, /add column response_check_attempt_count smallint not null default 0[\s\S]*?check \(response_check_attempt_count between 0 and 1\)/i, "The original V3 response-only recovery migration must remain unchanged as the one-check baseline.");
assert.match(jobFitV3RecoveryMigration, /create or replace function public\.job_fit_v3_create_response_check[\s\S]*?security invoker[\s\S]*?grant execute on function public\.job_fit_v3_create_response_check\(uuid,uuid\) to authenticated/i, "The V3 response-check RPC must remain an authenticated SECURITY INVOKER wrapper.");
assert.match(jobFitV3RecoveryMigration, /response_check_only',true[\s\S]*?delivery_turn_anchor=v_source\.delivery_turn_anchor[\s\S]*?response_check_source_dispatch_id=p_source_dispatch_id/i, "V3 response recovery must use a read-only generic Bridge ticket anchored to the original exact turn.");
assert.match(jobFitV3RecoveryMigration, /v_source\.state='completed'[\s\S]*?lastAssistantMessageId[\s\S]*?v_expired_without_response/i, "V3 response recovery must only allow a proven stale turn or a confirmed missing response.");
assert.match(jobFitV3RecoveryMigration, /create trigger job_fit_v3_enforce_exact_turn_identity[\s\S]*?before insert on public\.job_fit_v3_captures/i, "The V3 append-only capture ledger must reject a pre-send assistant/artifact identity.");
assert.doesNotMatch(jobFitV3RecoveryMigration, /update public\.chatgpt_dispatch_requests[\s\S]*?bridge_response\s*=|delete from public\.job_fit_v3_captures/i, "Recovery must preserve the original dispatch and append-only response captures.");
assert.doesNotMatch(jobFitV3RecoveryMigration, /0101_chatgpt_bridge_v3_security_boundary|security invoker[\s\S]*?chatgpt_bridge_service_complete/i, "Recovery must not replace or relax the protected V3 Bridge wrappers.");
assert.match(jobFitV3RecoveryRateLimitMigration, /add column response_check_source_attempt_count smallint[\s\S]*?add column response_check_last_requested_at timestamptz/i, "Repeated exact-turn checks must retain the original attempt and durable cooldown timestamp.");
assert.match(jobFitV3RecoveryRateLimitMigration, /check \(response_check_attempt_count between 0 and 4\)/i, "Read-only exact-turn recovery must have a strict four-check ceiling.");
assert.match(jobFitV3RecoveryRateLimitMigration, /for update[\s\S]*?interval '15 seconds'[\s\S]*?response_check_attempt_count=response_check_attempt_count\+1/i, "The database must serialize response checks and enforce a 15-second per-task cooldown.");
assert.match(jobFitV3RecoveryRateLimitMigration, /response_check_only',true[\s\S]*?delivery_turn_anchor=v_source\.delivery_turn_anchor[\s\S]*?response_check_source_dispatch_id=p_source_dispatch_id/i, "Every repeated check must reuse the original exact-turn anchor in the generic read-only Bridge path.");
assert.doesNotMatch(jobFitV3RecoveryRateLimitMigration, /retry_chatgpt_dispatch_request|start_chatgpt_dispatch|bridge_response\s*=/i, "Read-only response recovery must not invoke Send or rewrite the original captured response.");
assert.match(jobFitV3RecoveryRateLimitMigration, /create or replace function public\.job_fit_v3_create_response_check[\s\S]*?security invoker[\s\S]*?revoke all on function public\.job_fit_v3_create_response_check\(uuid,uuid\) from public,anon,authenticated,service_role[\s\S]*?grant execute on function public\.job_fit_v3_create_response_check\(uuid,uuid\) to authenticated/i, "The rate-limited response-check wrapper must remain SECURITY INVOKER and authenticated-only.");
assert.match(jobFitV3RecoveryRateLimitMigration, /revoke all on function private\.job_fit_v3_create_response_check_internal\(uuid,uuid\) from public,anon,authenticated,service_role[\s\S]*?grant execute on function private\.job_fit_v3_create_response_check_internal\(uuid,uuid\) to authenticated/i, "The current-user helper must retain its existing narrow authenticated-only execution grant.");
assert.doesNotMatch(jobFitV3RecoveryRateLimitMigration, /0101_chatgpt_bridge_v3_security_boundary|grant (?:select|insert|update|delete)[^;]*to service_role/i, "The new recovery policy must not change the protected Bridge wrappers or widen service_role table grants.");
assert.match(jobFitV3RecoveryDiscoveryMigration, /create index if not exists job_fit_v3_tasks_recovery_discovery[\s\S]*?where state in \('needs_user','waiting_for_bridge'\)/i, "Safe-response discovery must have a partial owner/recent index on only recoverable task states.");
assert.match(jobFitV3RecoveryDiscoveryMigration, /create or replace function private\.job_fit_v3_find_response_check_candidate_internal\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''[\s\S]*?auth\.uid\(\)[\s\S]*?assert_active_app_membership/i, "Recovery discovery must be a fixed-path current-user helper that checks membership.");
assert.match(jobFitV3RecoveryDiscoveryMigration, /create or replace function public\.job_fit_v3_find_response_check_candidate\(\)[\s\S]*?security invoker[\s\S]*?revoke all on function public\.job_fit_v3_find_response_check_candidate\(\) from public,anon,authenticated,service_role[\s\S]*?grant execute on function public\.job_fit_v3_find_response_check_candidate\(\) to authenticated/i, "Recovery discovery must expose only an authenticated SECURITY INVOKER wrapper.");
assert.doesNotMatch(jobFitV3RecoveryDiscoveryMigration, /grant (?:select|insert|update|delete)[^;]*to service_role|0101_chatgpt_bridge_v3_security_boundary|chatgpt_bridge_service_complete/i, "Recovery discovery must not widen service-role table grants or alter the protected Bridge boundary.");
assert.match(jobFitV3RecoveryGuardMigration, /jsonb_array_elements_text\([\s\S]*?case when jsonb_typeof\(v_anchor->'artifactKeys'\)='array'[\s\S]*?else '\[\]'::jsonb end/i, "The capture guard must bound optional artifact-key JSON before expansion.");
assert.match(memoryFitCaptureBoundaryMigration, /create or replace function private\.job_fit_memory_v4_get_dispatch_for_capture\([\s\S]*?returns table[\s\S]*?security definer[\s\S]*?set search_path = ''[\s\S]*?auth\.uid\(\)[\s\S]*?current_user_active_member\(\)[\s\S]*?d\.user_id=v_user[\s\S]*?d\.action_type='jobs\.analyse_selected'[\s\S]*?d\.idempotency_key=p_idempotency_key[\s\S]*?d\.subject_refs->'job_ids'=to_jsonb\(p_job_ids\)[\s\S]*?coalesce\(d\.website_instruction,d\.manual_instruction\)=p_instruction/i, "Memory-fit dispatch lookup must be a fixed-path private helper restricted to the exact current user's saved dispatch.");
assert.match(memoryFitCaptureBoundaryMigration, /revoke all on function private\.job_fit_memory_v4_get_dispatch_for_capture\(uuid,text,uuid\[\],text\) from public,anon,service_role[\s\S]*?grant execute on function private\.job_fit_memory_v4_get_dispatch_for_capture\(uuid,text,uuid\[\],text\) to authenticated/i, "The private Memory-fit lookup must be authenticated-only and unavailable to PUBLIC, anon and service_role.");
const memoryCaptureWrapper = /create or replace function public\.capture_job_fit_memory_v4_chunk\(p_chunk_id uuid,p_dispatch_id uuid\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/i.exec(memoryFitCaptureBoundaryMigration)?.[1] || "";
assert.match(memoryFitCaptureBoundaryMigration, /create or replace function public\.capture_job_fit_memory_v4_chunk\(p_chunk_id uuid,p_dispatch_id uuid\)[\s\S]*?security invoker/i, "The Memory-fit public capture wrapper must remain SECURITY INVOKER.");
assert.match(memoryCaptureWrapper, /job_fit_memory_v4_get_dispatch_for_capture\([\s\S]*?v_chunk\.idempotency_key[\s\S]*?v_chunk\.job_ids[\s\S]*?v_chunk\.instruction/i, "The invoker capture wrapper must match dispatch identity against the saved exact chunk before capture.");
assert.doesNotMatch(memoryCaptureWrapper, /from public\.chatgpt_dispatch_requests/i, "The invoker capture wrapper must not read the closed Website Bridge dispatch table directly.");
assert.match(memoryFitCaptureBoundaryMigration, /revoke all on function public\.capture_job_fit_memory_v4_chunk\(uuid,uuid\) from public,anon,service_role[\s\S]*?grant execute on function public\.capture_job_fit_memory_v4_chunk\(uuid,uuid\) to authenticated/i, "The Memory-fit capture wrapper must remain authenticated-only without broadening service_role.");
assert.doesNotMatch(memoryFitCaptureBoundaryMigration, /grant (?:select|insert|update|delete)[^;]*chatgpt_dispatch_requests[^;]*to (?:anon|authenticated|service_role)|0101_chatgpt_bridge_v3_security_boundary|alter function public\.chatgpt_bridge_service_complete/i, "Memory-fit capture must not expose dispatch-table access, change service-role grants, or alter the protected v3 Bridge boundary.");
assert.match(memoryFitBackgroundMigration, /^begin;[\s\S]*?add column advance_lease_token uuid[\s\S]*?add column advance_lease_expires_at timestamptz[\s\S]*?for update of b skip locked[\s\S]*?commit;\s*$/i, "Memory-fit foreground and background progress must share an atomic expiring lease.");
assert.match(memoryFitBackgroundMigration, /job_fit_memory_v4_items_state_check[\s\S]*?'needs_user'/i, "The durable Memory-fit item state must distinguish a terminal request needing user review from queued work.");
for (const [privateName, signature, publicName, publicSignature] of [
  ["job_fit_memory_v4_worker_claim_internal", "integer", "job_fit_memory_v4_worker_claim", "integer"],
  ["job_fit_memory_v4_worker_context_internal", "uuid,uuid,uuid", "job_fit_memory_v4_worker_context", "uuid,uuid,uuid"],
  ["job_fit_memory_v4_worker_capture_internal", "uuid,uuid,uuid,uuid,uuid", "job_fit_memory_v4_worker_capture", "uuid,uuid,uuid,uuid,uuid"],
  ["job_fit_memory_v4_worker_save_internal", "uuid,uuid,uuid,uuid,jsonb", "job_fit_memory_v4_worker_save", "uuid,uuid,uuid,uuid,jsonb"],
  ["job_fit_memory_v4_worker_dispatch_internal", "uuid,uuid,uuid,uuid", "job_fit_memory_v4_worker_dispatch", "uuid,uuid,uuid,uuid"],
  ["job_fit_memory_v4_worker_needs_user_internal", "uuid,uuid,uuid,uuid,text", "job_fit_memory_v4_worker_needs_user", "uuid,uuid,uuid,uuid,text"],
  ["job_fit_memory_v4_worker_release_internal", "uuid,uuid,uuid", "job_fit_memory_v4_worker_release", "uuid,uuid,uuid"],
]) {
  const functionBody = new RegExp(`create or replace function private\\.${privateName}\\([\\s\\S]*?security definer set search_path='' as \\$\\$([\\s\\S]*?)\\$\\$;`, "i").exec(memoryFitBackgroundMigration)?.[1] || "";
  assert.ok(functionBody, `${privateName} must be a fixed-path SECURITY DEFINER helper.`);
  assert.match(functionBody, /auth\.role\(\)[\s\S]*?service_role/i, `${privateName} must reject non-service callers.`);
  assert.match(memoryFitBackgroundMigration, new RegExp(`revoke all on function private\\.${privateName}\\(${signature.replaceAll(",", ",")}\\) from public,anon,authenticated,service_role[\\s\\S]*?grant execute on function private\\.${privateName}\\(${signature.replaceAll(",", ",")}\\) to service_role`, "i"), `${privateName} must have only a service_role execution grant.`);
  assert.match(memoryFitBackgroundMigration, new RegExp(`create or replace function public\\.${publicName}\\([\\s\\S]*?security invoker`, "i"), `${publicName} must remain a SECURITY INVOKER wrapper.`);
  assert.match(memoryFitBackgroundMigration, new RegExp(`revoke all on function public\\.${publicName}\\(${publicSignature.replaceAll(",", ",")}\\) from public,anon,authenticated,service_role[\\s\\S]*?grant execute on function public\\.${publicName}\\(${publicSignature.replaceAll(",", ",")}\\) to service_role`, "i"), `${publicName} must be callable only by service_role.`);
}
for (const helper of ["job_fit_memory_v4_worker_context_internal", "job_fit_memory_v4_worker_capture_internal", "job_fit_memory_v4_worker_save_internal", "job_fit_memory_v4_worker_dispatch_internal", "job_fit_memory_v4_worker_needs_user_internal"]) {
  const functionBody = new RegExp(`create or replace function private\\.${helper}\\([\\s\\S]*?security definer set search_path='' as \\$\\$([\\s\\S]*?)\\$\\$;`, "i").exec(memoryFitBackgroundMigration)?.[1] || "";
  assert.match(functionBody, /assert_active_app_membership\(p_user_id\)/i, `${helper} must recheck the exact owner's active membership.`);
}
assert.match(memoryFitBackgroundMigration, /create_chatgpt_dispatch_request_with_website_instruction\([\s\S]*?v_chunk\.idempotency_key[\s\S]*?v_chunk\.instruction/i, "V4 background sending must reuse the existing generic Website Bridge dispatch contract.");
assert.match(memoryFitBackgroundMigration, /set_config\('request\.jwt\.claim\.sub'[\s\S]*?set_config\('request\.jwt\.claim\.role'[\s\S]*?set_config\('request\.jwt\.claims'/i, "Service-only V4 recovery must establish complete transaction-local claims before calling current-user SECURITY INVOKER RPCs.");
assert.doesNotMatch(memoryFitBackgroundMigration, /grant\s+(?:select|insert|update|delete)[^;]*job_fit_memory_v4_[^;]*to service_role|0101_chatgpt_bridge_v3_security_boundary|alter function public\.chatgpt_bridge_service_complete/i, "Memory-fit background progress must not add service-role table privileges or alter the protected Bridge boundary.");
for (const [functionName, callName] of [
  ["job_fit_v3_worker_create_batch_internal", "create_job_fit_v3_batch"],
  ["job_fit_v3_save_result_internal", "save_job_fit_v3_result"],
]) {
  const workerFunction = new RegExp(`create or replace function private\\.${functionName}\\([\\s\\S]*?security definer set search_path='' as \\$\\$([\\s\\S]*?)\\$\\$;`, "i").exec(jobFitV3MembershipClaimsMigration)?.[1] || "";
  assert.match(workerFunction, /auth\.role\(\)[\s\S]*?service_role/i, `${functionName} must remain restricted to its service-role worker caller.`);
  assert.match(workerFunction, /assert_active_app_membership\(p_user_id\)/i, `${functionName} must recheck active membership before acting.`);
  assert.match(workerFunction, /lower\(m\.email\)[\s\S]*?private\.app_memberships[\s\S]*?status='active'/i, `${functionName} must derive email context from the active server-side membership row.`);
  assert.match(workerFunction, /set_config\('request\.jwt\.claim\.sub'[\s\S]*?set_config\('request\.jwt\.claim\.role'[\s\S]*?set_config\('request\.jwt\.claims'/i, `${functionName} must set a complete transaction-local user claim context for the existing owner-scoped RPC.`);
  assert.match(workerFunction, new RegExp(`public\\.${callName}\\(`), `${functionName} must continue to use the existing validated ${callName} RPC.`);
}
assert.match(jobFitV3MembershipClaimsMigration, /revoke all on function private\.job_fit_v3_worker_create_batch_internal\(uuid,uuid,text,uuid\[\],jsonb\) from public,anon,authenticated,service_role[\s\S]*?grant execute on function private\.job_fit_v3_worker_create_batch_internal\(uuid,uuid,text,uuid\[\],jsonb\) to service_role/i, "V3 batch creation must remain service-role-only after the membership-claim repair.");
assert.match(jobFitV3MembershipClaimsMigration, /revoke all on function private\.job_fit_v3_save_result_internal\(uuid,uuid,uuid\) from public,anon,authenticated,service_role[\s\S]*?grant execute on function private\.job_fit_v3_save_result_internal\(uuid,uuid,uuid\) to service_role/i, "V3 result persistence must remain service-role-only after the membership-claim repair.");
assert.doesNotMatch(jobFitV3MembershipClaimsMigration, /alter function public\.chatgpt_bridge_service_complete_(?:reused_)?dispatch_v3|0101_chatgpt_bridge_v3_security_boundary/i, "The membership-claim repair must preserve the protected bridge v3 security boundary.");

assert.equal(allowlist.version, 1, "Unexpected security-definer allowlist version.");
assert.deepEqual(allowlist.scope, ["public", "private", "chatgpt_internal"], "Allowlist scope drifted.");
assert.equal(allowlist.invariants.securityDefinerSearchPath, 'search_path=""', "The allowlist must require an empty SECURITY DEFINER search_path.");
assert.equal(allowlist.invariants.publicExecute, false, "SECURITY DEFINER functions must not inherit PUBLIC execution.");
for (const schema of allowlist.scope) {
  assert.ok(Number.isInteger(allowlist.inventory?.[schema]?.securityDefinerCount), `Missing ${schema} inventory count.`);
  assert.match(allowlist.inventory?.[schema]?.identityArgumentsMd5 || "", /^[a-f0-9]{32}$/, `Missing ${schema} inventory hash.`);
  assert.match(allowlist.inventory?.[schema]?.roleInventoryMd5 || "", /^[a-f0-9]{32}$/, `Missing ${schema} role inventory hash.`);
}
assert.ok(Array.isArray(allowlist.categories) && allowlist.categories.length >= 10, "The function allowlist is incomplete.");
assert.equal(advisorAllowlist.version, 1, "Unexpected security-advisor allowlist version.");
assert.equal(advisorAllowlist.accepted.length, 26, "The current accepted advisor list must contain one anonymous and twenty-five authenticated wrapper notices.");
assert.equal(advisorAllowlist.accepted.filter((entry) => entry.advisor === "anon_security_definer_function_executable").length, 1, "The anonymous advisor exception count drifted.");
assert.equal(advisorAllowlist.accepted.filter((entry) => entry.advisor === "authenticated_security_definer_function_executable").length, 25, "The authenticated advisor exception count drifted.");
assert.equal(new Set(advisorAllowlist.accepted.map((entry) => `${entry.advisor}:${entry.schema}:${entry.function}`)).size, 26, "The advisor allowlist contains duplicate notices.");
assert.ok(advisorAllowlist.requiredAbsent.includes("auth_leaked_password_protection"), "The leaked-password advisor must remain a required pass condition.");
assert.equal(evidence.securityAdvisor.acceptedFunctionWarnings.anon_security_definer_function_executable, 1, "The advisor evidence has the wrong anonymous-warning count.");
assert.equal(evidence.securityAdvisor.acceptedFunctionWarnings.authenticated_security_definer_function_executable, 25, "The advisor evidence has the wrong authenticated-warning count.");
assert.deepEqual(evidence.securityAdvisor.unexpectedWarnings, [], "The advisor evidence contains an unexpected warning.");
assert.deepEqual(evidence.securityAdvisor.unresolvedWarnings, ["auth_leaked_password_protection"], "The Auth blocker evidence drifted.");
assert.equal(evidence.liveSqlVerification.status, "passed", "The recorded live SQL verification did not pass.");

const namesBySchema = new Map();
for (const category of allowlist.categories) {
  assert.ok(category.schema && allowlist.scope.includes(category.schema), `Invalid allowlist schema in ${category.id}.`);
  assert.ok(Array.isArray(category.allowedExecuteRoles), `Missing role contract in ${category.id}.`);
  assert.ok(category.rationale, `Missing rationale in ${category.id}.`);
  for (const name of category.names || []) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `Invalid function name ${name}.`);
    const key = `${category.schema}.${name}`;
    const previous = namesBySchema.get(key);
    assert.equal(previous, undefined, `Function ${key} appears in multiple allowlist categories.`);
    namesBySchema.set(key, category.id);
  }
}
assert.equal([...namesBySchema.values()].filter((id) => id === "chatgpt-internal-token-dispatchers").length, 6, "The ChatGPT internal dispatcher inventory is incomplete.");
assert.equal([...namesBySchema.values()].filter((id) => id === "private-token-dispatchers").length, 24, "The private token dispatcher inventory is incomplete.");
assert.equal([...namesBySchema.values()].filter((id) => id === "private-owner-only").length, 37, "The private owner-only inventory is incomplete.");
const ownerScopedSearchRpc = allowlist.categories.find((category) => category.id === "public-authenticated-owner-rpc");
assert.deepEqual(ownerScopedSearchRpc?.names, [
  "finalize_job_search_run", "save_job_search_preferences", "begin_job_pool_sheet_sync", "finish_job_pool_sheet_sync",
  "create_job_analysis_batch", "create_application_from_job", "create_cv_document_version",
  "create_application_cover_letter_version", "save_application_content_package", "finalize_application_document_item",
  "assemble_application_review_package", "review_application_document", "review_application_salary",
  "review_application_answer", "set_application_cover_letter_decision", "approve_application_content",
  "return_application_to_revision", "transition_application_state",
], "The owner-scoped application, search, Sheet, and job-analysis RPC inventory drifted.");
assert.deepEqual(ownerScopedSearchRpc?.allowedExecuteRoles, ["authenticated"], "Owner-scoped search RPCs must remain unavailable to service_role.");
for (const rpc of ["create_cv_document_version", "create_application_cover_letter_version", "save_application_content_package",
  "finalize_application_document_item", "assemble_application_review_package", "review_application_document",
  "review_application_salary", "review_application_answer", "set_application_cover_letter_decision",
  "approve_application_content", "return_application_to_revision", "transition_application_state"]) {
  assert.ok(ownerScopedSearchRpc?.names.includes(rpc), `M08 authenticated owner RPC ${rpc} is missing from the security inventory.`);
}
assert.match(m08ReviewIntegrityMigration, /create or replace function public\.review_application_document[\s\S]*?security definer set search_path=''[\s\S]*?revoke all on function public\.review_application_document\(uuid,uuid,text\) from public,anon,service_role[\s\S]*?grant execute on function public\.review_application_document\(uuid,uuid,text\) to authenticated/i,
  "The M08 document factual-review RPC must retain its authenticated-owner-only SECURITY DEFINER boundary.");
assert.match(m08ReviewIntegrityMigration, /create or replace function public\.approve_application_content[\s\S]*?security definer set search_path=''[\s\S]*?revoke all on function public\.approve_application_content\(uuid\) from public,anon,service_role[\s\S]*?grant execute on function public\.approve_application_content\(uuid\) to authenticated/i,
  "The M08 Gate 1 RPC must remain authenticated-owner-only with an empty search path.");
assert.match(m08ReviewIntegrityMigration, /create or replace function private\.can_mutate_application_document_object[\s\S]*?security definer[\s\S]*?set search_path=''[\s\S]*?revoke all on function private\.can_mutate_application_document_object\(text\) from public,anon,service_role[\s\S]*?grant execute on function private\.can_mutate_application_document_object\(text\) to authenticated/i,
  "The M08 Storage policy helper must retain a fixed search path and authenticated-only execution.");
const memberAdminRpc = allowlist.categories.find((category) => category.id === "public-authenticated-member-admin-rpc");
assert.deepEqual(memberAdminRpc?.names, ["manage_app_member"], "The member-administration RPC inventory drifted.");
assert.deepEqual(memberAdminRpc?.allowedExecuteRoles, ["authenticated"], "Member-administration RPCs must remain unavailable to anon and service_role.");
const authenticatedCurrentUserHelpers = allowlist.categories.find((category) => category.id === "private-auth-current-user")?.names || [];
for (const helper of ["current_user_active_member", "job_fit_memory_v4_get_dispatch_for_capture", "manage_chatgpt_user_operation_internal", "retry_captured_job_url_inspection_internal", "can_mutate_application_document_object"]) {
  assert.ok(authenticatedCurrentUserHelpers.includes(helper), `The current-user-only helper ${helper} is not inventoried.`);
}
const privateBridgeServiceOnly = allowlist.categories.find((category) => category.id === "private-service-only");
assert.ok(privateBridgeServiceOnly?.names.includes("chatgpt_bridge_apply_job_url_inspection_v3"), "The exact-turn job-import helper is not inventoried as service-only.");
for (const helper of ["claim_job_analysis_tasks", "finish_job_analysis_task", "job_fit_v3_worker_create_batch_internal", "job_fit_v3_save_result_internal", "job_fit_v3_worker_transition_internal", "job_fit_v3_worker_claim_internal", "job_fit_v3_worker_dispatch_internal", "job_fit_v3_worker_status_internal", "job_fit_v3_worker_captures_internal", "job_fit_v3_worker_release_internal", "job_fit_memory_v4_worker_claim_internal", "job_fit_memory_v4_worker_context_internal", "job_fit_memory_v4_worker_capture_internal", "job_fit_memory_v4_worker_save_internal", "job_fit_memory_v4_worker_dispatch_internal", "job_fit_memory_v4_worker_needs_user_internal", "job_fit_memory_v4_worker_release_internal"]) {
  assert.ok(privateBridgeServiceOnly?.names.includes(helper), `The durable job-analysis worker helper ${helper} is not inventoried as service-only.`);
}
assert.deepEqual(privateBridgeServiceOnly?.allowedExecuteRoles, ["service_role"], "The exact-turn job-import helper must not expose execute to client roles.");
const privateFitClosed = allowlist.categories.find((category) => category.id === "private-fit-closed-helpers");
assert.deepEqual(privateFitClosed?.names, ["job_fit_v3_immutable_row", "refresh_job_fit_v3_batch"], "V3 append-only and state helpers must remain private and closed.");
assert.deepEqual(privateFitClosed?.allowedExecuteRoles, [], "V3 closed database helpers must not be directly callable through any API role.");
const jobPoolSchedulerRpc = allowlist.categories.find((category) => category.id === "public-service-rpc");
for (const name of ["claim_due_job_pool_sheet_checks", "finish_job_pool_sheet_drive_check", "get_job_pool_scheduler_secret"]) {
  assert.ok(jobPoolSchedulerRpc?.names.includes(name), `The service-only scheduler RPC ${name} is not inventoried.`);
}
assert.deepEqual(jobPoolSchedulerRpc?.allowedExecuteRoles, ["service_role"], "The scheduled Sheet verification RPCs must remain service-only.");
assert.ok(allowlist.categories.find((category) => category.id === "private-trigger-only")?.names.includes("mark_job_pool_sheet_dirty"), "The job-pool dirty helper must remain trigger-only.");
for (const trigger of ["bump_job_analysis_revision", "bump_job_analysis_revision_from_company_update", "bump_job_analysis_revision_from_snapshot_update", "bump_profile_analysis_revision", "bump_profile_analysis_revision_on_profile_update", "enqueue_imported_job_analysis"]) {
  assert.ok(allowlist.categories.find((category) => category.id === "private-trigger-only")?.names.includes(trigger), `The analysis trigger helper ${trigger} must remain trigger-only.`);
}

assert.match(liveSql, /security-definer-allowlist/i, "Live verification must identify the allowlist it enforces.");
assert.match(liveSql, /relrowsecurity/i, "Live verification must check table RLS.");
assert.match(liveSql, /has_table_privilege/i, "Live verification must check table privileges.");
assert.match(liveSql, /has_function_privilege/i, "Live verification must check function privileges.");
assert.match(liveSql, /prosecdef/i, "Live verification must inspect SECURITY DEFINER functions.");
assert.match(liveSql, /search_path/i, "Live verification must inspect function search paths.");
assert.match(liveSql, /proconfig\s+is\s+distinct\s+from/i, "Live verification must fail closed for NULL SECURITY DEFINER search paths.");
assert.match(liveSql, /service_role_only/i, "Live verification must check the service-role policies.");
assert.match(liveSql, /chatgpt_action_lock_disabled/i, "Live verification must check the Diagnostics action-lock override default and client permissions.");
assert.match(liveSql, /primary key \(user_id, operation_id\)/i, "Live verification must check per-operation lock tracking.");
assert.match(liveSql, /durable fit-analysis batches expose owner-readable state/i, "Live verification must check durable job-analysis RLS and RPC boundaries.");
assert.match(liveSql, /Memory-fit response capture is missing its private current-user lookup or SECURITY INVOKER\/closed-table boundary/i, "Live verification must check the Memory-fit capture and dispatch-table boundary.");
assert.match(liveSql, /Fresh V3 profile-bearing batch creation must remain retired after the Memory-only cutover/i, "Live verification must preserve the Memory-only V4 cutover by rejecting new profile-bearing V3 batches.");
assert.match(liveSql, /V3 fit immutable evidence role grants/i, "Live verification must check the V3 append-only data tables.");
assert.match(liveSql, /fit-worker active membership JWT claims/i, "Live verification must check the trusted V3 worker membership-claim implementation.");
assert.match(liveSql, /V3 fit worker wrapper is missing its SECURITY INVOKER/i, "Live verification must check the narrow V3 service-role wrappers.");
assert.match(liveSql, /V3 exact-turn recovery wrapper is missing its authenticated-only SECURITY INVOKER boundary/i, "Live verification must check the narrow response-recovery wrapper.");
assert.match(liveSql, /V3 recovery-discovery wrapper is missing its authenticated-only SECURITY INVOKER boundary/i, "Live verification must check the narrow response-discovery wrapper.");
assert.match(liveSql, /persisted original-attempt\/cooldown fields or four-check ceiling/i, "Live verification must check the bounded repeat-check policy's schema.");
assert.match(liveSql, /V3 stale-turn capture guard must remain a closed trigger-only helper/i, "Live verification must check the V3 capture provenance guard.");
assert.match(liveSql, /A superseded direct V3 fit write RPC remains callable/i, "Live verification must keep the superseded direct V3 write RPCs closed.");

assert.match(documentation, /accepted, documented exception/i, "The intentional rate-limit advisor warning is not documented.");
assert.match(documentation, /nineteen authenticated warnings for user-facing wrappers are\s+also\s+intentional/i, "The historical authenticated advisor warnings are not documented.");
assert.match(documentation, /current advisor snapshot contains one intentional anonymous rate-limit\s+warning and twenty-five intentional authenticated user-facing wrapper\s+warnings/i, "The current advisor count is not documented.");
assert.match(documentation, /auth_leaked_password_protection.*must disappear/is, "The Auth advisor requirement is not documented.");
assert.match(documentation, /Free plan.*Pro-only setting/is, "The current Auth-setting blocker is not recorded.");
assert.match(documentation, /20260907194623_supabase_security_hardening/i, "The applied remote migration is not recorded.");
assert.match(documentation, /0095_supabase_security_definer_inventory/i, "The follow-up migration is not recorded.");
assert.match(documentation, /20260928203946_member_administration_and_account_deletion/i, "The member-administration migration is not recorded.");
assert.match(documentation, /20260930130839_job_fit_v3_trusted_worker_integrity/i, "The V3 trusted-worker security boundary is not recorded.");
assert.match(documentation, /20260930133954_20260930133553_job_fit_v3_worker_membership_claims/i, "The trusted worker membership-claim repair is not recorded.");
assert.match(documentation, /0132_job_fit_v3_exact_turn_recovery/i, "The V3 exact-turn recovery boundary is not documented.");
assert.match(documentation, /0134_job_fit_v3_rate_limited_exact_turn_recovery/i, "The bounded repeated exact-turn recovery policy is not documented.");
assert.match(documentation, /0135_job_fit_v3_response_check_discovery/i, "Safe, exact-turn recovery discovery is not documented.");
assert.match(documentation, /20261001233457_job_fit_memory_v4_capture_dispatch_boundary/i, "The Memory-fit capture permission boundary is not documented.");
assert.match(documentation, /20261003093708_job_fit_memory_v4_background_progress/i, "The Memory-fit page-independent worker and shared foreground lease are not documented.");
assert.match(documentation, /service-role client for Storage cleanup and `auth\.admin\.deleteUser\(\)`/i, "The account-deletion service boundary is not documented.");
assert.match(documentation, /live SQL verifier/i, "The live verifier is not documented.");
assert.match(documentation, /private helpers.*client roles/is, "The private-helper boundary is not documented.");
assert.match(documentation, /security-advisor-allowlist\.json/i, "The advisor allowlist is not documented.");

if (process.argv.includes("--live")) {
  const psql = process.env.PSQL_BIN || "psql";
  const databaseUrl = process.env.SUPABASE_DB_URL;
  assert.ok(databaseUrl, "--live requires SUPABASE_DB_URL; do not put a database URL in source control.");
  assert.ok(fs.existsSync(path.join(root, "database/security/verify_supabase_security.sql")), "Live SQL verifier is missing.");
  try {
    execFileSync(psql, ["-X", "-v", "ON_ERROR_STOP=1", "--dbname", databaseUrl, "--file", path.join(root, "database/security/verify_supabase_security.sql")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || undefined },
    });
  } catch (error) {
    throw new Error(`Supabase live security verification failed. Ensure psql is installed and SUPABASE_DB_URL targets the intended project. ${error.message}`);
  }
  console.log("Supabase live security verification passed.");
} else {
  console.log("Supabase security contract passed (static). Run with --live and SUPABASE_DB_URL for catalog verification.");
}
