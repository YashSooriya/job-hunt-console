import assert from "node:assert/strict";
import test from "node:test";
import { loadVerifiedBackground } from "./server.ts";

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
