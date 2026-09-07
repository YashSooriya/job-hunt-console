import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const migration = await read("database/migrations/0094_supabase_security_hardening.sql");
const followUpMigration = await read("database/migrations/0095_supabase_security_definer_inventory.sql");
const documentation = await read("docs/SUPABASE_SECURITY.md");
const evidence = JSON.parse(await read("docs/evidence/supabase-security-2026-09-07.json"));
const liveSql = await read("database/security/verify_supabase_security.sql");
const allowlist = JSON.parse(await read("database/security/security-definer-allowlist.json"));
const advisorAllowlist = JSON.parse(await read("database/security/security-advisor-allowlist.json"));

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

assert.match(followUpMigration, /alter function private\.owns_application\(uuid\) set search_path = ''/i, "Ownership predicates are not pinned to an empty search_path.");
assert.match(followUpMigration, /revoke execute on function private\.owns_profile\(uuid\) from public/i, "Ownership predicates still inherit PUBLIC execution.");
assert.match(followUpMigration, /alter function public\.get_automation_settings\(\) security definer/i, "The automation wrapper does not own its private call boundary.");
assert.match(followUpMigration, /alter function public\.complete_job_url_inspection\(uuid, jsonb, text, text\) security definer/i, "The job inspection wrapper does not own its private call boundary.");
assert.match(followUpMigration, /revoke execute on function private\.start_job_url_inspection_for_user\(uuid, uuid, text\) from public, anon, authenticated/i, "Arbitrary-user job inspection helper remains client-executable.");
assert.match(followUpMigration, /alter default privileges for role postgres in schema public[\s\S]*revoke execute on functions from public/i, "Future public functions do not default to closed execution.");

assert.equal(allowlist.version, 1, "Unexpected security-definer allowlist version.");
assert.deepEqual(allowlist.scope, ["public", "private", "chatgpt_internal"], "Allowlist scope drifted.");
assert.equal(allowlist.invariants.securityDefinerSearchPath, 'search_path=""', "The allowlist must require an empty SECURITY DEFINER search_path.");
assert.equal(allowlist.invariants.publicExecute, false, "SECURITY DEFINER functions must not inherit PUBLIC execution.");
for (const schema of allowlist.scope) {
  assert.ok(Number.isInteger(allowlist.inventory?.[schema]?.securityDefinerCount), `Missing ${schema} inventory count.`);
  assert.match(allowlist.inventory?.[schema]?.identityArgumentsMd5 || "", /^[a-f0-9]{32}$/, `Missing ${schema} inventory hash.`);
  assert.match(allowlist.inventory?.[schema]?.roleInventoryMd5 || "", /^[a-f0-9]{32}$/, `Missing ${schema} role inventory hash.`);
}
assert.ok(Array.isArray(allowlist.categories) && allowlist.categories.length >= 10, "The function allowlist is incomplete.");
assert.equal(advisorAllowlist.version, 1, "Unexpected security-advisor allowlist version.");
assert.equal(advisorAllowlist.accepted.length, 20, "The accepted advisor snapshot must contain one anonymous and nineteen authenticated wrapper notices.");
assert.equal(advisorAllowlist.accepted.filter((entry) => entry.advisor === "anon_security_definer_function_executable").length, 1, "The anonymous advisor exception count drifted.");
assert.equal(advisorAllowlist.accepted.filter((entry) => entry.advisor === "authenticated_security_definer_function_executable").length, 19, "The authenticated advisor exception count drifted.");
assert.equal(new Set(advisorAllowlist.accepted.map((entry) => `${entry.advisor}:${entry.schema}:${entry.function}`)).size, 20, "The advisor allowlist contains duplicate notices.");
assert.ok(advisorAllowlist.requiredAbsent.includes("auth_leaked_password_protection"), "The leaked-password advisor must remain a required pass condition.");
assert.equal(evidence.securityAdvisor.acceptedFunctionWarnings.anon_security_definer_function_executable, 1, "The advisor evidence has the wrong anonymous-warning count.");
assert.equal(evidence.securityAdvisor.acceptedFunctionWarnings.authenticated_security_definer_function_executable, 19, "The advisor evidence has the wrong authenticated-warning count.");
assert.deepEqual(evidence.securityAdvisor.unexpectedWarnings, [], "The advisor evidence contains an unexpected warning.");
assert.deepEqual(evidence.securityAdvisor.unresolvedWarnings, ["auth_leaked_password_protection"], "The Auth blocker evidence drifted.");
assert.equal(evidence.liveSqlVerification.status, "passed", "The recorded live SQL verification did not pass.");

const namesBySchema = new Map();
for (const category of allowlist.categories) {
  assert.ok(category.schema && allowlist.scope.includes(category.schema), `Invalid allowlist schema in ${category.id}.`);
  assert.ok(Array.isArray(category.allowedExecuteRoles), `Missing role contract in ${category.id}.`);
  assert.ok(category.rationale, `Missing rationale in ${category.id}.`);
  for (const name of category.names || []) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `Invalid function name ${name}.`);
    const key = `${category.schema}.${name}`;
    const previous = namesBySchema.get(key);
    assert.equal(previous, undefined, `Function ${key} appears in multiple allowlist categories.`);
    namesBySchema.set(key, category.id);
  }
}
assert.equal([...namesBySchema.values()].filter((id) => id === "chatgpt-internal-token-dispatchers").length, 6, "The ChatGPT internal dispatcher inventory is incomplete.");
assert.equal([...namesBySchema.values()].filter((id) => id === "private-token-dispatchers").length, 24, "The private token dispatcher inventory is incomplete.");
assert.equal([...namesBySchema.values()].filter((id) => id === "private-owner-only").length, 35, "The private owner-only inventory is incomplete.");

assert.match(liveSql, /security-definer-allowlist/i, "Live verification must identify the allowlist it enforces.");
assert.match(liveSql, /relrowsecurity/i, "Live verification must check table RLS.");
assert.match(liveSql, /has_table_privilege/i, "Live verification must check table privileges.");
assert.match(liveSql, /has_function_privilege/i, "Live verification must check function privileges.");
assert.match(liveSql, /prosecdef/i, "Live verification must inspect SECURITY DEFINER functions.");
assert.match(liveSql, /search_path/i, "Live verification must inspect function search paths.");
assert.match(liveSql, /proconfig\s+is\s+distinct\s+from/i, "Live verification must fail closed for NULL SECURITY DEFINER search paths.");
assert.match(liveSql, /service_role_only/i, "Live verification must check the service-role policies.");

assert.match(documentation, /accepted, documented exception/i, "The intentional rate-limit advisor warning is not documented.");
assert.match(documentation, /nineteen authenticated warnings for user-facing wrappers are\s+also\s+intentional/i, "The authenticated advisor warnings are not documented.");
assert.match(documentation, /auth_leaked_password_protection.*must disappear/is, "The Auth advisor requirement is not documented.");
assert.match(documentation, /Free plan.*Pro-only setting/is, "The current Auth-setting blocker is not recorded.");
assert.match(documentation, /20260907194623_supabase_security_hardening/i, "The applied remote migration is not recorded.");
assert.match(documentation, /0095_supabase_security_definer_inventory/i, "The follow-up migration is not recorded.");
assert.match(documentation, /live SQL verifier/i, "The live verifier is not documented.");
assert.match(documentation, /private helpers.*client roles/is, "The private-helper boundary is not documented.");
assert.match(documentation, /security-advisor-allowlist\.json/i, "The advisor allowlist is not documented.");

if (process.argv.includes("--live")) {
  const psql = process.env.PSQL_BIN || "psql";
  const databaseUrl = process.env.SUPABASE_DB_URL;
  assert.ok(databaseUrl, "--live requires SUPABASE_DB_URL; do not put a database URL in source control.");
  assert.ok(fs.existsSync(path.join(root, "database/security/verify_supabase_security.sql")), "Live SQL verifier is missing.");
  try {
    execFileSync(psql, ["-X", "-v", "ON_ERROR_STOP=1", "--dbname", databaseUrl, "--file", path.join(root, "database/security/verify_supabase_security.sql")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || undefined },
    });
  } catch (error) {
    throw new Error(`Supabase live security verification failed. Ensure psql is installed and SUPABASE_DB_URL targets the intended project. ${error.message}`);
  }
  console.log("Supabase live security verification passed.");
} else {
  console.log("Supabase security contract passed (static). Run with --live and SUPABASE_DB_URL for catalog verification.");
}
