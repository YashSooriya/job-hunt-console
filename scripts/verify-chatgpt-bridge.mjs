import fs from "node:fs";
import path from "node:path";

const required = [
  "database/migrations/0057_chatgpt_browser_dispatch.sql",
  "database/migrations/0058_chatgpt_bridge_conversation_slots.sql",
  "database/migrations/0059_chatgpt_dispatch_queue_state_fix.sql",
  "database/migrations/0060_chatgpt_project_name_jobhuntai.sql",
  "database/migrations/0061_chatgpt_bridge_upgrade_recovery.sql",
  "database/migrations/0062_chatgpt_rate_limit_dispatcher_grant.sql",
  "database/migrations/0063_website_bridge_primary_dispatch.sql",
  "database/migrations/0068_preserve_automatic_send_on_binding.sql",
  "database/migrations/0069_extend_website_bridge_response_lease.sql",
  "database/migrations/0072_professional_background_dispatch_dependencies.sql",
  "database/migrations/0075_chatgpt_bridge_revoke_reset.sql",
  "database/migrations/0077_activation_dispatch_recovery.sql",
  "database/migrations/0079_chatgpt_bridge_lease_recovery.sql",
  "database/migrations/0080_chatgpt_bridge_lease_heartbeat.sql",
  "database/migrations/0081_chatgpt_bridge_delivery_timing.sql",
  "database/migrations/0082_chatgpt_rate_limit_dispatcher_grant_repair.sql",
  "database/migrations/0083_chatgpt_bridge_delivery_v2.sql",
  "database/migrations/0084_chatgpt_bridge_safety_hardening.sql",
  "database/migrations/0085_chatgpt_bridge_boundary_reconciliation.sql",
  "database/migrations/0086_chatgpt_adaptive_concurrency_backoff.sql",
  "database/migrations/0087_chatgpt_bridge_protocol_v2_compatibility.sql",
  "database/migrations/0088_chatgpt_bridge_capability_upgrade.sql",
  "database/migrations/0089_chatgpt_bridge_rollout_telemetry.sql",
  "database/migrations/0090_chatgpt_bridge_lifecycle_diagnostics.sql",
  "database/migrations/0091_chatgpt_bridge_lifecycle_post_send.sql",
  "database/migrations/0092_chatgpt_bridge_lifecycle_async_writes.sql",
  "database/migrations/0093_chatgpt_bridge_lifecycle_first_observation.sql",
  "database/migrations/0097_chatgpt_response_provenance.sql",
  "database/migrations/0098_chatgpt_bridge_onboarding_reset_reconciliation.sql",
  "database/migrations/0099_chatgpt_bridge_dispatch_readiness.sql",
  "database/migrations/0100_chatgpt_bridge_quarantine_pre_v3_dispatches.sql",
  "supabase/functions/chatgpt-bridge/index.ts",
  "apps/web/lib/chatgpt/dispatch-registry.ts",
  "apps/web/app/api/chatgpt-bridge/dispatch/route.ts",
  "apps/web/app/api/chatgpt-bridge/dispatch/cancel/route.ts",
  "apps/web/app/api/chatgpt-bridge/pairing/route.ts",
  "apps/web/app/api/chatgpt-bridge/status/route.ts",
  "apps/web/lib/chatgpt-bridge/dispatch-state.ts",
  "apps/web/lib/chatgpt-bridge/dispatch-state.test.mjs",
  "apps/web/lib/chatgpt-bridge/status-poller.ts",
  "apps/web/lib/chatgpt-bridge/status-poller.test.mjs",
  "apps/web/lib/chatgpt-bridge/use-dispatch-status.ts",
  "apps/web/lib/chatgpt-bridge/lifecycle.ts",
  "apps/web/lib/chatgpt-bridge/lifecycle.test.mjs",
  "apps/web/lib/chatgpt-bridge/readiness.ts",
  "apps/web/lib/chatgpt-bridge/readiness.test.mjs",
  "apps/web/app/api/chatgpt-bridge/dispatch/lifecycle/route.ts",
  "apps/web/components/chatgpt-bridge-settings.tsx",
  "apps/web/components/chatgpt-activity-indicator.tsx",
  "apps/web/lib/chatgpt-bridge/activity.ts",
  "apps/web/lib/chatgpt-bridge/activity.test.mjs",
  "apps/web/lib/job-url-inspection-response.ts",
  "supabase/functions/chatgpt-bridge/job-url-inspection-response.ts",
  "database/migrations/0116_chatgpt_bridge_job_inspection_capture_v3.sql",
  "database/migrations/0101_chatgpt_bridge_v3_security_boundary.sql",
  "database/migrations/0108_bridge_bulk_job_url_imports.sql",
  "apps/chatgpt-bridge-extension/manifest.template.json",
  "apps/chatgpt-bridge-extension/package.json",
  "apps/chatgpt-bridge-extension/test/bridge.test.mjs",
  "docs/CHATGPT_BRIDGE.md",
  "docs/CHATGPT_BRIDGE_ACCEPTANCE.md",
  "scripts/verify-chatgpt-bridge-release.mjs",
  "docs/releases/chatgpt-bridge-v0.2.4.json",
];
let failed = false;
const fail = (message) => { console.error(`ChatGPT bridge verification: ${message}`); failed = true; };
for (const relative of required) if (!fs.existsSync(path.resolve(relative))) fail(`missing ${relative}`);

const migration = fs.readFileSync(path.resolve("database/migrations/0057_chatgpt_browser_dispatch.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0058_chatgpt_bridge_conversation_slots.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0059_chatgpt_dispatch_queue_state_fix.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0060_chatgpt_project_name_jobhuntai.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0061_chatgpt_bridge_upgrade_recovery.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0062_chatgpt_rate_limit_dispatcher_grant.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0063_website_bridge_primary_dispatch.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0068_preserve_automatic_send_on_binding.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0069_extend_website_bridge_response_lease.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0072_professional_background_dispatch_dependencies.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0077_activation_dispatch_recovery.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0079_chatgpt_bridge_lease_recovery.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0080_chatgpt_bridge_lease_heartbeat.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0082_chatgpt_rate_limit_dispatcher_grant_repair.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0083_chatgpt_bridge_delivery_v2.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0084_chatgpt_bridge_safety_hardening.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0090_chatgpt_bridge_lifecycle_diagnostics.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0091_chatgpt_bridge_lifecycle_post_send.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0092_chatgpt_bridge_lifecycle_async_writes.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0093_chatgpt_bridge_lifecycle_first_observation.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0097_chatgpt_response_provenance.sql"), "utf8") + fs.readFileSync(path.resolve("database/migrations/0098_chatgpt_bridge_onboarding_reset_reconciliation.sql"), "utf8");
const boundaryReconciliationMigration = fs.readFileSync(path.resolve("database/migrations/0085_chatgpt_bridge_boundary_reconciliation.sql"), "utf8");
const migrationWithBoundaryReconciliation = migration + boundaryReconciliationMigration;
const readinessMigration = fs.readFileSync(path.resolve("database/migrations/0099_chatgpt_bridge_dispatch_readiness.sql"), "utf8");
const quarantineMigration = fs.readFileSync(path.resolve("database/migrations/0100_chatgpt_bridge_quarantine_pre_v3_dispatches.sql"), "utf8");
const migrationWithReadiness = migrationWithBoundaryReconciliation + readinessMigration + quarantineMigration;
const migrationVersions = new Map();
for (const name of fs.readdirSync(path.resolve("database/migrations")).filter((entry) => entry.endsWith(".sql"))) {
  const version = name.split("_", 1)[0];
  migrationVersions.set(version, [...(migrationVersions.get(version) || []), name]);
}
for (const [version, names] of migrationVersions) if (names.length > 1) fail(`migration version ${version} is duplicated: ${names.join(", ")}`);
if (fs.existsSync(path.resolve("database/migrations/0081_chatgpt_rate_limit_dispatcher_grant_repair.sql"))) fail("the old rate-limit repair filename still collides with canonical migration 0081");
if (!fs.readFileSync(path.resolve("database/migrations/0081_chatgpt_bridge_delivery_timing.sql"), "utf8").includes("bounded Website Bridge delivery timing")) fail("canonical migration 0081 is not the delivery-timing migration");
if (!fs.readFileSync(path.resolve("database/migrations/0082_chatgpt_rate_limit_dispatcher_grant_repair.sql"), "utf8").includes("Safe repair for the rejected historical rate-limit grant proposal")) fail("migration 0082 does not preserve the rate-limit repair");
const revokeResetMigration = fs.readFileSync(path.resolve("database/migrations/0075_chatgpt_bridge_revoke_reset.sql"), "utf8");
for (const marker of [
  "create table if not exists public.chatgpt_bridge_devices",
  "create table if not exists public.chatgpt_bridge_pairing_codes",
  "create table if not exists public.chatgpt_dispatch_requests",
  "alter table public.chatgpt_bridge_devices enable row level security",
  "chatgpt_bridge_devices_no_direct_client_access",
  "grant select, insert, update, delete on public.chatgpt_bridge_devices to service_role",
  "chatgpt_bridge_service_pair_device",
  "chatgpt_bridge_service_claim_dispatch",
  "chatgpt_claim_dispatch_request_internal",
  "chatgpt_save_document_draft_internal",
  "unique(user_id, idempotency_key)",
  "public.chatgpt_bridge_conversation_slots",
  "private.chatgpt_bridge_workflow",
  "workflow_key",
  "conversation_slot_not_bound",
  "restored_workflow_count",
  "website_instruction",
  "mcp_fallback_instruction",
  "bridge_response",
  "chatgpt_bridge_service_complete_dispatch",
  "website_bridge_response_captured",
  "action-agnostic",
  "create_chatgpt_dispatch_request_with_dependencies",
  "depends_on_request_ids",
  "source_memory_update_incomplete",
  "resume_professional_background_activation",
  "response_check_only",
  "chatgpt_bridge_service_claim_dispatch_v2",
  "chatgpt_bridge_service_authorize_send",
  "chatgpt_bridge_service_authorize_send_v2",
  "chatgpt_bridge_service_get_dispatch_v2",
  "chatgpt_bridge_service_record_send_anchor",
  "chatgpt_bridge_service_prepare_dispatch_v2",
  "chatgpt_bridge_service_confirm_sent",
  "chatgpt_bridge_service_complete_dispatch_v2",
  "delivery_attempt_id",
  "response_deadline_at",
  "available_at",
  "delivery_turn_anchor",
  "send_attempted_at",
  "retry_chatgpt_dispatch_request",
  "create_chatgpt_response_check_dispatch",
  "response_check_available",
  "The dispatch turn anchor contains an unsupported field",
  "chatgpt_bridge_merge_lifecycle",
  "record_chatgpt_dispatch_lifecycle",
  "get_chatgpt_dispatch_lifecycle",
  "lifecycle_json",
  "chatgpt_bridge_service_complete_dispatch_v3",
  "chatgpt_bridge_service_complete_reused_dispatch_v3",
  "response_provenance",
  "chatgpt_validate_response_provenance",
  "user_or_onboarding_reset",
]) if (!migrationWithBoundaryReconciliation.includes(marker)) fail(`migration is missing ${marker}`);
if (!migration.includes("values(v_user,v_work_kind,'queued',left('dispatch:'||v_key,200)")) fail("dispatch work items do not start in queued state");
if (!migration.includes("check (project_name = 'JobHuntAI')")) fail("bridge conversation slots do not require the JobHuntAI Project");
if (!migration.includes("public.chatgpt_consume_rate_limit(text,text,integer,integer)") || !migration.includes("grant execute on function public.chatgpt_consume_rate_limit")) fail("MCP rate-limit dispatcher execute grant is missing");
if (!migrationWithBoundaryReconciliation.includes("v_request.send_attempted_at is not null") || !migrationWithBoundaryReconciliation.includes("v_request.delivery_turn_anchor is not null")) fail("retry RPCs do not fence v2 send-boundary records");
if (!migrationWithBoundaryReconciliation.includes("expires_at=greatest(") || !migrationWithBoundaryReconciliation.includes("legacy dispatch with ambiguous delivery cannot be retried automatically")) fail("explicit retries do not renew expired requests or fence ambiguous legacy deliveries");
if (!migrationWithBoundaryReconciliation.includes("p_idempotency_key is distinct from v_key") || !migrationWithBoundaryReconciliation.includes("v_source.delivery_turn_anchor is null")) fail("response checks are not deterministically idempotent and anchor-gated");
if (!boundaryReconciliationMigration.includes("chatgpt_bridge_service_reconcile_v2") || !boundaryReconciliationMigration.includes("response_deadline_at<=now()") || !boundaryReconciliationMigration.includes("v_anchor := coalesce(v_request.delivery_turn_anchor,p_turn_anchor)")) fail("v2 boundary reconciliation does not preserve anchors and sweep post-expiry requests");
if (!migrationWithReadiness.includes("server_capabilities") || !migrationWithReadiness.includes("result_completion_v3") || !migrationWithReadiness.includes("response_provenance_v3")) fail("bridge server readiness capabilities are missing");
if (!quarantineMigration.includes("bridge_upgrade_required") || !quarantineMigration.includes("send_attempted_at is null") || !quarantineMigration.includes("No ChatGPT message was sent")) fail("pre-v3 queued dispatches are not quarantined before Send");
if (!revokeResetMigration.includes("workflow_bindings_removed") || !revokeResetMigration.includes("delete from public.chatgpt_bridge_conversation_slots") || !revokeResetMigration.includes("external_chatgpt_conversations_deleted")) fail("bridge revocation does not fully reset workflow bindings");
for (const forbidden of [
  "grant select, insert, update, delete on public.chatgpt_bridge_devices to authenticated",
  "grant select, insert, update, delete on public.chatgpt_dispatch_requests to authenticated",
  "OPENAI_API_KEY",
]) if (migrationWithBoundaryReconciliation.includes(forbidden)) fail(`unsafe bridge marker present: ${forbidden}`);

const registry = fs.readFileSync(path.resolve("apps/web/lib/chatgpt/dispatch-registry.ts"), "utf8");
const dispatchRoute = fs.readFileSync(path.resolve("apps/web/app/api/chatgpt-bridge/dispatch/route.ts"), "utf8");
if (!dispatchRoute.includes("p_website_instruction") || !dispatchRoute.includes("A plain-language Website Bridge task is required") || dispatchRoute.includes("buildDispatchInstruction")) fail("primary dispatch route must require action-owned Website Bridge wording without generating an internal prompt");
if (!fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/shared/protocol.ts"), "utf8").includes('CHATGPT_PROJECT_NAME = "JobHuntAI"')) fail("Website Bridge Project name is not JobHuntAI");
const backgroundDispatch = fs.readFileSync(path.resolve("apps/web/lib/chatgpt/professional-background-dispatch.ts"), "utf8");
const backgroundRoute = fs.readFileSync(path.resolve("apps/web/app/api/onboarding/professional-background/route.ts"), "utf8");
const memoryRoute = fs.readFileSync(path.resolve("apps/web/app/api/onboarding/memory/route.ts"), "utf8");
if (!backgroundDispatch.includes("create_chatgpt_dispatch_request_with_dependencies") || !backgroundDispatch.includes("dependencyRequestIds") || !backgroundDispatch.includes("legacyIdempotencyKey")) fail("professional-background dispatches do not use the dependency-aware creator and legacy-mode guard");
if (!backgroundDispatch.includes("profile.background:${mode}:source") || !backgroundDispatch.includes("PROFESSIONAL_BACKGROUND_SUMMARY_KEY_PREFIX")) fail("professional-background source and summary idempotency keys are not mode/version separated");
if (!backgroundDispatch.includes("dependencyRequestIds: dispatches.map")) fail("structured profile dispatch does not depend on every source dispatch");
if (!backgroundRoute.includes("if (!refreshOnly && allowMemoryUpdate)")) fail("professional-background route can still queue source context before Memory authorization");
if (!memoryRoute.includes("source_memory_update_incomplete") || !memoryRoute.includes("depends_on_request_ids") || !memoryRoute.includes("create_chatgpt_response_check_dispatch")) fail("Memory import recovery does not handle blocked source dependencies or validated response checks");
if (!memoryRoute.includes("profile.memory.response-check:${previous.id}") || memoryRoute.includes("profile.memory.response-check:${previous.id}:${crypto.randomUUID()}")) fail("Memory response checks do not use one deterministic source key");
for (const action of ["job.inspect_url", "jobs.search.manual", "jobs.analyse_selected", "documents.cv.create", "documents.cover_letter.create", "emails.process_now", "tracker.sync_now", "bridge.diagnostic"]) if (!registry.includes(`"${action}"`)) fail(`dispatch registry is missing ${action}`);
for (const retiredRoute of [
  "apps/web/app/api/chatgpt/mcp/route.ts",
  "apps/web/app/api/chatgpt/oauth/token/route.ts",
  "apps/web/app/api/chatgpt/metadata/protected-resource/route.ts",
]) if (fs.existsSync(path.resolve(retiredRoute))) fail(`retired ChatGPT plugin route is still active: ${retiredRoute}`);
const dispatchStatusRoute = fs.readFileSync(path.resolve("apps/web/app/api/chatgpt-bridge/dispatch/route.ts"), "utf8");
if (!dispatchStatusRoute.includes("delete dispatch.mcp_fallback_instruction") || !dispatchStatusRoute.includes("delete dispatch.required_mcp_tools")) fail("generic dispatch status still exposes plugin-only fields");
const bridgeSettingsUi = fs.readFileSync(path.resolve("apps/web/components/chatgpt-bridge-settings.tsx"), "utf8");
if (bridgeSettingsUi.includes("Verified by the paired Website Bridge") || !bridgeSettingsUi.includes("current login status is not tracked here")) fail("Bridge settings overstate the ChatGPT login state instead of explaining its setup-only check");
const operationMigration = fs.readFileSync(path.resolve("database/migrations/0114_chatgpt_operation_lock_and_captured_import_recovery.sql"), "utf8");
const operationOverrideMigration = fs.readFileSync(path.resolve("database/migrations/0115_diagnostics_chatgpt_action_lock_override.sql"), "utf8");
const bridgeInspectionMigration = fs.readFileSync(path.resolve("database/migrations/0116_chatgpt_bridge_job_inspection_capture_v3.sql"), "utf8");
if (!operationMigration.includes("pg_advisory_xact_lock") || !operationMigration.includes("chatgpt_user_operation_locks") || !operationMigration.includes("'send_attempted'")) fail("ChatGPT initiation is not serialized across tabs and send-boundary states");
if (!operationMigration.includes("retry_captured_job_url_inspection") || !operationMigration.includes("response_provenance") || !operationMigration.includes("response_provenance_recorded")) fail("captured listing response recovery is not tied to the stored v3-proven dispatch");
if (!bridgeInspectionMigration.includes("chatgpt_validate_response_provenance") || !bridgeInspectionMigration.includes("chatgpt_bridge_service_apply_job_url_inspection_v3") || !bridgeInspectionMigration.includes("security invoker")) fail("captured listing import does not use the exact-turn v3 service boundary and invoker wrapper");
if (!operationMigration.includes("create or replace function public.manage_chatgpt_user_operation") || !operationMigration.includes("security invoker") || !operationMigration.includes("to authenticated")) fail("cross-page activity RPC does not preserve the authenticated invoker boundary");
if (!operationOverrideMigration.includes("chatgpt_action_lock_disabled boolean not null default false") || !operationOverrideMigration.includes("'set_action_lock_disabled'") || !operationOverrideMigration.includes("lock_disabled")) fail("Diagnostics action-lock override is missing its secure default-off server setting");
if (!operationOverrideMigration.includes("primary key (user_id, operation_id)") || !operationOverrideMigration.includes("pg_advisory_xact_lock")) fail("Concurrent ChatGPT operations are not serialized safely and tracked independently");
for (const route of [
  "apps/web/app/api/chatgpt-bridge/dispatch/route.ts",
  "apps/web/app/api/chatgpt-bridge/dispatch/retry/route.ts",
  "apps/web/app/api/chatgpt-bridge/diagnostic-message/route.ts",
  "apps/web/app/api/chatgpt-bridge/test/route.ts",
  "apps/web/app/api/jobs/inspect/route.ts",
  "apps/web/app/api/search/manual/route.ts",
  "apps/web/app/api/onboarding/preferences/route.ts",
  "apps/web/app/api/onboarding/professional-background/route.ts",
  "apps/web/app/api/onboarding/memory/route.ts",
  "apps/web/app/api/onboarding/complete/route.ts",
]) {
  if (!fs.readFileSync(path.resolve(route), "utf8").includes("beginChatGptOperation")) fail(`ChatGPT-initiating API route is not guarded by the shared lock: ${route}`);
}
for (const component of [
  "apps/web/components/chatgpt-dispatch-button.tsx",
  "apps/web/components/diagnostics-message-form.tsx",
  "apps/web/components/chatgpt-bridge-settings.tsx",
  "apps/web/components/job-url-inspection-form.tsx",
  "apps/web/components/manual-search-button.tsx",
  "apps/web/components/job-search-preferences.tsx",
  "apps/web/components/onboarding-workspace.tsx",
  "apps/web/components/chatgpt-memory-setup.tsx",
]) {
  const source = fs.readFileSync(path.resolve(component), "utf8");
  if (!source.includes("useChatGptOperation") || !source.includes("chatgptOperation.blocked")) fail(`A ChatGPT-initiating control does not disable while another action is active: ${component}`);
}
const operationProvider = fs.readFileSync(path.resolve("apps/web/components/chatgpt-operation-provider.tsx"), "utf8");
if (!operationProvider.includes("/api/chatgpt-bridge/activity") || !operationProvider.includes("chatgptActivitySpinner") || !operationProvider.includes("beginLocalOperation")) fail("The shared activity provider lacks cross-tab polling, the waiting indicator, or an immediate in-tab action lock");
if (!operationProvider.includes("lock_disabled") || !operationProvider.includes("busy && !overrideEnabled")) fail("The diagnostics override does not consistently bypass both global and local action blocking");
if (!fs.existsSync(path.resolve("apps/web/components/diagnostics-chatgpt-action-lock-toggle.tsx")) || !fs.existsSync(path.resolve("apps/web/app/api/diagnostics/chatgpt-action-lock/route.ts"))) fail("The diagnostics action-lock control or authenticated API is missing");
if (!fs.readFileSync(path.resolve("apps/web/app/diagnostics/page.tsx"), "utf8").includes("DiagnosticsChatGptActionLockToggle")) fail("The action-lock override is not exposed on Diagnostics");
const activityIndicator = fs.readFileSync(path.resolve("apps/web/components/chatgpt-activity-indicator.tsx"), "utf8");
const activityPolicy = fs.readFileSync(path.resolve("apps/web/lib/chatgpt-bridge/activity.ts"), "utf8");
if (!activityIndicator.includes("isWaitingForChatGpt") || !activityPolicy.includes('["sent", "acknowledged_by_mcp", "running"]') || !activityPolicy.includes("result_pending") || !activityPolicy.includes("response_detected_at")) fail("ChatGPT spinner does not distinguish actual generation from queued work and result upload");

const extensionSource = fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/shared/protocol.ts"), "utf8") + fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/shared/storage.ts"), "utf8") + fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/background.ts"), "utf8") + fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/content/chatgpt.ts"), "utf8") + fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/content/ui-adapter.ts"), "utf8") + fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/popup.ts"), "utf8");
for (const forbidden of ["OPENAI_API_KEY", "api.openai.com", "chrome.cookies", "webRequest", "<all_urls>"]) if (extensionSource.includes(forbidden)) fail(`extension contains forbidden capability ${forbidden}`);
if (!/(never resends automatically|Do not resend automatically|no automatic resend)/.test(extensionSource) || !extensionSource.includes("bound conversation") || !extensionSource.includes("SET_UP_WORKFLOW_CONVERSATIONS") || !extensionSource.includes("ROTATE_WORKFLOW_CONVERSATION")) fail("extension safe-stop, binding, or automatic setup language is missing");
if (!extensionSource.includes("workflowSetupCooldownSeconds") || extensionSource.includes("WORKFLOW_SETUP_COOLDOWN_MS")) fail("workflow setup pause must be user-configurable in seconds");
if (extensionSource.includes("ensureJobHuntAppSelected") || extensionSource.includes("APP_PICKER_TEXT_RE") || extensionSource.includes("waitForJobHuntAppOption")) fail("dispatch must not require ChatGPT's +/app picker");
if (!extensionSource.includes("WAIT_FOR_DISPATCH_RESPONSE") || !extensionSource.includes("waitForAssistantResponse") || !extensionSource.includes("CHECK_DISPATCH_RESPONSE") || !extensionSource.includes("CHECK_EXISTING_DISPATCH_RESPONSE") || !extensionSource.includes("get_active_dispatch") || !extensionSource.includes("Check completed professional profile response") || !extensionSource.includes("server_instruction_not_plain_language") || !extensionSource.includes("SENT_VERIFICATION_TIMEOUT_MS") || !extensionSource.includes("response_check_only")) fail("Website Bridge response capture, recovery, or legacy-instruction guard is missing");
if (!extensionSource.includes("activeDispatch") || !extensionSource.includes("responseWaitInFlight")) fail("Website Bridge does not persist and recover an in-flight response wait after service-worker suspension");
if (!extensionSource.includes("VERIFY_BOUND_CONVERSATION") || !extensionSource.includes("conversation_missing")) fail("Workflow setup does not verify and repair missing bound conversations");
if (!extensionSource.includes("JOBHUNT_BRIDGE_RESET_LOCAL") || !extensionSource.includes("RESET_LOCAL_PAIRING")) fail("Server-side bridge revocation does not reset local extension state");
if (!extensionSource.includes("waitForTabNavigation")) fail("Workflow setup does not wait for bound conversation navigation to settle");
if (!extensionSource.includes("CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS")) fail("Website Bridge response capture timeout is not bounded by the shared long-running limit");
if (!extensionSource.includes("mutateDispatchRecords") || !extensionSource.includes("storageMutationQueue")) fail("Dispatch record writes are not serialized through the local storage mutation queue");
if (!extensionSource.includes("authorized?.may_send !== true") || extensionSource.includes('authorized?.state !== "send_attempted"')) fail("The v2 send boundary must fail closed when the server returns an idempotent send_attempted response");
if (!extensionSource.includes('bridgeCallV2("get_dispatch_v2"') || !extensionSource.includes("dispatchTurnAnchorFromUnknown")) fail("v2 worker recovery does not reconcile the durable server send boundary before resuming");
if (!extensionSource.includes('record_dispatch_lifecycle') || !extensionSource.includes("response_uploaded_at") || !extensionSource.includes("send_boundary_recorded_at")) fail("extension lifecycle diagnostics do not record the send and upload boundaries");
if (!fs.readFileSync(path.resolve("apps/chatgpt-bridge-extension/src/background.ts"), "utf8").includes("settings?.dispatchRecords?.[request.id]")) fail("v2 SPA-reload recovery does not consult the persisted per-request dispatch record");
if (extensionSource.includes("boundProjectVerified: true, automaticSendEnabled: false")) fail("Workflow binding must not switch Automatic Send off");
if (!extensionSource.includes("Automatic Send remains enabled") || !extensionSource.includes("Automatic Send is on")) fail("Workflow setup UI does not promise to preserve Automatic Send");
const automaticSendMigration = fs.readFileSync(path.resolve("database/migrations/0068_preserve_automatic_send_on_binding.sql"), "utf8");
if (automaticSendMigration.includes("automatic_send_enabled=false")) fail("Binding migration must not switch Automatic Send off");

const employerHelper = fs.readFileSync(path.resolve("supabase/functions/form-agent-bridge/index.ts"), "utf8");
if (!employerHelper.includes("form-agent")) fail("existing employer-form helper was unexpectedly replaced or unrecognisable");
const bridge = fs.readFileSync(path.resolve("supabase/functions/chatgpt-bridge/index.ts"), "utf8");
if (bridge.includes("form-agent") || bridge.includes("FORM_AGENT")) fail("ChatGPT bridge references the employer-form helper boundary");
if (!bridge.includes("workflowKey") || !bridge.includes("conversations")) fail("ChatGPT bridge does not expose per-workflow conversation routing");
if (!bridge.includes('op === "complete_dispatch"')) fail("ChatGPT bridge does not expose response completion");
for (const operation of ["device_poll_v2", "claim_dispatch_v2", "authorize_send", "get_dispatch_v2", "record_send_anchor", "prepare_dispatch_v2", "confirm_sent", "defer_dispatch", "complete_dispatch_v2", "complete_dispatch_v3", "complete_reused_dispatch_v2", "complete_reused_dispatch_v3", "touch_dispatch_v2", "reopen_response_capture", "stop_dispatch_v2"]) if (!bridge.includes(`op === "${operation}"`)) fail(`ChatGPT bridge does not expose ${operation}`);
if (!bridge.includes('op === "record_dispatch_lifecycle"') || !bridge.includes("chatgpt_bridge_service_record_dispatch_lifecycle")) fail("ChatGPT bridge does not expose lifecycle diagnostics");
if (!bridge.includes("SERVER_CAPABILITIES") || !bridge.includes("server_capabilities")) fail("ChatGPT bridge does not advertise its deployed result-completion capabilities");
if (!bridge.includes("supportsResultCompletionV3Device") || !bridge.includes("must be updated to the v3 result-completion contract")) fail("ChatGPT bridge does not fail closed for pre-v3 devices before claiming requests");
if (!bridge.includes('supabase.rpc("chatgpt_bridge_service_authorize_send_v2"')) fail("the Edge Function does not atomically authorize Send with its durable turn anchor");
if (!bridge.includes("chatgpt_bridge_service_reconcile_v2")) fail("ChatGPT bridge does not reconcile expired v2 dispatches before claiming");
if (!bridge.includes("persistCapturedJobInspection") || !bridge.includes("bridge_retryable_error") || !bridge.includes("parseJobUrlInspectionBatchResponse")) fail("ChatGPT bridge does not persist exact v3 listing results through the shared strict parser and retryable capture upload");

const dispatchStatusHook = fs.readFileSync(path.resolve("apps/web/lib/chatgpt-bridge/use-dispatch-status.ts"), "utf8");
const dispatchStatusPoller = fs.readFileSync(path.resolve("apps/web/lib/chatgpt-bridge/status-poller.ts"), "utf8");
if (!dispatchStatusHook.includes("createDispatchStatusPoller") || !dispatchStatusHook.includes("bindDispatchWakeEvents")) fail("web dispatch status hook is not connected to the shared poller and lifecycle wakeups");
if (!dispatchStatusPoller.includes("const sharedPollers = new Map") || !dispatchStatusPoller.includes("subscribers: new Set") || !dispatchStatusPoller.includes("finally") || !dispatchStatusPoller.includes("JOBHUNT_DISPATCH_UPDATED")) fail("web dispatch status polling is not shared, retry-safe, or extension-aware");
if (!fs.readFileSync(path.resolve("apps/web/lib/chatgpt-bridge/status-poller.test.mjs"), "utf8").includes("HTTP 500 JSON errors")) fail("web dispatch poller tests do not cover valid JSON server failures");
if (!extensionSource.includes("reconcileV2RecoveryPhase") || !extensionSource.includes("v2RecoveryActionForPhase")) fail("v2 coordinator recovery boundary mapping is not centralized and testable");
if (!extensionSource.includes("responseProvenance") || !extensionSource.includes("conversation_history_not_ready") || !extensionSource.includes("generationFinished")) fail("exact-turn response provenance and generation fence are missing");
if (!extensionSource.includes("lastHeartbeatAt") || !extensionSource.includes("lastHeartbeatError") || !extensionSource.includes("startBackgroundRuntime")) fail("bridge startup and heartbeat failures are not surfaced for recovery");

if (failed) process.exit(1);
console.log("ChatGPT bridge repository verification passed.");
