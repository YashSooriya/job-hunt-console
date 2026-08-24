import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error("M20 verification failed: " + message);
};

const migration = read("database/migrations/0041_m20_guided_activation.sql") + read("database/migrations/0042_m20_proposal_fk_index.sql");
const parser = read("apps/web/lib/onboarding/document-parser.ts");
const importer = read("apps/web/app/api/onboarding/import-cv/route.ts");
const review = read("apps/web/app/api/onboarding/review/route.ts");
const preferences = read("apps/web/app/api/onboarding/preferences/route.ts");
const workspace = read("apps/web/components/onboarding-workspace.tsx");

must(migration.includes("candidate_extraction_proposals"), "extraction proposal table missing");
must(migration.includes("enable row level security") && migration.includes("private.owns_profile(profile_id)"), "extraction proposals are not tenant-protected");
must(migration.includes("extraction_format") && migration.includes("extraction_error"), "source extraction diagnostics missing");
must(migration.includes("gmail_connected") && migration.includes("chatgpt_connected") && migration.includes("browser_helper_paired"), "activation readiness does not include service connections");
must(migration.includes("complete_candidate_onboarding") && migration.includes("Finish the activation checklist"), "database completion gate missing");
must(migration.includes("candidate_extraction_proposals_materialized_evidence_idx"), "proposal foreign-key index missing");
for (const format of ["pdf", "docx", "markdown", "txt", "rtf"]) must(parser.includes(`=== "${format}"`) || parser.includes(`=== \"${format}\"`) || parser.includes(`format === "${format}"`), "parser missing " + format);
must(parser.includes("unzipSync") && parser.includes("unzlibSync"), "Worker-compatible DOCX/PDF extraction missing");
must(importer.includes("extractDocumentText") && importer.includes("candidate_extraction_proposals"), "upload route does not parse and persist amber proposals");
must(!importer.includes("extractedText"), "upload route still requires pasted text");
must(review.includes('body.kind === "proposal"') && review.includes('verification_status: "verified"'), "proposal review/materialization missing");
for (const key of ["role_families", "target_seniority", "preferred_industries", "excluded_industries", "auto_prepare_threshold", "search_cadence", "application_automation_preference"]) must(preferences.includes(key), "preference field missing: " + key);
for (const label of ["Gmail read-only", "ChatGPT reasoning worker", "Browser helper", "Automation-ready"]) must(workspace.includes(label), "activation UI missing: " + label);

console.log("Milestone 20 guided activation contracts passed.");
