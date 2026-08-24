import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const required = [
  "docs/SPEC.md",
  "docs/IMPLEMENTATION_CONTRACTS.md",
  "docs/MILESTONE_1.md",
  "docs/MILESTONE_10.md",
  "docs/MILESTONE_12.md",
  "docs/MILESTONE_3.md",
  "docs/MILESTONE_4.md",
  "docs/MILESTONE_5.md",
  "docs/MILESTONE_6.md",
  "docs/MILESTONE_7.md",
  "docs/MILESTONE_8.md",
  "docs/MILESTONE_9.md",
  "database/migrations/0001_initial.sql",
  "database/migrations/0002_owner_policies_and_indexes.sql",
  "database/migrations/0007_job_intelligence.sql",
  "database/migrations/0008_separate_discovery_from_history.sql",
  "database/migrations/0009_index_bootstrap_claim_owner.sql",
  "database/migrations/0010_application_creation_and_auto_prepare.sql",
  "database/migrations/0011_application_creation_idempotency_fix.sql",
  "database/migrations/0012_cv_engine_and_document_storage.sql",
  "database/migrations/0013_cv_evidence_manifest_hardening.sql",
  "database/migrations/0014_application_content_package.sql",
  "database/migrations/0015_ready_for_review_gate.sql",
  "database/migrations/0016_freeze_content_after_gate1.sql",
  "database/migrations/0017_gate1_trigger_delete_safety.sql",
  "database/migrations/0018_gmail_monitoring.sql",
  "database/migrations/0019_gmail_monitoring_hardening.sql",
  "database/migrations/0020_gmail_oauth_vault.sql",
  "database/migrations/0021_progression_workspaces.sql",
  "database/migrations/0022_progression_workspace_hardening.sql",
  "database/migrations/0023_progression_workspace_indexes.sql",
  "database/migrations/0024_adaptive_form_agent.sql",
  "database/migrations/0025_form_agent_privilege_boundary.sql",
  "database/migrations/0026_form_agent_rls_explicit_deny.sql",
  "database/migrations/0027_form_agent_indexes.sql",
  "packages/form-agent/index.js",
  "packages/form-agent/package.json",
  "apps/browser-agent/package.json",
  "apps/browser-agent/src/cli.mjs",
  "apps/browser-agent/src/observe.mjs",
  "apps/browser-agent/src/execute.mjs",
  "apps/browser-agent/src/launch-chrome.mjs",
  "supabase/functions/form-agent-bridge/index.ts",
  "apps/web/components/form-agent-panel.tsx",
  "apps/web/app/api/applications/[id]/form/start/route.ts",
  "apps/web/app/api/applications/[id]/form/status/route.ts",
  "apps/web/app/api/applications/[id]/form/approve/route.ts",
  "apps/web/app/api/applications/[id]/form/manual-submitted/route.ts",
  "packages/contracts/schemas/job-analysis.schema.json",
  "packages/contracts/schemas/cv-tailoring.schema.json",
  "packages/contracts/schemas/screening-answer.schema.json",
  "packages/contracts/schemas/knowledge-extraction.schema.json",
  "packages/contracts/schemas/form-agent-plan.schema.json",
  "data/knowledge/source-manifest.json",
  "data/knowledge/seed.json",
  "data/knowledge/knowledge-base.generated.json",
  "data/imports/tracker.normalized.json",
  "data/jobs/inbox.json",
  "data/applications/preparing.json",
  "data/emails/recent.json",
  "apps/web/app/page.tsx",
  "apps/web/app/layout.tsx",
  "apps/web/app/profile/page.tsx",
  "apps/web/app/jobs/page.tsx",
  "apps/web/app/jobs/[id]/page.tsx",
  "apps/web/app/applications/[id]/page.tsx",
  "apps/web/app/api/applications/create/route.ts",
  "apps/web/app/api/jobs/ingest/route.ts",
  "apps/web/components/job-ingest-form.tsx",
  "apps/web/components/application-create-button.tsx",
  "apps/web/app/login/page.tsx",
  "apps/web/app/auth/callback/route.ts",
  "apps/web/app/api/health/route.ts",
  "apps/web/lib/data/repository.ts",
  "apps/web/lib/supabase/proxy.ts",
  "apps/web/middleware.ts",
  "scripts/normalize-tracker.mjs",
  "scripts/seed-dev-data.mjs",
  "scripts/verify-production-env.mjs",
  "scripts/deploy-production.mjs",
  "scripts/verify-job-intelligence.mjs",
  "scripts/verify-application-preparation.mjs",
  "packages/job-intelligence/index.js",
  "packages/job-intelligence/package.json",
  "packages/application-preparation/index.js",
  "packages/application-preparation/package.json",
  "packages/cv-engine/index.js",
  "packages/cv-engine/package.json",
  "packages/application-content/index.js",
  "packages/application-content/package.json",
  "data/cv/base-families.json",
  "apps/web/app/api/applications/[id]/cv/prepare/route.ts",
  "apps/web/app/api/documents/[versionId]/download/route.ts",
  "apps/web/components/prepare-cv-button.tsx",
  "apps/web/components/prepare-content-button.tsx",
  "apps/web/app/api/applications/[id]/content/prepare/route.ts",
  "scripts/verify-application-content.mjs",
  "scripts/verify-review-center.mjs",
  "scripts/verify-email-intelligence.mjs",
  "packages/review-center/index.js",
  "packages/review-center/package.json",
  "packages/email-intelligence/index.js",
  "apps/web/components/review-center.tsx",
  "apps/web/app/api/applications/[id]/review/action/route.ts",
  "apps/web/app/api/gmail/sync/route.ts",
  "apps/web/app/email-review/[id]/page.tsx",
  "apps/web/components/gmail-sync.tsx",
  "packages/progression-prep/index.js",
  "packages/progression-prep/package.json",
  "data/progression/workflows.json",
  "apps/web/app/assessments/[id]/page.tsx",
  "apps/web/app/interviews/[id]/page.tsx",
  "apps/web/app/api/progression/prepare/route.ts",
  "apps/web/components/progression-prepare-button.tsx",
  "scripts/verify-progression-prep.mjs",
];
let failed = false;

function fail(message) {
  console.error(message);
  failed = true;
}

for (const rel of required) {
  if (!fs.existsSync(path.resolve(rel))) fail(`Missing required file: ${rel}`);
}
for (const rel of required.filter((x) => x.endsWith(".json"))) {
  try { JSON.parse(fs.readFileSync(path.resolve(rel), "utf8")); }
  catch (err) { fail(`Invalid JSON ${rel}: ${err.message}`); }
}


const spec = fs.readFileSync("docs/SPEC.md", "utf8");
if (!spec.includes("website-agnostic")) fail("Adaptive browser-agent requirement missing from product specification");
if (!spec.includes("re-observe")) fail("Adaptive browser-agent re-observation loop missing from product specification");
if (/automatic Workday\/Greenhouse\/Lever\/SmartRecruiters form completion/.test(spec)) fail("Provider-specific browser automation remains in product specification");

const sql1 = fs.readFileSync("database/migrations/0001_initial.sql", "utf8");
const sql2 = fs.readFileSync("database/migrations/0002_owner_policies_and_indexes.sql", "utf8");

for (const forbidden of ["('ready_for_review','submitted')", "('content_approved','submitted')", "('final_review','submitted')"]) {
  if (sql1.includes(forbidden)) fail(`Unsafe state transition found: ${forbidden}`);
}
if (!sql1.includes("('approved_for_submission','submitted')")) fail("Missing explicit approved_for_submission -> submitted transition");
if (!sql1.includes("Submitted document version is immutable")) fail("Missing document immutability trigger");

for (const policy of [
  "candidate_facts_owner",
  "evidence_sources_owner",
  "evidence_items_owner",
  "candidate_preferences_owner",
  "reusable_answers_owner",
  "job_snapshots_owner",
  "job_requirements_owner",
  "job_analyses_owner",
  "application_strategies_owner",
  "application_answers_owner",
  "documents_owner",
  "document_versions_owner",
  "document_evidence_links_owner",
  "application_email_links_owner",
  "assessments_owner",
  "interviews_owner",
]) {
  if (!sql2.includes(`policy ${policy}`)) fail(`Missing Milestone 1 RLS policy: ${policy}`);
}
if (!sql2.includes("applications_user_tracker_row_unique")) fail("Missing idempotent tracker import index");

const tracker = JSON.parse(fs.readFileSync("data/imports/tracker.normalized.json", "utf8"));
if (tracker.summary.total !== tracker.records.length) fail("Tracker summary total does not match record count");
if (tracker.summary.assessments < 1) fail("Tracker snapshot should contain the current assessment");
if (!tracker.records.some((row) => row.company === "Rolls-Royce" && row.applicationState === "assessment")) {
  fail("Rolls-Royce assessment state missing from tracker snapshot");
}
if (tracker.records.some((row) => row.notes === "#VALUE!")) fail("Tracker formula error was not normalised");

const knowledge = JSON.parse(fs.readFileSync("data/knowledge/knowledge-base.generated.json", "utf8"));
if (!knowledge.profile?.display_name) fail("Knowledge base display name missing");
if (!Array.isArray(knowledge.evidence) || knowledge.evidence.length < 10) fail("Knowledge base evidence seed is unexpectedly small");
if (knowledge.evidence.some((item) => !item.evidence_key || !item.source_key || !item.claim)) fail("Evidence provenance fields missing");


const sql7 = fs.readFileSync("database/migrations/0007_job_intelligence.sql", "utf8");
if (!sql7.includes("jobs_user_dedupe_key_unique")) fail("Missing per-user job deduplication index");
if (!sql7.includes("analysis_source")) fail("Job analysis provenance column missing");
if (!sql7.includes("analysis_id uuid references public.job_analyses")) fail("Requirements are not version-linked to analyses");
const sql8 = fs.readFileSync("database/migrations/0008_separate_discovery_from_history.sql", "utf8");
if (!sql8.includes("historical_tracker")) fail("Historical application jobs are not separated from discovery jobs");

const milestone3 = fs.readFileSync("docs/MILESTONE_3.md", "utf8");
if (!milestone3.includes("deterministic_v1")) fail("Milestone 3 does not preserve deterministic analysis provenance");
if (!milestone3.includes("Motorsport CV")) fail("Motorsport CV family guard missing from Milestone 3 documentation");

const jobEngine = fs.readFileSync("packages/job-intelligence/index.js", "utf8");
if (!jobEngine.includes("explicitMotorsport")) fail("Motorsport family guard missing from job engine");
if (!jobEngine.includes("eligibilityState")) fail("Eligibility gate missing from job engine");
if (!jobEngine.includes("PRIORITY_WEIGHTS")) fail("Priority scoring arithmetic missing from job engine");

const jobsInbox = JSON.parse(fs.readFileSync("data/jobs/inbox.json", "utf8"));
if (!Array.isArray(jobsInbox.records)) fail("Local job inbox is invalid");


const sql10 = fs.readFileSync("database/migrations/0010_application_creation_and_auto_prepare.sql", "utf8");
if (!sql10.includes("create_application_from_job")) fail("Missing transactional Job → Application RPC");
if (!sql10.includes("security invoker")) fail("Application creation RPC/guards must remain RLS-bound via SECURITY INVOKER");
if (!sql10.includes("Job is not eligible for automatic preparation")) fail("Database does not independently enforce the Auto-prepare gate");
if (!sql10.includes("Application job snapshot is frozen")) fail("Frozen vacancy context trigger missing");
if (!sql10.includes("prepare_cv") || !sql10.includes("prepare_screening_answers") || !sql10.includes("assemble_review_package")) fail("Application preparation task queue is incomplete");
if (sql10.includes("submit_application")) fail("Milestone 4 must not create a submission task");

const sql11 = fs.readFileSync("database/migrations/0011_application_creation_idempotency_fix.sql", "utf8");
if (!sql11.includes("A repeated create call is deliberately a strict no-op")) fail("Repeat Application creation is not a strict idempotent no-op");
if (!sql11.includes("'created',false")) fail("Application creation RPC does not report existing records idempotently");

const milestone4 = fs.readFileSync("docs/MILESTONE_4.md", "utf8");
if (!milestone4.includes("chatgpt_plus_handoff")) fail("Milestone 4 must preserve the zero-extra-cost ChatGPT Plus handoff path");
if (!milestone4.includes("preparing\n→ ready_for_review")) fail("Milestone 4 documentation does not preserve approval-gate state order");

const applicationEngine = fs.readFileSync("packages/application-preparation/index.js", "utf8");
if (!applicationEngine.includes('origin === "auto_prepare"')) fail("Application engine does not distinguish Auto-prepare from manual creation");
if (!applicationEngine.includes('triage === "reject"')) fail("Application engine does not block rejected jobs");
if (!applicationEngine.includes('executionMode: "chatgpt_plus_handoff"')) fail("Application content tasks are not routed through the no-paid-API handoff");
if (applicationEngine.includes("submit_application")) fail("Application engine contains an unsafe submission task");

const jobIngestRoute = fs.readFileSync("apps/web/app/api/jobs/ingest/route.ts", "utf8");
if (!jobIngestRoute.includes('createApplicationFromJob(result.id, "auto_prepare")')) fail("Auto-prepare is not connected to job ingestion");
const applicationCreateRoute = fs.readFileSync("apps/web/app/api/applications/create/route.ts", "utf8");
if (!applicationCreateRoute.includes("createApplicationFromJob")) fail("Manual Job → Application endpoint is missing");

const localApplications = JSON.parse(fs.readFileSync("data/applications/preparing.json", "utf8"));
if (!Array.isArray(localApplications.records)) fail("Local preparation application dataset is invalid");



const sql12 = fs.readFileSync("database/migrations/0012_cv_engine_and_document_storage.sql", "utf8");
if (!sql12.includes("create_cv_document_version")) fail("Missing evidence-backed CV version RPC");
if (!sql12.includes("application-documents")) fail("Private application-document bucket contract missing");
if (!sql12.includes("CV contains unsupported")) fail("Database CV unsupported-claim guard missing");
if (!sql12.includes("Submitted document evidence links are immutable")) fail("Submitted evidence-link immutability guard missing");
if (!sql12.includes("verification_status='verified'")) fail("Persistent CV evidence is not restricted to verified evidence");

const milestone5 = fs.readFileSync("docs/MILESTONE_5.md", "utf8");
if (!milestone5.includes("deterministic_v1")) fail("Milestone 5 zero-extra-cost deterministic CV engine is undocumented");
if (!milestone5.includes("unsupported_claims_count = 0")) fail("Milestone 5 unsupported-claim target missing");

const cvBase = JSON.parse(fs.readFileSync("data/cv/base-families.json", "utf8"));
for (const family of ["simulation_cae","scientific_software","quantitative_data","motorsport"]) {
  if (!cvBase.families?.[family]) fail(`Missing structured base CV family ${family}`);
}
const cvEngine = fs.readFileSync("packages/cv-engine/index.js", "utf8");
if (!cvEngine.includes("auditCvEvidence")) fail("CV evidence auditor missing");
if (!cvEngine.includes("renderCvLatex")) fail("CV LaTeX renderer missing");
if (!cvEngine.includes("unsupported_claims")) fail("CV engine does not expose unsupported-claim results");


const sql14 = fs.readFileSync("database/migrations/0014_application_content_package.sql", "utf8");
if (!sql14.includes("application_salary_contexts")) fail("Milestone 6 salary-context table missing");
if (!sql14.includes("save_application_content_package")) fail("Milestone 6 persistent package RPC missing");
if (!sql14.includes("Verified screening answer") || !sql14.includes("user_required")) fail("Milestone 6 Green/Red database trust guards missing");
if (!sql14.includes("Cover letter references unverified or foreign evidence")) fail("Cover-letter evidence ownership guard missing");
if (!sql14.includes("security invoker")) fail("Milestone 6 write path must remain SECURITY INVOKER");

const milestone6 = fs.readFileSync("docs/MILESTONE_6.md", "utf8");
if (!milestone6.includes("deterministic_v1")) fail("Milestone 6 zero-extra-cost engine is undocumented");
if (!milestone6.includes("Green") || !milestone6.includes("Amber") || !milestone6.includes("Red")) fail("Milestone 6 trust policy is undocumented");
const contentEngine = fs.readFileSync("packages/application-content/index.js", "utf8");
if (!contentEngine.includes("buildSalaryContext")) fail("Salary-context engine missing");
if (!contentEngine.includes("generateCoverLetter")) fail("Cover-letter engine missing");
if (!contentEngine.includes("buildScreeningPackage")) fail("Screening-answer engine missing");
if (!contentEngine.includes('work_authorisation.uk')) fail("Work-authorisation questions are not explicitly protected as user-only when unverified");

const webPackage = JSON.parse(fs.readFileSync("apps/web/package.json", "utf8"));
if (!webPackage.dependencies?.["@supabase/ssr"]) fail("@supabase/ssr dependency missing");
if (!webPackage.dependencies?.["@supabase/supabase-js"]) fail("@supabase/supabase-js dependency missing");
if (!webPackage.dependencies?.["@jobhunt/job-intelligence"]) fail("Job intelligence workspace dependency missing");
if (!webPackage.dependencies?.["@jobhunt/application-preparation"]) fail("Application preparation workspace dependency missing");
if (!webPackage.dependencies?.["@jobhunt/cv-engine"]) fail("CV engine workspace dependency missing");
if (!webPackage.dependencies?.["@jobhunt/application-content"]) fail("Application content workspace dependency missing");


const sql15 = fs.readFileSync("database/migrations/0015_ready_for_review_gate.sql", "utf8");
if (!sql15.includes("application_review_packages")) fail("Milestone 7 review package table missing");
if (!sql15.includes("assemble_application_review_package")) fail("Milestone 7 Ready for Review assembler missing");
if (!sql15.includes("approve_application_content")) fail("Milestone 7 Gate 1 approval RPC missing");
if (!sql15.includes("Reserved approval-gate state")) fail("Generic transition RPC can bypass review gates");
if (!sql15.includes("Selected CV version is not approved")) fail("Gate 1 does not independently require CV approval");
if (!sql15.includes("Salary expectation has not been approved")) fail("Gate 1 does not independently require salary approval");
if (!sql15.includes("user_required")) fail("Gate 1 does not independently protect Red answers");
const sql16 = fs.readFileSync("database/migrations/0016_freeze_content_after_gate1.sql", "utf8");
if (!sql16.includes("content is frozen after Approval Gate 1")) fail("Gate 1 does not freeze subsequent content mutation");
const milestone7 = fs.readFileSync("docs/MILESTONE_7.md", "utf8");
if (!milestone7.includes("Ready for Review") || !milestone7.includes("Gate 1")) fail("Milestone 7 review workflow is undocumented");
const reviewEngine = fs.readFileSync("packages/review-center/index.js", "utf8");
if (!reviewEngine.includes("proposedAnswersApproved") || !reviewEngine.includes("userRequiredApproved")) fail("Review checklist does not distinguish Amber/Red approvals");
if (!webPackage.dependencies?.["@jobhunt/review-center"]) fail("Review-centre workspace dependency missing");
if (!webPackage.dependencies?.["@jobhunt/progression-prep"]) fail("Progression-prep workspace dependency missing");

const appText = fs.readFileSync("apps/web/app/page.tsx", "utf8") + fs.readFileSync("apps/web/app/applications/page.tsx", "utf8");
if (appText.includes("mock-data")) fail("UI still imports Milestone 0 mock data");

for (const rel of ["scripts/normalize-tracker.mjs", "scripts/seed-dev-data.mjs", "scripts/verify-job-intelligence.mjs", "scripts/verify-application-preparation.mjs", "packages/knowledge/src/bootstrap.mjs", "packages/knowledge/src/extract-with-openai.mjs", "packages/job-intelligence/index.js", "packages/application-preparation/index.js", "packages/cv-engine/index.js", "scripts/verify-cv-engine.mjs", "packages/application-content/index.js", "scripts/verify-application-content.mjs", "packages/review-center/index.js", "scripts/verify-review-center.mjs"]) {
  try {
    execFileSync(process.execPath, ["--check", rel], { stdio: "pipe" });
  } catch (err) {
    fail(`JavaScript syntax check failed for ${rel}: ${err.stderr?.toString() || err.message}`);
  }
}



const sql21 = fs.readFileSync("database/migrations/0021_progression_workspaces.sql", "utf8");
if (!sql21.includes("application_submission_contexts")) fail("Milestone 9 immutable submission-context table missing");
if (!sql21.includes("Submitted application context is immutable")) fail("Milestone 9 submission-context immutability trigger missing");
if (!sql21.includes("workflow_preparation_versions")) fail("Milestone 9 versioned progression-preparation table missing");
if (!sql21.includes("practice_only")) fail("Milestone 9 practice-only assessment guard missing");
if (!sql21.includes("Live assessment answer/submission content is prohibited")) fail("Milestone 9 live-assessment boundary missing from database contract");
const sql22 = fs.readFileSync("database/migrations/0022_progression_workspace_hardening.sql", "utf8");
if (!sql22.includes("workflow_preparation_no_live_assessment_fields")) fail("Milestone 9 direct-write assessment safety constraint missing");
if (!sql22.includes("Progression preparation versions are immutable")) fail("Milestone 9 preparation-version immutability guard missing");
const milestone9 = fs.readFileSync("docs/MILESTONE_9.md", "utf8");
if (!milestone9.includes("exact_submitted") || !milestone9.includes("best_available")) fail("Milestone 9 context-quality labels missing");
if (!milestone9.includes("practice_only")) fail("Milestone 9 practice-only policy missing");
const progressionFixture = JSON.parse(fs.readFileSync("data/progression/workflows.json", "utf8"));
if (!progressionFixture.assessments.some((row) => row.company === "Rolls-Royce" && row.provider === "AON MapTQ")) fail("Milestone 9 real assessment fixture missing");
if (JSON.stringify(progressionFixture).includes("accesscode=")) fail("Assessment access token/link must not be stored in fixture data");

const cvHardening = fs.readFileSync("database/migrations/0013_cv_evidence_manifest_hardening.sql", "utf8");
if (!cvHardening.includes("verification_status = 'verified'")) throw new Error("CV hardening must verify evidence ownership/status");
if (!cvHardening.includes("CV evidence manifest is incomplete")) throw new Error("CV hardening must enforce the evidence-link manifest");
// Milestone 8 Gmail contract
const sql18 = fs.readFileSync("database/migrations/0018_gmail_monitoring.sql", "utf8");
const sql19 = fs.readFileSync("database/migrations/0019_gmail_monitoring_hardening.sql", "utf8");
if (!sql18.includes("process_application_email")) fail("Missing canonical Gmail processing RPC");
if (!sql18.includes("resolve_application_email")) fail("Missing Gmail Needs You resolution RPC");
if (!sql18.includes("gmail_sync_state")) fail("Missing Gmail sync-state persistence");
if (!sql18.includes("security invoker")) fail("Gmail RPCs must remain SECURITY INVOKER");
if (!sql18.includes("provider_message_id")) fail("Gmail ingestion must preserve provider message IDs");
if (!sql19.includes("values(v_user,'user',v_user::text,'email.processed'")) fail("Gmail automated audit writes must satisfy authenticated audit RLS");
if (!sql19.includes("if p_classification='assessment' then")) fail("Manual Gmail review must reconcile assessment records");
if (!sql19.includes("elsif p_classification='interview' then")) fail("Manual Gmail review must reconcile interview records");
const sql20 = fs.readFileSync("database/migrations/0020_gmail_oauth_vault.sql", "utf8");
if (!sql20.includes("vault.create_secret")) fail("Gmail refresh credentials must be stored in Supabase Vault");
if (!sql20.includes("security invoker")) fail("Public Gmail credential wrappers must remain SECURITY INVOKER");
const callback = fs.readFileSync("apps/web/app/auth/callback/route.ts", "utf8");
if (!callback.includes("provider_refresh_token") || !callback.includes("store_gmail_refresh_token")) fail("OAuth callback must capture the Google refresh token server-side");
const gmailSync = fs.readFileSync("apps/web/lib/gmail-sync.ts", "utf8");
if (!gmailSync.includes("get_gmail_refresh_token") || !gmailSync.includes("refreshGoogleAccessToken")) fail("Gmail sync must refresh expired provider access tokens server-side");
const gmailApi = fs.readFileSync("apps/web/lib/gmail-api.ts", "utf8");
if (!gmailApi.includes("GMAIL_SYNC_MAX_MESSAGES = 15") || !gmailSync.includes("GMAIL_SYNC_MAX_MESSAGES")) fail("Gmail sync must keep per-invocation provider and database fan-out bounded");
const signIn = fs.readFileSync("apps/web/components/sign-in-button.tsx", "utf8");
if (!signIn.includes("gmail.readonly")) fail("Google sign-in does not request Gmail read-only scope");
if (/gmail\.modify|gmail\.send|mail\.google\.com/.test(signIn)) fail("Gmail OAuth scope is broader than read-only");
const emailFixture = JSON.parse(fs.readFileSync("data/emails/recent.json", "utf8"));
if (!Array.isArray(emailFixture.records) || emailFixture.records.length < 5) fail("Email verification fixture is unexpectedly small");


// Milestone 10 adaptive form-agent contract
const sql24 = fs.readFileSync("database/migrations/0024_adaptive_form_agent.sql", "utf8");
if (!sql24.includes("start_form_agent_session")) fail("Milestone 10 form-session entrypoint missing");
if (!sql24.includes("approve_form_agent_final_review")) fail("Milestone 10 Approval Gate 2 RPC missing");
if (!sql24.includes("lock_application_submission_context")) fail("Milestone 10 exact submitted-context lock missing");
if (!sql24.includes("form_agent_service_transition")) fail("Milestone 10 service-only form transition RPC missing");
if (!sql24.includes("'submitted') then") && !sql24.includes("'submitted')")) fail("Milestone 10 submitted state reservation missing");
if (!sql24.includes("Target state % is reserved for its validated workflow")) fail("Generic state transition can bypass Milestone 10 gate");
const sql25 = fs.readFileSync("database/migrations/0025_form_agent_privilege_boundary.sql", "utf8");
if (!sql25.includes("private.start_form_agent_session_for_user")) fail("Milestone 10 private session helper missing");
if (!sql25.includes("security invoker")) fail("Milestone 10 public wrappers must remain SECURITY INVOKER");
const sql26 = fs.readFileSync("database/migrations/0026_form_agent_rls_explicit_deny.sql", "utf8");
if (!sql26.includes("using (false)") || !sql26.includes("with check (false)")) fail("Milestone 10 direct authenticated table access must be explicitly denied");
const sql27 = fs.readFileSync("database/migrations/0027_form_agent_indexes.sql", "utf8");
if (!sql27.includes("form_agent_sessions_application_idx") || !sql27.includes("form_agent_sessions_final_observation_idx")) fail("Milestone 10 form-session foreign-key indexes missing");
const formAgent = fs.readFileSync("packages/form-agent/index.js", "utf8");
if (!formAgent.includes("planAdaptivePage")) fail("Generic adaptive page planner missing");
if (!formAgent.includes("isDangerousSubmissionLabel")) fail("Final-submission detector missing");
if (!formAgent.includes("Sensitive or user-only field is never inferred")) fail("User-only browser field guard missing");
const browserCli = fs.readFileSync("apps/browser-agent/src/cli.mjs", "utf8");
if (!browserCli.includes("connectOverCDP")) fail("Local Chrome CDP companion missing");
const chromeLauncher = fs.readFileSync("apps/browser-agent/src/launch-chrome.mjs", "utf8");
if (!chromeLauncher.includes("--user-data-dir=") || !chromeLauncher.includes(".job-hunt")) fail("Modern Chrome dedicated-profile launcher missing");
if (!browserCli.includes("executeApprovedSubmission")) fail("Gate 2 helper submission path missing");
if (!browserCli.includes("observePage(page)")) fail("Browser helper does not re-observe page state");
if (!browserCli.includes("[\"approved_for_submission\",\"submitting\"]")) fail("Browser helper must recognize post-click submission confirmation");
const bridge = fs.readFileSync("supabase/functions/form-agent-bridge/index.ts", "utf8");
if (!bridge.includes("x-form-agent-token") || !bridge.includes("sha256")) fail("Scoped form-agent bridge authentication missing");
if (!bridge.includes("sanitizeObservation")) fail("Form observations are not sanitized before persistence");
const m10 = fs.readFileSync("docs/MILESTONE_10.md", "utf8");
if (!m10.includes("one action per observation cycle")) fail("Milestone 10 re-observation execution rule is undocumented");
if (!m10.includes("Approve & submit with helper")) fail("Milestone 10 Gate 2 UX missing");

// Milestone 11 productionisation contract
const productionRunbook = fs.readFileSync("docs/PRODUCTION_RUNBOOK.md", "utf8");
const atsAcceptance = fs.readFileSync("docs/ATS_ACCEPTANCE.md", "utf8");
const middleware11 = fs.readFileSync("apps/web/middleware.ts", "utf8");
const browserCli11 = fs.readFileSync("apps/browser-agent/src/cli.mjs", "utf8");
if (!productionRunbook.includes("Cloudflare Workers")) fail("Milestone 11 hosting target missing");
if (!atsAcceptance.includes("Do not submit")) fail("Milestone 11 no-submit acceptance protocol missing");
if (!middleware11.includes("updateSession")) fail("Milestone 11 Cloudflare-compatible auth middleware missing");
if (!browserCli11.includes("Acceptance/no-submit mode")) fail("Milestone 11 browser no-submit enforcement missing");

// Milestone 12 production deployment contract
const milestone12 = fs.readFileSync("docs/MILESTONE_12.md", "utf8");
const deployProduction = fs.readFileSync("scripts/deploy-production.mjs", "utf8");
const productionEnvVerifier = fs.readFileSync("scripts/verify-production-env.mjs", "utf8");
const health12 = fs.readFileSync("apps/web/app/api/health/route.ts", "utf8");
const wrangler12 = fs.readFileSync("apps/web/wrangler.jsonc", "utf8");
if (!milestone12.includes("workers.dev")) fail("Milestone 12 free hosted URL strategy missing");
if (!deployProduction.includes("verify-production-env.mjs")) fail("Milestone 12 canonical deploy does not enforce environment validation");
if (!productionEnvVerifier.includes("JOBHUNT_DATA_MODE") || !productionEnvVerifier.includes("supabase")) fail("Milestone 12 production data-mode guard missing");
if (!health12.includes("supabaseReachable")) fail("Milestone 12 hosted health check does not verify Supabase reachability");
if (!wrangler12.includes('"workers_dev": true')) fail("Milestone 12 free workers.dev route is not explicit");

// Milestone 14 paired local browser-helper commissioning
const sql30 = fs.readFileSync("database/migrations/0030_browser_helper_commissioning.sql", "utf8");
if (!sql30.includes("browser_agent_devices") || !sql30.includes("browser_agent_pairing_codes")) fail("Milestone 14 browser-helper device/pairing schema missing");
if (!sql30.includes("start_form_agent_session_for_device")) fail("Milestone 14 device-bound form-session RPC missing");
if (!sql30.includes("resume_form_agent_session")) fail("Milestone 14 background resume RPC missing");
const helperDaemon = fs.readFileSync("apps/browser-agent/src/daemon.mjs", "utf8");
if (!helperDaemon.includes("device_poll") || !helperDaemon.includes("JOBHUNT_DAEMON_MODE")) fail("Milestone 14 auto-start helper daemon missing");
const helperKeychain = fs.readFileSync("apps/browser-agent/src/keychain.mjs", "utf8");
if (!helperKeychain.includes("/usr/bin/security") || helperKeychain.includes('"-w", token')) fail("Milestone 14 Keychain credential handling is unsafe or missing");
const milestone14 = fs.readFileSync("docs/MILESTONE_14.md", "utf8");
if (!milestone14.includes("one-time") || !milestone14.includes("Keychain") || !milestone14.includes("LaunchAgent")) fail("Milestone 14 commissioning workflow is undocumented");

// Milestone 15 real ATS acceptance and V1 launch qualification
const sql31 = fs.readFileSync("database/migrations/0031_ats_acceptance_and_launch_status.sql", "utf8");
if (!sql31.includes("ats_acceptance_runs") || !sql31.includes("submit_clicked = false")) fail("Milestone 15 immutable no-submit acceptance evidence missing");
if (!sql31.includes("block_acceptance_session_submission")) fail("Milestone 15 database no-submit transition guard missing");
if (!sql31.includes("start_form_agent_acceptance_session_for_device")) fail("Milestone 15 device acceptance-session RPC missing");
if (!sql31.includes("get_v1_launch_status")) fail("Milestone 15 launch-status RPC missing");
const m15 = fs.readFileSync("docs/MILESTONE_15.md", "utf8");
if (!m15.includes("Source-backed browser acceptance") || !m15.includes("Live acceptance mode")) fail("Milestone 15 evidence-level distinction is undocumented");
const acceptanceCorpus = JSON.parse(fs.readFileSync("data/acceptance/live-source-fixtures.json", "utf8"));
if (!Array.isArray(acceptanceCorpus.cases) || acceptanceCorpus.cases.length < 6) fail("Milestone 15 provider-diverse acceptance corpus is incomplete");
const observer15 = fs.readFileSync("apps/browser-agent/src/observe.mjs", "utf8");
const executor15 = fs.readFileSync("apps/browser-agent/src/execute.mjs", "utf8");
const providerSpecific = /\b(workday|greenhouse|lever|ashby|smartrecruiters|successfactors)\b/i;
if (providerSpecific.test(formAgent) || providerSpecific.test(observer15) || providerSpecific.test(executor15)) fail("Provider-specific ATS logic leaked into production form automation");
if (!browserCli.includes('bridge.call(\"acceptance_result\"') || !browserCli.includes("Acceptance/no-submit mode")) fail("Milestone 15 helper does not persist no-submit final-review acceptance");
if (!helperDaemon.includes('childArgs.push(\"--no-submit\")')) fail("Paired helper does not enforce no-submit acceptance mode");

if (failed) process.exit(1);
console.log("Repository contract verification passed.");
