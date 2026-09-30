import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchProfileSummary } from "./profile-summary.ts";

test("profile summary contains only compact role evidence, never contact details", () => {
  const summary = buildSearchProfileSummary({
    displayName: "Example Person",
    facts: [{ fact_key: "email", value_json: "private@example.test" }],
    employment: [{ role_title: "Data Analyst", employer: "Example Labs", details: "Built reliable forecasting models." }],
    education: [], skills: [{ name: "Python", proficiency: "Advanced", years_experience: 5 }],
    projects: [], publications: [], evidence: [], sourceDocuments: [],
  });
  assert.match(summary, /Data Analyst/);
  assert.match(summary, /Python/);
  assert.doesNotMatch(summary, /private@example\.test|Example Person/);
});

test("profile summary stays bounded at complete record boundaries", () => {
  const summary = buildSearchProfileSummary({
    displayName: "",
    facts: [],
    employment: Array.from({ length: 20 }, (_, i) => ({ role_title: `Role ${i}`, employer: `Employer ${i}`, details: "x".repeat(240) })),
    education: [], skills: [], projects: [], publications: [], evidence: [], sourceDocuments: [],
  }, 500);
  assert.ok(summary.length <= 500);
  assert.match(summary, /more verified evidence omitted/);
  assert.doesNotMatch(summary, /Employer 19/);
});
