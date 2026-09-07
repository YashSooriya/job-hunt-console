import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const packageManifest = await readJson("apps/chatgpt-bridge-extension/package.json");
const version = packageManifest.version;
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "The extension package must declare a semantic version.");

const migrationsDir = path.join(root, "database/migrations");
const migrationNames = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql"));
const versions = new Map();
for (const name of migrationNames) {
  const match = /^(\d{4})_/.exec(name);
  if (!match) continue;
  const names = versions.get(match[1]) || [];
  names.push(name);
  versions.set(match[1], names);
}
for (const [number, names] of versions) assert.equal(names.length, 1, `Migration ${number} is duplicated: ${names.join(", ")}`);
assert.ok(migrationNames.includes("0081_chatgpt_bridge_delivery_timing.sql"), "Migration 0081 must remain the canonical delivery-timing migration.");
assert.ok(migrationNames.includes("0082_chatgpt_rate_limit_dispatcher_grant_repair.sql"), "The historical rate-limit repair must be preserved as migration 0082.");
assert.ok(!migrationNames.includes("0081_chatgpt_rate_limit_dispatcher_grant_repair.sql"), "The old duplicate 0081 rate-limit filename must not return.");
for (const number of ["0083", "0084", "0085"]) assert.ok(migrationNames.some((name) => name.startsWith(`${number}_`)), `Migration ${number} is missing.`);
const deliveryTiming = await readFile(path.join(migrationsDir, "0081_chatgpt_bridge_delivery_timing.sql"), "utf8");
const rateLimitRepair = await readFile(path.join(migrationsDir, "0082_chatgpt_rate_limit_dispatcher_grant_repair.sql"), "utf8");
assert.match(deliveryTiming, /bounded Website Bridge delivery timing/i);
assert.match(rateLimitRepair, /Safe repair for the rejected historical rate-limit grant proposal/i);

const metadataPath = `docs/releases/chatgpt-bridge-v${version}.json`;
const metadata = await readJson(metadataPath);
assert.equal(metadata.release, "chatgpt-bridge");
assert.equal(metadata.extensionVersion, version);
assert.match(metadata.sourceCommit, /^[0-9a-f]{7,64}$/i, "Release metadata must record the source commit.");
assert.match(metadata.buildId, new RegExp(`^${version.replaceAll(".", "\\.")}-[0-9a-f]{7,64}$`), "Release metadata must record a commit-derived build id.");
assert.equal(metadata.artifact?.manifestVersion, version);
assert.equal(metadata.artifact?.path, `apps/chatgpt-bridge-extension/dist/jobhunt-chatgpt-bridge-v${version}.zip`);
assert.match(metadata.artifact?.sha256 || "", /^[0-9a-f]{64}$/i, "Release metadata must record the artifact SHA-256.");
assert.ok(metadata.cloudflare?.deploymentId, "Release metadata must record the Cloudflare deployment id.");
assert.ok(metadata.cloudflare?.url, "Release metadata must record the deployed Worker URL.");
assert.equal(metadata.supabase?.edgeFunction, "chatgpt-bridge");
assert.ok(Number.isInteger(metadata.supabase?.edgeFunctionVersion) && metadata.supabase.edgeFunctionVersion > 0, "Release metadata must record the Supabase Edge Function version.");
assert.ok(metadata.supabase?.migrationHead?.file && migrationNames.includes(metadata.supabase.migrationHead.file), "Release metadata must record an applied migration head that exists in the checkout.");
assert.ok(metadata.supabase.migrationHead.remoteVersion, "Release metadata must record the applied remote migration version.");
assert.ok(typeof metadata.verification?.bridgeGate === "string" && metadata.verification.bridgeGate.includes("chatgpt-bridge:verify"), "Release metadata must record the bridge verification gate.");
assert.ok(typeof metadata.verification?.artifactReproduction === "string" && metadata.verification.artifactReproduction.includes("JOB_HUNT_BUILD_ID"), "Release metadata must record the reproducible artifact command.");

const gitDirectory = path.join(root, ".git");
try {
  await stat(gitDirectory);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim(), "", "The release checkout must be clean.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  // A source archive created with `git archive` has no .git directory. The
  // commit identity is still checked through the metadata fields above.
}

if (process.argv.includes("--artifact")) {
  const artifact = path.join(root, metadata.artifact.path);
  const bytes = await readFile(artifact);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, metadata.artifact.sha256, "The release artifact hash does not match release metadata.");
  assert.ok(bytes.length > 0, "The release artifact must be non-empty.");
}

console.log(`ChatGPT bridge release verification passed for ${version} (${metadata.buildId}).`);
