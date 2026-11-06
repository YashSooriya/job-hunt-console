import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error("M20 verification failed: " + message);
};

const migration = read("database/migrations/0041_m20_guided_activation.sql") + read("database/migrations/0042_m20_proposal_fk_index.sql") + read("database/migrations/0051_detailed_profile_ingestion_and_chatgpt_project.sql") + read("database/migrations/0052_chatgpt_memory_preferences.sql");
const activation = read("database/migrations/0076_onboarding_activation_without_external_gates.sql");
const activationSecurity = read("database/migrations/0078_onboarding_activation_security_definer.sql");
const parser = read("apps/web/lib/onboarding/document-parser.ts");
const importer = read("apps/web/app/api/onboarding/import-cv/route.ts") + read("apps/web/lib/onboarding/import-source.ts");
const review = read("apps/web/app/api/onboarding/review/route.ts");
const preferences = read("apps/web/app/api/onboarding/preferences/route.ts");
const workspace = read("apps/web/components/onboarding-workspace.tsx");
const settings = read("apps/web/app/settings/page.tsx") + read("apps/web/components/browser-helper-settings.tsx");
const memory = read("apps/web/components/chatgpt-memory-reminder.tsx") + read("apps/web/app/api/chatgpt/memory/route.ts");

must(migration.includes("candidate_extraction_proposals"), "extraction proposal table missing");
must(migration.includes("enable row level security") && migration.includes("private.owns_profile(profile_id)"), "extraction proposals are not tenant-protected");
must(migration.includes("extraction_format") && migration.includes("extraction_error"), "source extraction diagnostics missing");
must(activation.includes("activation_ready") && activation.includes("profile_complete") && activation.includes("external_connections_required"), "editable onboarding activation contract missing");
must(activation.includes("complete_candidate_onboarding") && activation.includes("Complete the editable profile and job-search preferences before activation"), "database completion gate missing");
must(!activation.includes("v_score=100") && !activation.includes("gmail_connected") && !activation.includes("browser_helper_paired"), "external service connections still gate activation");
must(activationSecurity.includes("assert_current_user_active_app_membership") && activationSecurity.includes("security invoker"), "activation membership boundary is not self-scoped");
must(migration.includes("candidate_extraction_proposals_materialized_evidence_idx"), "proposal foreign-key index missing");
must(migration.includes("candidate_chatgpt_memory") && migration.includes("chatgpt_memory_confirmed"), "ChatGPT Memory activation gate missing");
must(memory.includes("settings") && memory.includes("confirm_enabled"), "ChatGPT Memory reminder/confirmation flow missing");
for (const format of ["pdf", "docx", "markdown", "txt", "rtf"]) must(parser.includes(`=== "${format}"`) || parser.includes(`=== \"${format}\"`) || parser.includes(`format === "${format}"`), "parser missing " + format);
must(parser.includes("unzipSync") && parser.includes("unzlibSync"), "Worker-compatible DOCX/PDF extraction missing");
must(importer.includes("candidate_source_documents") && importer.includes("storage_object_key") && importer.includes("extractDocumentText(bytes, fileName, mimeType)") && importer.includes("extractSourceProposals") && importer.includes("parseStructuredResponse = replaceExisting || sourceType === \"chatgpt_memory\""), "source route does not privately extract files before explicit review");
must(review.includes('body.kind === "proposal"') && review.includes('verification_status: "verified"') && review.includes("materializeStructuredRecord"), "proposal review/materialization missing");
must(migration.includes("source_type") && migration.includes("materialized_entity_id"), "detailed source provenance columns missing");
for (const key of ["role_families", "target_seniority", "preferred_industries", "excluded_industries", "auto_prepare_threshold", "search_cadence", "application_automation_preference"]) must(preferences.includes(key), "preference field missing: " + key);
must(workspace.includes("Review imported profile") && workspace.includes("Check extracted information") && !workspace.includes("Connections and approved answers") && !workspace.includes("<h2>Approved answers"), "onboarding does not expose its per-item review flow or still contains the removed connection panel");
must(settings.includes("Browser helper") && !settings.includes("ChatGPT reasoning worker") && !settings.includes("MCP fallback"), "Settings still advertises the retired ChatGPT plugin/worker path");
must(!fs.existsSync(path.join(root, "apps/web/components/chatgpt-reasoning-worker-settings.tsx")), "retired ChatGPT reasoning-worker setup remains present");

console.log("Milestone 20 guided activation contracts passed.");
