import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildBackground, buildCriteriaSourceUnits } from "./input.ts";
import { makeTaskSpec, loadVerifiedBackground } from "./server.ts";
import { MAX_SAFE_FIT_PROMPT_CHARS } from "./prompt.ts";
import { CHATGPT_TESTING_MODE_PREFIX } from "../chatgpt/testing-mode.ts";

const profileId = "00000000-0000-4000-8000-000000000001";
const factId = "00000000-0000-4000-8000-000000000002";
const employmentId = "00000000-0000-4000-8000-000000000003";

test("verified-background loading matches the deployed candidate_facts schema", async () => {
  const schemas = {
    candidate_facts: new Set(["id", "profile_id", "fact_key", "value_json", "verification_status", "source_note", "verified_at", "created_at", "updated_at"]),
    evidence_items: new Set(["id", "profile_id", "source_id", "evidence_key", "category", "claim", "detail", "tags", "source_locator", "verification_status", "strength", "created_at", "updated_at"]),
    candidate_preferences: new Set(["profile_id", "preferences"]),
  };
  const rows = {
    candidate_facts: [{ id: factId, fact_key: "work_authorisation", value_json: { country: "UK" }, verification_status: "verified", source_note: "Confirmed by user" }],
    evidence_items: [],
    candidate_employment: [{ id: employmentId, employer: "Example Research", role_title: "Research Engineer", start_date: "2022-01-01", end_date: null, current: true, details: "Verified employment", verification_status: "verified" }],
    candidate_education: [],
    candidate_skills: [],
    candidate_projects: [],
    candidate_publications: [],
    candidate_preferences: { preferences: { preferred_locations: ["Scotland"] } },
  };

  class Query {
    constructor(table) { this.table = table; this.error = null; }
    select(columns) {
      if (columns !== "*") for (const column of columns.split(",").map((value) => value.trim())) {
        if (schemas[this.table] && !schemas[this.table].has(column)) this.error = { message: `column ${this.table}.${column} does not exist` };
      }
      return this;
    }
    eq() { return this; }
    in() { return this; }
    maybeSingle() { return Promise.resolve({ data: rows[this.table] ?? null, error: this.error }); }
    then(resolve, reject) { return Promise.resolve({ data: rows[this.table] ?? [], error: this.error }).then(resolve, reject); }
  }

  const loaded = await loadVerifiedBackground({ from: (table) => new Query(table) }, profileId);
  const fact = loaded.background.find((record) => record.reference === `fact:${factId}`);
  assert.ok(fact, "the verified work-authorisation fact should be included");
  assert.equal(fact.source_reference, null, "the candidate fact uses its own record ID, not a nonexistent source_id");
  assert.ok(loaded.background.some((record) => record.reference === `employment:${employmentId}`));
  assert.deepEqual(loaded.preferences.preferred_locations, ["Scotland"]);
});

test("production task construction prepares every saved criterion within the bridge limit", () => {
  const userId = "50000000-0000-4000-8000-000000000005";
  const jobId = "60000000-0000-4000-8000-000000000006";
  const snapshotId = "70000000-0000-4000-8000-000000000007";
  const profileId = "80000000-0000-4000-8000-000000000008";
  const vacancy = {
    title: "Simulation Engineer",
    company: "Example Employer",
    description: "Develop validated computational models for engineering applications.",
    essential_requirements: Array.from({ length: 16 }, (_, index) => `Required capability ${index + 1}: numerical modelling and verified software development.`),
    desirable_requirements: ["Experience with HPC and GPU computing."],
    responsibilities: ["Develop, validate, and document engineering models."],
    skills: ["Python", "C++", "Finite element analysis"],
  };
  const profile = {
    id: profileId,
    analysis_revision: 4,
    background: buildBackground({ skill: [{ id: employmentId, verification_status: "verified", name: "Python" }] }),
    preferences: {},
  };
  const spec = makeTaskSpec({
    userId,
    requestId: "90000000-0000-4000-8000-000000000009",
    job: { id: jobId, analysis_revision: 3 },
    snapshot: { id: snapshotId },
    vacancy,
    profile,
    testingMode: true,
    assessmentAsOf: new Date("2026-09-30T00:00:00.000Z"),
  });
  const sourceUnits = buildCriteriaSourceUnits(vacancy, snapshotId);
  const criteriaSteps = spec.steps.filter((step) => step.phase === "criteria");

  assert.ok(criteriaSteps.length > 1, "production task uses bounded groups for saved listing fields");
  assert.ok(criteriaSteps.every((step) => step.text.length <= MAX_SAFE_FIT_PROMPT_CHARS));
  assert.ok(criteriaSteps.every((step) => step.text.startsWith(CHATGPT_TESTING_MODE_PREFIX)));
  assert.deepEqual(criteriaSteps.flatMap((step) => step.source_unit_references), sourceUnits.map((unit) => unit.reference));
  assert.deepEqual(spec.input_payload.fit_input.criteria_source_units, sourceUnits);

  const longSource = "x".repeat(7000);
  const longSpec = makeTaskSpec({
    userId,
    requestId: "a0000000-0000-4000-8000-00000000000a",
    job: { id: jobId, analysis_revision: 3 },
    snapshot: { id: snapshotId },
    vacancy: { ...vacancy, responsibilities: [longSource] },
    profile,
    testingMode: true,
    assessmentAsOf: new Date("2026-09-30T00:00:00.000Z"),
  });
  const longSourceSteps = longSpec.steps.filter((step) => step.context_kind === "criteria_source");
  assert.ok(longSourceSteps.length > 1, "production task construction transfers an oversized paragraph before asking for criteria");
  assert.deepEqual(longSourceSteps.map((step) => step.text.split("BEGIN SOURCE PART\n")[1].split("\nEND SOURCE PART")[0]).join(""), longSource);
  assert.ok(longSpec.steps.filter((step) => step.phase === "criteria").every((step) => step.text.length <= MAX_SAFE_FIT_PROMPT_CHARS));
});

test("V3 route prepares every selected task before it asks the worker to create a batch", async () => {
  const routePath = new URL("../../app/api/jobs/analysis/v3/route.ts", import.meta.url);
  const route = await readFile(routePath, "utf8");
  const allSpecs = route.indexOf("const specs = jobIds.map((id) => {");
  const batchCreation = route.indexOf('action: "fit_create"', allSpecs);

  assert.notEqual(allSpecs, -1);
  assert.notEqual(batchCreation, -1);
  assert.ok(allSpecs < batchCreation, "all makeTaskSpec calls finish before the durable batch request");
  assert.match(route.slice(allSpecs, batchCreation), /makeTaskSpec\(/);
});
