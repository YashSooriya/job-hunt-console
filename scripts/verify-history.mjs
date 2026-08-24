import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const tracker = JSON.parse(await fs.readFile(path.join(root, "data/imports/tracker.normalized.json"), "utf8"));
const allowed = new Set([
  "awaiting_response", "assessment", "interview", "offer", "rejected", "withdrawn",
]);
const failures = [];
const rows = new Set();

if (!Array.isArray(tracker.records) || tracker.records.length === 0) failures.push("tracker has no records");
for (const record of tracker.records || []) {
  if (!record.company?.trim()) failures.push(`row ${record.sourceRow}: company missing`);
  if (!record.role?.trim()) failures.push(`row ${record.sourceRow}: role missing`);
  if (!allowed.has(record.applicationState)) failures.push(`row ${record.sourceRow}: invalid historical state ${record.applicationState}`);
  if (rows.has(record.sourceRow)) failures.push(`row ${record.sourceRow}: duplicate source row`);
  rows.add(record.sourceRow);
}
if ((tracker.summary?.total ?? -1) !== tracker.records.length) failures.push("summary total does not match records");
if (!tracker.quality || !Array.isArray(tracker.quality.issues)) failures.push("tracker quality report missing");
if ((tracker.quality?.errorCount ?? 1) > 0) failures.push(`tracker quality has ${tracker.quality.errorCount} blocking errors`);

if (failures.length) {
  console.error("Historical tracker verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Historical tracker verified: ${tracker.records.length} records, ${tracker.quality.issueCount} non-blocking data-quality notes.`);
