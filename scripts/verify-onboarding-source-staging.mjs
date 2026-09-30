import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error(`Onboarding source staging verification failed: ${message}`);
};

const workspace = read("apps/web/components/onboarding-workspace.tsx");
const memory = read("apps/web/components/chatgpt-memory-setup.tsx");
const memoryRoute = read("apps/web/app/api/onboarding/memory/route.ts");
const background = read("apps/web/app/api/onboarding/professional-background/route.ts");
const sources = read("apps/web/app/api/onboarding/sources/route.ts");
const importRoute = read("apps/web/app/api/onboarding/import-cv/route.ts");
const importer = read("apps/web/lib/onboarding/import-source.ts");
const state = read("apps/web/app/api/onboarding/state/route.ts");
const storagePolicy = read("database/migrations/0104_candidate_source_storage_upsert_policy.sql");

must(workspace.includes("async function stageSourceFile"), "file selection is not staged by a dedicated upload handler");
must(workspace.includes('api("/api/onboarding/import-cv"'), "source staging does not use the import endpoint");
must(workspace.includes('api("/api/onboarding/professional-background"'), "profile build endpoint is missing");
must(workspace.includes('"Save and build profile"'), "the source build CTA label is missing");
must(workspace.includes("pendingBuildAfterConsent"), "Save-before-consent does not retain a pending build intent");
must(workspace.includes("onMemoryAllowed"), "Memory consent cannot resume the pending Save action");
must(workspace.includes("savedSourceDocuments.length > 0"), "saved documents do not enable source build readiness");
must(!workspace.includes("sourceDocumentIds"), "the client still submits a partial source-document ID list");
must(!memory.includes("allow_and_import"), "Memory consent still dispatches the source bundle from the UI");
must(memory.includes('choose("allow")'), "Memory consent is not separated from source dispatch");
must(!memory.includes("onSaveSources"), "Memory consent still owns source persistence");
must(memoryRoute.includes("onboarding_client_refresh_required"), "stale Memory clients are not blocked from dispatching through the consent endpoint");
must(memoryRoute.includes("response_provenance_recorded"), "structured Memory imports are not gated on exact-turn response provenance");
must(background.includes("sourceQuery,"), "the build route does not query the canonical source set");
must(background.includes('source.source_type !== "chatgpt_memory"'), "generated ChatGPT JSON is not excluded from source input");
must(background.includes("background_focus_policy_v2"), "profile dispatch does not require the safe background-focus bridge capability");
must(sources.includes("Persist source metadata without creating a ChatGPT dispatch"), "LinkedIn staging boundary is missing");
must(!sources.includes("notifyBridgeHints"), "LinkedIn staging can notify the Website Bridge");
must(workspace.includes("savedAdditionalInformation") && importer.includes("replaceSourceType"), "Additional information is not loaded and replaced as one editable source");
must(workspace.includes("setLinkedinUrl(\"\")") && workspace.includes("setProfileText(\"\")"), "Source fields do not expose clear controls");
must(importRoute.includes("replaceSourceType") && importRoute.includes("removeAdditionalInformationSources"), "Source API does not expose replacement and clear semantics");
must(importer.includes("let extractedText: string | null = hasFile ? null : text") && importer.includes("removeAdditionalInformationSources"), "Additional information cannot be reloaded or cleared safely");
must(state.includes("additionalInformation") && state.includes('eq("source_type", "user_description")'), "Onboarding state does not return editable additional information");
must(workspace.includes("sourceFiles.length > 0 || !hasSourceInput"), "Save button is not greyed out until a source field has a value");
must(workspace.includes("expectedRevision") && background.includes("expectedBundleRevision"), "Source save/build requests do not share a concurrency revision");
must(workspace.includes("clearLinkedInSource") && workspace.includes("clearAdditionalInformation"), "Saved LinkedIn and Additional Information values cannot be removed in place");
must(memory.includes("memoryStagedText") && memory.includes("savedAdditionalInformation"), "The Memory staging preview does not show exact Additional Information text");
must(!workspace.includes("<JobSearchPreferences") && read("apps/web/app/jobs/settings/page.tsx").includes("<JobSearchPreferences"), "Job-search preferences must live in the Jobs settings page, not onboarding");
must(background.includes('source.source_type === "user_description"'), "The source build flow does not account for the editable text source");
must(storagePolicy.includes("jobhunt_candidate_sources_update")
  && storagePolicy.includes("for update")
  && storagePolicy.includes("bucket_id = 'candidate-source-documents'")
  && storagePolicy.includes("storage.foldername(name)")
  && storagePolicy.includes("with check"), "Storage upserts cannot replace an existing per-user source object safely");
const reset = read("apps/web/app/api/onboarding/reset/route.ts");
must(reset.includes("cancelMemoryDispatchesForReset"), "onboarding reset does not reconcile indexed Memory dispatches");
must(reset.includes("cancel_chatgpt_dispatch_request"), "onboarding reset has no ownership-checked dispatch cancellation");

console.log("Onboarding source staging contracts passed.");
