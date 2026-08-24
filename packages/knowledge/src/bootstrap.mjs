import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const seedPath = path.join(root, "data/knowledge/seed.json");
const manifestPath = path.join(root, "data/knowledge/source-manifest.json");
const outputPath = path.join(root, "data/knowledge/knowledge-base.generated.json");

const seed = JSON.parse(await fs.readFile(seedPath, "utf8"));
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const knownSources = new Set(manifest.sources.map((s) => s.source_key));
const errors = [];
const evidenceKeys = new Set();

for (const fact of seed.profile.facts) {
  if (!knownSources.has(fact.source_key)) errors.push(`Unknown fact source: ${fact.fact_key} -> ${fact.source_key}`);
}
for (const item of seed.evidence) {
  if (evidenceKeys.has(item.evidence_key)) errors.push(`Duplicate evidence key: ${item.evidence_key}`);
  evidenceKeys.add(item.evidence_key);
  if (!knownSources.has(item.source_key)) errors.push(`Unknown evidence source: ${item.evidence_key} -> ${item.source_key}`);
  if (!Array.isArray(item.tags) || item.tags.length === 0) errors.push(`Evidence has no tags: ${item.evidence_key}`);
  if (item.strength < 1 || item.strength > 5) errors.push(`Invalid strength: ${item.evidence_key}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const generated = {
  schema_version: "1.0.0",
  generated_at: new Date().toISOString(),
  source_count: manifest.sources.length,
  fact_count: seed.profile.facts.length,
  evidence_count: seed.evidence.length,
  profile: seed.profile,
  evidence: seed.evidence,
  preferences: seed.preferences,
};
await fs.writeFile(outputPath, JSON.stringify(generated, null, 2) + "\n");
console.log(`Knowledge base written to ${outputPath}`);
console.log(`${generated.fact_count} facts, ${generated.evidence_count} evidence items, ${generated.source_count} sources`);
