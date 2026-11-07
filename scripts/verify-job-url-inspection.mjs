import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const exists = (file) => fs.existsSync(file);
const must = (condition, message) => { if (!condition) throw new Error(message); };

const queueMigration = read("database/migrations/0055_job_url_inspection.sql");
const persistenceMigration = read("database/migrations/0056_immediate_openai_job_inspection.sql");
const batchMigration = read("database/migrations/0108_bridge_bulk_job_url_imports.sql");
const capturedRecoveryMigration = read("database/migrations/0114_chatgpt_operation_lock_and_captured_import_recovery.sql");
const bridgeCaptureMigration = read("database/migrations/0116_chatgpt_bridge_job_inspection_capture_v3.sql");
const combinedImportMigration = read("database/migrations/20261106212716_combined_job_url_memory_fit.sql");
const terminalFitMigration = read("database/migrations/20261106220538_m04_terminal_fit_outcomes.sql");
const m04RecoveryMigration = read("database/migrations/20261107090000_m04_batch_recovery_and_identity.sql");
const m04SchemaCacheMigration = read("database/migrations/20261107150039_m04_dispatch_lookup_schema_cache.sql");
const m04BatchDispatchRpcMigration = read("database/migrations/20261107150350_m04_batch_dispatch_lookup_rpc.sql");
const canonicalDedupeMigration = read("database/migrations/0110_canonical_job_dedupe_key.sql");
const legacyBridgeSecurity = read("database/migrations/0101_chatgpt_bridge_v3_security_boundary.sql");
const route = read("apps/web/app/api/jobs/inspect/route.ts");
const form = read("apps/web/components/job-url-inspection-form.tsx");
const prompt = read("apps/web/lib/job-url-inspection-prompt.ts");
const parser = read("supabase/functions/chatgpt-bridge/job-url-inspection-response.ts");
const bridgeFunction = read("supabase/functions/chatgpt-bridge/index.ts");
const extensionBackground = read("apps/chatgpt-bridge-extension/src/background.ts");
const parserTests = read("apps/web/lib/chatgpt-bridge/job-url-inspection-prompt.test.mjs");
const jobsPage = read("apps/web/app/jobs/page.tsx");
const addPage = read("apps/web/app/jobs/add/page.tsx");
const pool = read("apps/web/components/job-pool-table.tsx");
const detail = read("apps/web/app/jobs/[id]/page.tsx");
const applicationButton = read("apps/web/components/application-create-button.tsx");

must(queueMigration.includes("create table if not exists public.job_url_inspection_requests"), "URL inspection queue table missing");
must(queueMigration.includes("enable row level security") && queueMigration.includes("job_url_inspection_requests_owner_select"), "URL inspection queue is not owner-protected");
must(queueMigration.includes("never_login_or_apply") && queueMigration.includes("read_only_browsing"), "URL inspection safety boundary missing");
must(persistenceMigration.includes("complete_job_url_inspection") && persistenceMigration.includes("auth.uid()"), "Authenticated existing listing-persistence boundary missing");
must(batchMigration.includes("add column batch_id uuid") && batchMigration.includes("batch_position") && batchMigration.includes("dispatch_request_id"), "Persistent batch tracking columns missing");
must(batchMigration.includes("job_url_inspection_requests_owner_update_dispatch") && batchMigration.includes("grant update(dispatch_request_id)"), "Batch dispatch linking is not narrowly owner-scoped");
must(batchMigration.includes("chatgpt_oauth_access_tokens") && batchMigration.includes("revoked_at"), "Retired plugin access tokens are not revoked");
must(legacyBridgeSecurity.includes("security invoker") && legacyBridgeSecurity.includes("to service_role"), "Existing v3 bridge security boundary must remain intact");
must(canonicalDedupeMigration.includes("pg_get_functiondef(v_signature)") && canonicalDedupeMigration.includes("v_company_key||'|external:'||v_external_id_key") && canonicalDedupeMigration.includes("v_company_key||'|'||v_title_key||'|'"), "ChatGPT URL-inspection deduplication is not aligned with the canonical manual-ingest key");
must(canonicalDedupeMigration.includes("v_legacy_dedupe") && canonicalDedupeMigration.includes("update public.jobs set dedupe_key=v_dedupe") && !canonicalDedupeMigration.includes("delete from public.jobs"), "Canonical deduplication does not safely recognize legacy imports without deleting user jobs");
must(canonicalDedupeMigration.includes("The installed listing-completion function no longer matches the reviewed dedupe patch") && canonicalDedupeMigration.includes("The canonical dedupe patch did not replace all reviewed source fragments"), "Canonical deduplication migration does not fail closed if the existing function changes");

must(route.includes("normalizeJobListingUrl") && route.includes("job_url_inspection_requests"), "URL API route is missing validation or durable inspection persistence");
must(route.includes("buildJobUrlInspectionInstruction") && route.includes("persistCombinedInitialFits"), "URL inspection does not build a bounded combined prompt and persist the same-response fit through the existing analysis path");
must(route.includes("MAX_BULK_URLS = 10") && route.includes("sourceUrls") && route.includes("batch_id"), "URL API does not enforce bounded persistent bulk imports");
must(route.includes('supabase.rpc("create_job_url_inspection_batch_dispatch"') && route.includes("batchInstruction(inspections)"), "URL batch dispatch is not created or recovered through its atomic batch RPC");
must(route.includes('supabase.rpc("get_job_url_inspection_batch_dispatch"') && !route.includes('from("chatgpt_dispatch_requests")'), "Batch recovery must inspect dispatch identity through an owner-scoped RPC rather than weakening the dispatch table boundary");
must(route.includes("idempotentReplay: true") && route.includes("eq(\"batch_id\", batchId)") && route.includes("different URL list"), "A replayed client request id can create a duplicate import or be rebound to another URL batch");
must(form.includes("jobhunt:pending-job-url-import:v1") && form.includes("JSON.stringify({ sourceUrls, batchId })"), "The UI does not retain an exact request identity across an ambiguous submission retry");
must((m04RecoveryMigration.match(/create_chatgpt_dispatch_request_with_website_instruction\(/g) || []).length === 1 && m04RecoveryMigration.includes("p_action_type=>'job.inspect_url'"), "The atomic URL batch RPC must create or recover one generic Website Bridge request for the entire batch");
must(m04RecoveryMigration.includes("p_subject_refs=>jsonb_build_object('inspection_id',v_ids[1])"), "Bulk dispatch must honor the generic job.inspect_url inspection_id-only subject contract");
must(route.includes("function batchInstruction(inspections: Inspection[])") && route.includes("inspections.map((inspection) => ({ sourceUrl: inspection.source_url, requestId: inspection.id }))") && route.includes("assessmentTimestamp.toISOString()"), "The exact saved prompt identity cannot be reconstructed with a canonical timestamp for safe batch dispatch recovery");
must(route.indexOf("const instruction = applyChatGptTestingMode") < route.indexOf(".insert(insertRows)"), "Testing-mode/prompt size validation must finish before the batch creates persistent inspection rows");
must(m04RecoveryMigration.includes("update public.job_url_inspection_requests") && m04RecoveryMigration.includes("dispatch_request_id=v_dispatch_id") && m04RecoveryMigration.includes("v_linked_count<>v_count"), "The single batch dispatch is not transactionally linked to every owner-scoped listing row");
must(route.includes(".eq(\"batch_id\", inspection.batch_id)") && route.includes("reconcileInspections(supabase, inspections, user.id)"), "A single-entry status read does not reconcile its complete owner-scoped batch");
must(route.includes("finalForCapturedResponse") && route.includes("chunk.state === \"completed\" && chunkItemsFinal"), "Terminal batch reads can rewrite a verified final fit response unnecessarily");
must(m04RecoveryMigration.includes("create_job_url_inspection_batch_dispatch") && m04RecoveryMigration.includes("auth.uid()") && m04RecoveryMigration.includes("assert_active_app_membership") && m04RecoveryMigration.includes("grant execute on function public.create_job_url_inspection_batch_dispatch(uuid,text) to authenticated"), "Atomic batch dispatch recovery is missing its authenticated active-member boundary");
must(m04BatchDispatchRpcMigration.includes("create or replace function public.get_job_url_inspection_batch_dispatch(p_batch_id uuid)") && m04BatchDispatchRpcMigration.includes("grant execute on function public.get_job_url_inspection_batch_dispatch(uuid) to authenticated") && m04BatchDispatchRpcMigration.includes("where user_id=v_user and idempotency_key='job.inspect_url.batch:'||p_batch_id::text"), "Orphan dispatch lookup is not owner-scoped or authenticated");
must(m04SchemaCacheMigration.includes("notify pgrst, 'reload schema'") && m04BatchDispatchRpcMigration.includes("notify pgrst, 'reload schema'"), "The new M04 owner-scoped RPCs are not exposed to PostgREST after migration");
must(m04RecoveryMigration.includes("pg_advisory_xact_lock") && m04RecoveryMigration.includes("job-fit-memory-v4:"), "Concurrent retries can create duplicate initial-fit batches");
must(m04RecoveryMigration.includes("preserve_job_url_inspection_submitted_url") && m04RecoveryMigration.includes("new.original_source_url:=new.source_url"), "The upgraded schema does not preserve the supported M03 insert shape");
must(m04RecoveryMigration.includes("source_url in (v_request.source_url,v_identity_url)") && m04RecoveryMigration.includes("v_ats_key") && m04RecoveryMigration.includes("external_job_id"), "Vacancy matching is not constrained by exact URL or provider-scoped ATS identity");
must(!m04RecoveryMigration.includes("or dedupe_key in (v_legacy_dedupe"), "The M04 correction must not merge vacancies based only on legacy title/application-url dedupe");
must(route.includes("parseJobUrlInspectionBatchResponse") && route.includes("response_provenance_recorded !== true") && route.includes("complete_job_url_inspection"), "Batch result persistence does not require one v3-proven exact assistant turn");
must(route.includes("retry_captured_job_url_inspection") && capturedRecoveryMigration.includes("v_request.dispatch_request_id is distinct from p_dispatch_id") && capturedRecoveryMigration.includes("response_provenance_recorded"), "Captured listing recovery is not limited to the exact stored v3 dispatch");
must(route.includes("retained and will be retried without resending the original message") && !route.includes("startImmediateOpenAiInspection"), "Captured-result recovery must retry persistence without resending or bypassing the Website Bridge");
must(!route.includes("OPENAI_API_KEY") && !route.includes("startImmediateOpenAiInspection"), "Active URL API still exposes a direct OpenAI path");
must(route.includes("delete safe.mcp_fallback_instruction") && route.includes("delete safe.required_mcp_tools"), "Legacy plugin-only dispatch fields are not stripped from the URL API response");
for (const field of ["company", "title", "industry", "description", "application_url", "location", "salary_min", "salary_max", "salary_currency", "salary_source", "salary_confidence", "salary_basis", "posted_at", "closes_at", "employment_type", "ats_provider", "responsibilities", "essential_requirements", "desirable_requirements", "skills", "benefits", "application_instructions", "company_website", "raw_metadata"]) {
  must(prompt.includes(`"${field}":`) || prompt.includes(`${field}:`) || prompt.includes(`${field}=`), `Structured listing prompt is missing ${field}`);
}
must(prompt.includes("request_id=") && prompt.includes("batch_id") && prompt.includes("assessment_as_of") && prompt.includes("Return one compact JSON object only") && prompt.includes("results"), "Prompt does not identify its exact requests or combined extraction-and-fit response format");
must(prompt.includes("Use ChatGPT Memory") && prompt.includes("Never mix listings") && prompt.includes("never zero"), "Combined prompt is missing Memory-only fit, sibling isolation, or unknown-score safety instructions");
must(parser.includes("value.request_id !== requestId") && parser.includes("salary_basis") && parser.includes("ALLOWED_FIELDS") && parser.includes("parseCombinedJobUrlInspectionResponse"), "Structured combined response parser is missing request identity, field validation, or per-entry fit validation");
must(parser.includes("response was not one valid JSON object") && parser.includes("chatgpt_estimate"), "Parser does not reject malformed responses and unsupported estimates");
must(read("apps/web/lib/job-url-inspection-response.ts").includes("supabase/functions/chatgpt-bridge/job-url-inspection-response"), "The web fallback and Bridge do not share one strict listing parser");
must(bridgeFunction.includes("parseJobUrlInspectionBatchResponse") && bridgeFunction.includes("persistCapturedJobInspection"), "The Bridge does not parse and persist completed listing imports server-side");
must((bridgeFunction.match(/await persistCapturedJobInspection\(body\.requestId, responseHash\)/g) || []).length === 2, "Both initial and reused v3 result uploads must retry listing persistence");
must(bridgeFunction.includes("bridge_retryable_error") && bridgeFunction.includes("}, 503)"), "Transient captured-result import failures must remain upload-retryable without resending ChatGPT");
must(bridgeCaptureMigration.includes("chatgpt_validate_response_provenance") && bridgeCaptureMigration.includes("response_hash") && bridgeCaptureMigration.includes("dispatch_request_id = p_dispatch_id"), "The service-only import routine does not enforce exact v3 provenance, response hash, and dispatch linkage");
must(bridgeCaptureMigration.includes("security invoker") && bridgeCaptureMigration.includes("to service_role"), "The import PostgREST wrapper must remain SECURITY INVOKER with a service-only grant");
must(extensionBackground.includes("Always replay the same v3 completion") && extensionBackground.includes("never re-sends the ChatGPT message"), "Captured-result upload retry must replay v3 completion without dispatching ChatGPT again");
must(parserTests.includes("cross-request") && parserTests.includes("evidence basis"), "Exact-request and salary-provenance parser tests are missing");
must(parserTests.includes("combined response validates batch") && parserTests.includes("preserves valid extraction") && parserTests.includes("exactly 6,000 characters"), "M04 combined correlation, partial fit, and exact instruction-boundary tests are missing");
must(parserTests.includes("malformed non-found reasons are isolated to their entry while valid siblings survive"), "Malformed non-found reason isolation is not covered for Edge and web combined-response parsing");
must(parserTests.includes("visual line break") && parserTests.includes("talent@ukaea.org.uk"), "A linkified newline regression is not covered by the shared parser test");

must(form.includes('type="url"') && form.includes("Add another job URL") && form.includes("MAX_BULK_URLS = 10") && form.includes("Import progress"), "Jobs UI lacks individual dynamic URL fields, a bounded add control, or per-listing progress");
must(form.includes("All listed URLs will be processed together.") && form.includes("one ChatGPT request"), "Jobs UI does not make its one-request batch behavior explicit");
must(form.includes("jobhunt:last-job-url-import-batch:v1") && form.includes("batchId") && form.includes("/api/jobs/inspect?batchId="), "Bulk import status is not restored across reloads");
must(form.includes("retry_allowed") && form.includes("captured_result_retry_allowed") && form.includes("Retry saving captured result (no resend)") && form.includes("/api/chatgpt-bridge/dispatch/retry") && !form.includes("MCP fallback"), "Failure recovery does not expose safe generic delivery retry and captured-result-only persistence retry");
must(addPage.includes("JobUrlInspectionForm") && addPage.includes("JobIngestForm"), "Add-job page does not mount both ingestion paths");
must(pool.includes("Job pool") && pool.includes("since posting") && pool.includes("Choose to apply"), "Job pool does not expose the unified application pool table");
must(applicationButton.includes("actionLabel"), "Application chooser cannot be reused from the job pool table");
must(detail.includes("ChatGPT listing extraction") && detail.includes("salarySource"), "Job detail does not show extraction and salary provenance");
must(combinedImportMigration.includes("save_job_url_inspection_initial_fit") && combinedImportMigration.includes("chatgpt_validate_response_provenance") && combinedImportMigration.includes("original_source_url"), "M04 migration is missing exact-turn provenance, original submitted URL, or initial-fit status persistence");
must(terminalFitMigration.includes("private.assert_active_app_membership") && terminalFitMigration.includes("auth.uid()") && terminalFitMigration.includes("chatgpt_validate_response_provenance"), "Terminal fit outcomes are not owner-scoped to active membership and exact response provenance");
must(terminalFitMigration.includes("save_job_url_inspection_initial_fit_outcome") && terminalFitMigration.includes("mark_job_url_inspection_initial_fit_needs_user"), "M04 terminal fit outcomes do not distinguish exact captured results from unverified attention states");
must(terminalFitMigration.includes("response_hash") && terminalFitMigration.includes("v_request.initial_fit_response_hash is not null") && terminalFitMigration.includes("v_request.dispatch_request_id is distinct from p_dispatch_id"), "Terminal fit outcomes can bypass dispatch correlation or overwrite an existing fit result");
must(route.includes("saveTerminalInitialFitOutcome") && route.includes("markInitialFitNeedsUser") && route.includes("The original message was not resent"), "M04 recovery does not save an accurate terminal fit state without resending the Bridge message");
for (const retired of [
  "apps/web/app/api/chatgpt/mcp/route.ts",
  "apps/web/app/api/chatgpt/oauth/token/route.ts",
  "apps/web/app/api/chatgpt/metadata/protected-resource/route.ts",
]) must(!exists(retired), `Retired plugin endpoint still exists: ${retired}`);

console.log("Bridge-only bulk job URL inspection verification passed.");
