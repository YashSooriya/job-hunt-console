import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error("Onboarding review verification failed: " + message);
};

const importer = read("apps/web/lib/onboarding/import-source.ts");
const memoryImporter = read("apps/web/lib/onboarding/import-chatgpt-memory.ts");
const parser = read("apps/web/lib/onboarding/document-parser.ts");
const extraction = read("apps/web/lib/onboarding/extract.ts");
const state = read("apps/web/app/api/onboarding/state/route.ts");
const readiness = read("apps/web/lib/onboarding/readiness.ts");
const review = read("apps/web/app/api/onboarding/review/route.ts");
const profileRoute = read("apps/web/app/api/onboarding/profile/route.ts");
const workspace = read("apps/web/components/onboarding-workspace.tsx");
const memorySetup = read("apps/web/components/chatgpt-memory-setup.tsx");

for (const format of ["pdf", "docx", "txt", "markdown", "rtf"]) {
  must(parser.includes('format === "' + format + '"') || parser.includes('ext === "' + format + '"'), "document parser does not support " + format);
}
must(importer.includes("extractDocumentText(bytes, fileName, mimeType)"), "uploaded file text is not extracted locally");
must(importer.includes("extractSourceProposals(extractedText)") && importer.includes("candidate_extraction_proposals"), "document claims are not stored as source-linked proposals");
must(importer.includes('verification_status: "needs_review"'), "source proposals are not pending explicit review");
must(importer.includes("extractionError") && importer.includes('extractionStatus = "failed"'), "document extraction failure is not retained for recovery");
must(importer.includes("storage_object_key: objectKey"), "original private source file is not retained");
must(extraction.includes("source_locator") || extraction.includes("locator:"), "source line provenance is missing");
must(memoryImporter.includes('verification_status: "needs_review"') && !memoryImporter.includes('verification_status: "verified"'), "ChatGPT profile imports are being auto-verified");
must(memoryImporter.includes('.is("source_id", null)') && memoryImporter.includes("userOwnedSkillNames"), "ChatGPT import can overwrite user-owned skills");
must(review.includes('body.action === "verify_all"') && review.includes("Review each imported item individually."), "bulk verification is not blocked");
must(review.includes('body.kind === "proposal"') && review.includes('body.kind === "fact"'), "individual fact and proposal review paths are missing");
must(state.includes("source_title") && state.includes("fallbackReadiness"), "review cards do not receive source provenance or readiness data");
must(readiness.includes("...input.education") && readiness.includes("...input.employment") && readiness.includes("...input.skills") && readiness.includes("...input.projects") && readiness.includes("...input.publications"), "unreviewed structured records do not block profile readiness");
must(readiness.includes("external_connections_required: false") && readiness.includes("preferences_complete: true"), "external integrations or search preferences gate profile readiness");
must(workspace.includes("PendingReviewSection") && workspace.includes("Possible conflict") && workspace.includes("Add to profile") && workspace.includes("Confirm value"), "visible per-item proposal/fact review and conflict resolution are missing");
must(workspace.includes("options.partial !== false") && workspace.includes("personalDetailsPatch"), "saving personal details can confirm untouched imported facts");
must(profileRoute.includes("sameFieldValue(existing.value_json, value, factKey)"), "unchanged profile values are silently promoted during a save");
must(memorySetup.includes("Review these questions and conflicts"), "ChatGPT import questions and conflicts are not surfaced");
must(workspace.includes("does not confirm that every fact was retained in ChatGPT Memory"), "captured profile response is presented as proof of Memory retention");

console.log("Onboarding extraction, explicit review, readiness, provenance and Memory-boundary contracts passed.");
