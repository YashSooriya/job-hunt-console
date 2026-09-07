import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(root, "database/migrations/0094_supabase_security_hardening.sql");
const migration = await readFile(migrationPath, "utf8");
const documentation = await readFile(path.join(root, "docs/SUPABASE_SECURITY.md"), "utf8");

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
assert.match(documentation, /accepted, documented exception/i, "The intentional rate-limit advisor warning is not documented.");
assert.match(documentation, /authenticated warnings for the user-facing ChatGPT wrappers are\s+also\s+intentional/i, "The authenticated advisor warnings are not documented.");
assert.match(documentation, /auth_leaked_password_protection.*must disappear/is, "The Auth advisor requirement is not documented.");
assert.match(documentation, /20260907194623_supabase_security_hardening/i, "The applied remote migration is not recorded.");
assert.match(documentation, /Free plan.*Pro-only setting/is, "The current Auth-setting blocker is not recorded.");

console.log("Supabase security hardening contract passed.");
