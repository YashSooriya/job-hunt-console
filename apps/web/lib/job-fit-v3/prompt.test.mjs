import assert from "node:assert/strict";
import test from "node:test";
import { validateCriterionGroupResponse } from "./criteria-preparation.ts";
import { buildContextSteps, buildCriteriaPreparationSteps, MAX_CONTEXT_PROMPT_CHARS } from "./prompt.ts";
import { snapshotHash } from "./input.ts";
import { CHATGPT_TESTING_MODE_PREFIX, MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS } from "../chatgpt/testing-mode.ts";

const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const JOB_ID = "20000000-0000-4000-8000-000000000002";
const SNAPSHOT_ID = "30000000-0000-4000-8000-000000000003";

function sourceUnit(index, text, sourceField = "essential_requirements", importance = "essential") {
  return {
    reference: `source:${snapshotHash([SNAPSHOT_ID, sourceField, index, text])}`,
    text,
    importance,
    source_field: sourceField,
    source_index: index,
  };
}

function fitInput(units, title = "Computational Scientist") {
  return {
    schema_version: "job-fit-input-v3.1",
    assessment_request_id: `${REQUEST_ID}:${JOB_ID}`,
    job_id: JOB_ID,
    job_snapshot_id: SNAPSHOT_ID,
    job_revision: 12,
    profile_id: "40000000-0000-4000-8000-000000000004",
    profile_revision: 8,
    profile_snapshot_hash: "a".repeat(64),
    vacancy_snapshot_hash: "b".repeat(64),
    rubric_version: "job-fit-rubric-v3.0",
    candidate_background: [],
    vacancy: { title, company: "Example Employer", description: "A saved listing description for a computational engineering role." },
    criteria_source_units: units,
    criteria: [],
  };
}

function promptPayload(step) {
  const start = step.text.lastIndexOf('{"source_units":');
  assert.notEqual(start, -1, "message includes the complete JSON source and response schema");
  return JSON.parse(step.text.slice(start));
}

function assertCompleteCoverage(steps, expectedUnits, input) {
  assert.ok(steps.length > 0);
  assert.ok(steps.every((step) => step.text.length <= MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS));
  assert.deepEqual(steps.flatMap((step) => step.source_unit_references), expectedUnits.map((unit) => unit.reference));
  for (const step of steps) {
    assert.ok(step.source_unit_references.length <= 6, "groups retain the established six-source upper bound");
    const payload = promptPayload(step);
    assert.deepEqual(payload.source_units.map((unit) => unit.reference), step.source_unit_references);
    assert.deepEqual(payload.source_units, expectedUnits.filter((unit) => step.source_unit_references.includes(unit.reference)));
    assert.equal(payload.expected_response.schema_version, "job-fit-criteria-group-v3.2");
    assert.equal(payload.expected_response.results.length, 1, "the response shape is documented once per message");
    assert.equal(payload.expected_response.results[0].source_unit_reference, step.source_unit_references[0]);
    const results = payload.source_units.map((unit) => ({
      source_unit_reference: unit.reference,
      disposition: "criteria",
      criteria: [{ text: unit.text.slice(0, 80), dimension: unit.source_field === "responsibilities" ? "role_type" : "technical", importance: unit.importance }],
      reason: "This source states a job-relevant capability.",
    }));
    const validated = validateCriterionGroupResponse({
      ...payload.expected_response,
      source_unit_references: payload.source_units.map((unit) => unit.reference),
      results,
    }, input, step.group_id, payload.source_units);
    assert.equal(validated.length, payload.source_units.length, "the unchanged v3.2 validator accepts one result per unit");
  }
}

test("full rendered-message packing preserves source order and emits one reusable v3.2 response shape", () => {
  const units = Array.from({ length: 6 }, (_, index) => sourceUnit(index, `Requirement ${index + 1}: ${"verified numerical modelling capability ".repeat(4)}`));
  const input = fitInput(units);
  const first = buildCriteriaPreparationSteps(input, true);
  const second = buildCriteriaPreparationSteps(input, true);

  assertCompleteCoverage(first, units, input);
  assert.deepEqual(first, second, "grouping, messages, and prompt hashes are deterministic");
  assert.ok(first.every((step) => step.text.startsWith(CHATGPT_TESTING_MODE_PREFIX)));
  assert.ok(first.every((step) => step.text.indexOf(CHATGPT_TESTING_MODE_PREFIX, CHATGPT_TESTING_MODE_PREFIX.length) === -1));
  assert.ok(first.every((step) => step.text.includes("exactly one entry for each reference in source_unit_references")));
});

test("full-message overflow splits a multi-unit group without dropping or altering any source", () => {
  const units = Array.from({ length: 8 }, (_, index) => sourceUnit(index, `Requirement ${index + 1}: ${"x".repeat(650)}`));
  const steps = buildCriteriaPreparationSteps(fitInput(units), false);

  assert.ok(steps.length > 1, "large groups are split to fit the actual rendered prompt");
  assertCompleteCoverage(steps, units, fitInput(units));
  assert.ok(steps.every((step) => !step.text.startsWith(CHATGPT_TESTING_MODE_PREFIX)));
});

test("a long source that fits as a complete single-unit prompt is accepted", () => {
  const unit = sourceUnit(0, "A".repeat(2800));
  const [step] = buildCriteriaPreparationSteps(fitInput([unit]), false);

  assert.ok(step.text.length <= MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS);
  assert.equal(promptPayload(step).source_units[0].text, unit.text);
});

test("a genuinely oversized individual source reports the exact listing and source location", () => {
  const unit = sourceUnit(2, "B".repeat(7000), "responsibilities", "responsibility");

  assert.throws(
    () => buildCriteriaPreparationSteps(fitInput([unit], "Simulation Engineer"), true),
    /responsibilities item 3 for “Simulation Engineer” cannot fit in a single Website Bridge message\. No analysis was started and no listing content was changed\./,
  );
});

test("Unicode and JSON-special source text are measured after complete JSON serialization", () => {
  const units = [
    sourceUnit(0, "Use finite elements, quotes: \"exactly\"; line one\nline two 😀."),
    sourceUnit(1, "Develop numerical models with C++, Fortran, and Python — preserve this text verbatim.", "responsibilities", "responsibility"),
  ];
  const steps = buildCriteriaPreparationSteps(fitInput(units), true);

  assertCompleteCoverage(steps, units, fitInput(units));
  assert.ok(steps.every((step) => step.text.length <= MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS));
  assert.deepEqual(steps.flatMap((step) => promptPayload(step).source_units), units);
});

test("the 6,000-character boundary is accepted and the next source is packed into another group", () => {
  const first = sourceUnit(0, "x");
  const initial = fitInput([first]);
  const initialLength = buildCriteriaPreparationSteps(initial, false)[0].text.length;
  const exact = sourceUnit(0, "x".repeat(1 + MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS - initialLength));
  const exactOnly = buildCriteriaPreparationSteps(fitInput([exact]), false);

  assert.equal(exactOnly[0].text.length, MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS);
  const second = sourceUnit(1, "A short second requirement.");
  const units = [exact, second];
  const steps = buildCriteriaPreparationSteps(fitInput(units), false);

  assert.equal(steps.length, 2);
  assert.equal(steps[0].text.length, MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS);
  assertCompleteCoverage(steps, units, fitInput(units));
});

test("group totals crossing one- and two-digit numbering remain within the exact limit", () => {
  const sample = sourceUnit(0, "x".repeat(2000));
  const sampleSteps = buildCriteriaPreparationSteps(fitInput([sample]), false);
  assert.equal(sampleSteps.length, 1, "a large individual source fits alone");

  const units = Array.from({ length: 100 }, (_, index) => sourceUnit(index, "x".repeat(2000)));
  const steps = buildCriteriaPreparationSteps(fitInput(units), false);

  assert.equal(steps.length, 100, "large sources are sent one per bounded group");
  assert.ok(steps[8].text.includes("Process every source unit in group 9 of 100"));
  assert.ok(steps[9].text.includes("Process every source unit in group 10 of 100"));
  assert.ok(steps[98].text.includes("Process every source unit in group 99 of 100"));
  assert.ok(steps[99].text.includes("Process every source unit in group 100 of 100"));
  assertCompleteCoverage(steps, units, fitInput(units));
});

test("empty source sets produce no messages", () => {
  assert.deepEqual(buildCriteriaPreparationSteps(fitInput([]), false), []);
});

test("short skill tokens are accepted only as exact non-empty source spans", () => {
  const unit = sourceUnit(0, "C++", "skills", "essential");
  const input = fitInput([unit]);
  const [step] = buildCriteriaPreparationSteps(input, true);
  const payload = promptPayload(step);
  const response = {
    ...payload.expected_response,
    source_unit_references: [unit.reference],
    results: [{
      source_unit_reference: unit.reference,
      disposition: "criteria",
      criteria: [{ text: "C++", dimension: "technical", importance: "essential" }],
      reason: "The saved listing explicitly names this required language.",
    }],
  };

  assert.match(step.text, /Short exact tokens are valid/);
  assert.equal(validateCriterionGroupResponse(response, input, step.group_id, [unit])[0].criteria[0].text, "C++");
  assert.throws(() => validateCriterionGroupResponse({
    ...response,
    results: [{ ...response.results[0], criteria: [{ ...response.results[0].criteria[0], text: "Java" }] }],
  }, input, step.group_id, [unit]), /exact non-empty text span/);
});

test("context parts keep a 1,200-character buffer below the Bridge limit and reassemble the frozen input exactly", () => {
  const input = {
    ...fitInput([]),
    candidate_background: [{
      reference: "project:large-source",
      record_type: "project",
      content: { details: "Verified background with Unicode 😀 and exact source wording. ".repeat(1400) },
    }],
  };
  const steps = buildContextSteps(input, true);

  assert.ok(steps.length > 10, "long frozen inputs are divided into bounded context turns");
  assert.ok(steps.every((step) => step.phase === "context"));
  assert.ok(steps.every((step) => step.text.length <= MAX_CONTEXT_PROMPT_CHARS));
  assert.ok(steps.every((step) => step.text.length <= MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS));
  assert.ok(steps.every((step) => step.text.startsWith(CHATGPT_TESTING_MODE_PREFIX)));
  const reassembled = steps.map((step) => step.text.split("BEGIN SOURCE PART\n")[1].split("\nEND SOURCE PART")[0]).join("");
  assert.deepEqual(JSON.parse(reassembled), input, "chunk boundaries do not omit, alter, or reorder frozen JSON");
});
