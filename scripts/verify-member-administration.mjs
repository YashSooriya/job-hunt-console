import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const migration = await read("database/migrations/0113_member_administration_and_account_deletion.sql");
const members = await read("apps/web/components/member-admin.tsx");
const manageRoute = await read("apps/web/app/api/members/manage/route.ts");
const deleteRoute = await read("apps/web/app/api/members/delete/route.ts");
const edge = await read("supabase/functions/member-account-delete/index.ts");
const storage = await read("supabase/functions/_shared/member-account-storage.mjs");

for (const constraint of [
  "application_answers_approved_by_fkey",
  "application_review_packages_approved_by_fkey",
  "application_salary_contexts_approved_by_fkey",
  "document_versions_approved_by_fkey",
]) {
  assert.match(migration, new RegExp(`${constraint}[\\s\\S]*?on delete set null`, "i"), `Account deletion must preserve rows referencing ${constraint}.`);
}

assert.match(migration, /create or replace function public\.manage_app_member\(p_action text, p_user_id uuid, p_role text default null\)[\s\S]*security definer[\s\S]*set search_path = ''/i);
assert.match(migration, /revoke all on function public\.manage_app_member\(text, uuid, text\) from public, anon, service_role[\s\S]*grant execute on function public\.manage_app_member\(text, uuid, text\) to authenticated/i);
assert.match(migration, /p_action in \('set_role', 'prepare_delete', 'finalize_delete'\)[\s\S]*v_actor\.role <> 'owner'/i, "Role changes and account deletion must be owner-only in the database.");
assert.match(migration, /status = 'revoked'[\s\S]*search_schedule_enabled = false[\s\S]*next_scheduled_search_at = null/i, "Revocation must pause unattended searches.");
assert.match(migration, /search_schedule_remains_paused/i, "Restore must not silently restart scheduled searches.");
assert.match(migration, /delete from vault\.secrets where id = v_secret_id/i, "Permanent deletion must remove the member's Gmail Vault secret.");
assert.match(migration, /jobhunt_candidate_sources_insert[\s\S]*private\.current_user_active_member[\s\S]*jobhunt_candidate_sources_update[\s\S]*private\.current_user_active_member/i);
assert.match(migration, /jobhunt_application_documents_insert[\s\S]*private\.current_user_active_member[\s\S]*jobhunt_application_documents_update[\s\S]*private\.current_user_active_member/i);
assert.match(migration, /alter policy jobs_owner[\s\S]*private\.current_user_active_member/i, "A revoked but unexpired JWT must no longer read/write the job pool.");

for (const feature of [
  "Restore access", "Make admin", "Make member", "Delete permanently", "Create invitation",
  "Renew 30 days", "Copy sign-in link", "Type the member&apos;s email to confirm",
]) assert.ok(members.includes(feature), `Members UI is missing ${feature}.`);
assert.match(members, /No email is sent automatically/i, "Invitation UX must not imply it sent mail.");
assert.match(members, /deleteConfirmation\.trim\(\)\.toLowerCase\(\).*member\.email\.trim\(\)\.toLowerCase\(\)/s, "Permanent deletion must require the exact target email.");
assert.match(manageRoute, /action !== "restore" && action !== "set_role"/);
assert.match(manageRoute, /UUID_PATTERN/);
assert.match(deleteRoute, /supabase\.functions\.invoke\("member-account-delete"/);
assert.doesNotMatch(await read("apps/web/app/api/members/delete/route.ts"), /SUPABASE_SERVICE_ROLE_KEY/);

const prepareAt = edge.indexOf('p_action: "prepare_delete"');
const storageAt = edge.indexOf("await deleteMemberStorageObjects");
const finalizeAt = edge.indexOf('p_action: "finalize_delete"');
const authDeleteAt = edge.indexOf("auth.admin.deleteUser");
assert.ok(prepareAt >= 0 && prepareAt < storageAt && storageAt < finalizeAt && finalizeAt < authDeleteAt, "Deletion must revoke, clean Storage, clean Vault, and only then delete Auth.");
assert.match(edge, /auth\.getUser\(token\)/, "The Edge Function must verify the caller's JWT.");
assert.match(edge, /membership\?\.role !== "owner"/, "The Edge Function must independently require an owner session.");
assert.deepEqual([...storage.matchAll(/"(?:candidate-source-documents|application-documents)"/g)].length > 0, true);
assert.match(storage, /REMOVE_BATCH_SIZE = 1000/);
assert.match(storage, /remaining\.length > 0/);

console.log("Members administration contract passed.");
