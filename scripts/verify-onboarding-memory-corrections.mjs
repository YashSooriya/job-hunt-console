import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error(`Onboarding Memory correction verification failed: ${message}`);
};

const workspace = read("apps/web/components/onboarding-workspace.tsx");
const profileRoute = read("apps/web/app/api/onboarding/profile/route.ts");
const verifiedBackground = read("apps/web/lib/chatgpt/verified-professional-background.ts");
const prompt = read("apps/web/lib/chatgpt/professional-background.ts");
const dispatch = read("apps/web/lib/chatgpt/professional-background-dispatch.ts");
const memoryRoute = read("apps/web/app/api/onboarding/memory/route.ts");
const snapshot = read("apps/web/lib/chatgpt/profile-snapshot.ts");

must(workspace.includes("personalDetailsFormRef"), "the Memory action cannot access the personal-details form");
must(workspace.includes("savePersonalDetailsBeforeMemory"), "pending personal details are not saved before a Memory update");
must(workspace.includes("savePendingProfile"), "MemoryUpdateCard is not wired to the pending-profile save callback");
must(workspace.includes("personalDetailsPatch"), "Memory corrections do not calculate a changed-fields-only personal-details patch");
must(workspace.includes("partial: true"), "Memory corrections do not use the profile endpoint's partial-save contract");
must(!workspace.includes("form.reportValidity()"), "Memory corrections are still blocked by unrelated required personal fields");
must(workspace.includes("runUpdateAction"), "Memory submission does not have a duplicate-click guard");
must(workspace.includes("disabled={busy || chatgptOperation.blocked || updateActive}"), "the Memory button does not respect the shared ChatGPT operation lock");
must(!workspace.includes("disabled={busy || updateActive || hasUnsavedProfileChanges}"), "unsaved profile edits still silently suppress the Memory button");
must(workspace.includes("Unsaved edits") && workspace.includes("They will be saved before sending."), "the pending-save behavior is not visible to the user");

must(profileRoute.includes("displayNameChanged"), "Display Name changes are not detected");
must(profileRoute.includes("const partial = body.partial === true"), "Profile endpoint has no explicit partial-save mode");
must(profileRoute.includes("selectedFacts"), "Partial profile saves do not limit writes to supplied fields");
must(profileRoute.includes("nextDisplayName"), "Partial profile saves can overwrite the canonical display name with an empty value");
must(profileRoute.includes('fact_key: "display_name"'), "Display Name is not persisted as a profile fact");
must(profileRoute.includes(': "user_onboarding"'), "Display Name provenance is not marked as user-owned");

must(verifiedBackground.includes("factsResult.data"), "verified facts are not read for incremental updates");
must(prompt.includes('title: "Verified personal facts"'), "the professional Memory prompt has no verified-facts section");
must(prompt.includes('recordLine(fact, ["fact_key", "value_json"])'), "verified facts are not rendered into the Memory prompt");
must(dispatch.includes("instructionIdempotencyKey"), "Memory updates do not derive deterministic idempotency keys");
must(snapshot.includes("snapshotFromInput") && snapshot.includes("diffSnapshots"), "Memory updates do not compare a canonical previous profile snapshot");
must(snapshot.includes("normalise(before)") && snapshot.includes("normalise(after)"), "Snapshot comparison is vulnerable to JSON object key-order differences");
must(memoryRoute.includes("memory_update_snapshot") && memoryRoute.includes("memory_update_pending_snapshot"), "Memory update lifecycle does not persist a durable snapshot ledger");
must(memoryRoute.includes('action === "sync_confirmed_profile"') && memoryRoute.includes('action === "retry_confirmed_profile"'), "Memory update and safe retry actions are missing");
must(memoryRoute.includes("changedFields") && memoryRoute.includes('idempotencyKeyPrefix: "profile.background.confirmed:v3"'), "Correction dispatch is not limited to the exact changed fields");
must(prompt.includes("only the new or corrected profile details") && prompt.includes("all long-term Memories currently stored"), "Correction prompt does not explicitly use all stored Memories and only the delta");
must(!verifiedBackground.includes("candidate_preferences"), "Job-search preferences are still included in profile Memory updates");

console.log("Onboarding Memory correction contracts passed.");
