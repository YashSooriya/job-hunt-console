import assert from "node:assert/strict";
import test from "node:test";
import { validateCriterionGroupResponse } from "./criteria-preparation.ts";
import { buildContextSteps, buildCriteriaPreparationSteps, buildPreparedAssessmentSteps, MAX_CONTEXT_PROMPT_CHARS, MAX_JOB_FIT_STEPS, MAX_SAFE_FIT_PROMPT_CHARS } from "./prompt.ts";
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
  assert.ok(steps.filter((step) => step.phase === "criteria").every((step) => step.text.length <= MAX_SAFE_FIT_PROMPT_CHARS));
  assert.deepEqual(steps.flatMap((step) => step.source_unit_references), expectedUnits.map((unit) => unit.reference));
  for (const step of steps) {
    assert.ok(step.source_unit_references.length <= 6, "groups retain the established six-source upper bound");
    const payload = promptPayload(step);
    assert.deepEqual(payload.source_units.map((unit) => unit.reference), step.source_unit_references);
    for (const savedUnit of payload.source_units) {
      const original = expectedUnits.find((unit) => unit.reference === savedUnit.reference);
      assert.ok(original, "each prompt reference resolves to a frozen source unit");
      if (savedUnit.source_context) {
        assert.deepEqual(savedUnit.source_context, { sha256: snapshotHash(original.text), complete_text_previously_transferred: true });
        assert.equal(savedUnit.importance, original.importance);
        assert.equal(savedUnit.source_field, original.source_field);
        assert.equal(savedUnit.source_index, original.source_index);
      } else assert.deepEqual(savedUnit, original);
    }
    assert.equal(payload.expected_response.schema_version, "job-fit-criteria-group-v3.2");
    assert.equal(payload.expected_response.results.length, 1, "the response shape is documented once per message");
    assert.equal(payload.expected_response.results[0].source_unit_reference, step.source_unit_references[0]);
    const results = expectedUnits.filter((unit) => step.source_unit_references.includes(unit.reference)).map((unit) => ({
      source_unit_reference: unit.reference,
      disposition: "criteria",
      criteria: [{ text: unit.text.slice(0, 80), dimension: unit.source_field === "responsibilities" ? "role_type" : "technical", importance: unit.importance }],
      reason: "This source states a job-relevant capability.",
    }));
    const validated = validateCriterionGroupResponse({
      ...payload.expected_response,
      source_unit_references: payload.source_units.map((unit) => unit.reference),
      results,
    }, input, step.group_id, expectedUnits.filter((unit) => step.source_unit_references.includes(unit.reference)));
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

test("a source that fits as a complete single-unit prompt remains inline", () => {
  const unit = sourceUnit(0, "A".repeat(1700));
  const [step] = buildCriteriaPreparationSteps(fitInput([unit]), false);

  assert.ok(step.text.length <= MAX_SAFE_FIT_PROMPT_CHARS);
  assert.equal(promptPayload(step).source_units[0].text, unit.text);
});

test("a large individual source is transferred in bounded exact parts and assessed by its original reference", () => {
  const unit = sourceUnit(2, "B".repeat(7000), "responsibilities", "responsibility");
  const input = fitInput([unit], "Simulation Engineer");
  const steps = buildCriteriaPreparationSteps(input, true);
  const context = steps.filter((step) => step.context_kind === "criteria_source");
  const criteria = steps.filter((step) => step.phase === "criteria");

  assert.ok(context.length > 1, "the complete source is transferred through bounded context messages");
  assert.ok(context.every((step) => step.phase === "context" && step.text.length <= MAX_SAFE_FIT_PROMPT_CHARS));
  assert.deepEqual(context.map((step) => step.context_part_index), context.map((_, index) => index + 1));
  assert.ok(context.every((step) => step.context_part_count === context.length && step.context_source_unit_reference === unit.reference));
  assert.deepEqual(context.map((step) => step.text.split("BEGIN SOURCE PART\n")[1].split("\nEND SOURCE PART")[0]).join(""), unit.text);
  assert.equal(criteria.length, 1);
  assert.ok(criteria[0].text.length <= MAX_SAFE_FIT_PROMPT_CHARS);
  assert.deepEqual(criteria[0].source_unit_references, [unit.reference]);
  const payload = promptPayload(criteria[0]);
  assert.deepEqual(payload.source_units[0], {
    reference: unit.reference,
    source_context: { sha256: snapshotHash(unit.text), complete_text_previously_transferred: true },
    importance: unit.importance,
    source_field: unit.source_field,
    source_index: unit.source_index,
  });
  assert.ok(!criteria[0].text.includes(unit.text), "the long text is not duplicated into the extraction prompt");
  assert.ok(criteria[0].text.startsWith(CHATGPT_TESTING_MODE_PREFIX));
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

test("the safe 4,800-character boundary is accepted and the next source is packed into another group", () => {
  const first = sourceUnit(0, "x");
  const initial = fitInput([first]);
  const initialLength = buildCriteriaPreparationSteps(initial, false)[0].text.length;
  const exact = sourceUnit(0, "x".repeat(1 + MAX_SAFE_FIT_PROMPT_CHARS - initialLength));
  const exactOnly = buildCriteriaPreparationSteps(fitInput([exact]), false);

  assert.equal(exactOnly[0].text.length, MAX_SAFE_FIT_PROMPT_CHARS);
  const second = sourceUnit(1, "A short second requirement.");
  const units = [exact, second];
  const steps = buildCriteriaPreparationSteps(fitInput(units), false);

  assert.equal(steps.length, 2);
  assert.equal(steps[0].text.length, MAX_SAFE_FIT_PROMPT_CHARS);
  assertCompleteCoverage(steps, units, fitInput(units));
});

test("large source groups crossing one- and two-digit numbering remain within the exact limit", () => {
  const sample = sourceUnit(0, "x".repeat(3500));
  const sampleSteps = buildCriteriaPreparationSteps(fitInput([sample]), false);
  assert.equal(sampleSteps.filter((step) => step.phase === "criteria").length, 1, "a large individual source produces one criteria group");

  const units = Array.from({ length: 40 }, (_, index) => sourceUnit(index, "x".repeat(3500)));
  const steps = buildCriteriaPreparationSteps(fitInput(units), false);
  const criteriaSteps = steps.filter((step) => step.phase === "criteria");

  assert.ok(criteriaSteps.length >= 10 && criteriaSteps.length < units.length, "complete transferred sources are compactly grouped across one- and two-digit counts");
  assert.ok(steps.length <= 200, "source transfer and criteria remain within the durable-step ceiling");
  assert.ok(criteriaSteps[8].text.includes(`Process every source unit in group 9 of ${criteriaSteps.length}`));
  assert.ok(criteriaSteps[9].text.includes(`Process every source unit in group 10 of ${criteriaSteps.length}`));
  assert.ok(criteriaSteps.at(-1).text.includes(`Process every source unit in group ${criteriaSteps.length} of ${criteriaSteps.length}`));
  assertCompleteCoverage(criteriaSteps, units, fitInput(units));
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

test("prepared assessment steps enforce the shared 200-message task ceiling including earlier saved turns", () => {
  const input = fitInput([]);
  const atLimit = buildPreparedAssessmentSteps(input, true, MAX_JOB_FIT_STEPS - 2);
  assert.equal(atLimit.length, 2, "one compact context turn and one assessment turn fit at the exact boundary");
  assert.equal(atLimit[0].ordinal, MAX_JOB_FIT_STEPS - 2);
  assert.equal(atLimit[1].ordinal, MAX_JOB_FIT_STEPS - 1);
  assert.throws(
    () => buildPreparedAssessmentSteps(input, true, MAX_JOB_FIT_STEPS - 1),
    /exceed the 200-step safety limit/,
  );
});
