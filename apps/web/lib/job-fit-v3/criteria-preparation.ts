import type { Criterion, CriterionSourceUnit, Dimension, FitInput } from "./contract.ts";
import { snapshotHash } from "./input.ts";

const DIMENSIONS = new Set<Dimension>(["technical", "seniority", "domain", "role_type", "qualification", "eligibility"]);
const IMPORTANCE = new Set<Criterion["importance"]>(["essential", "desirable", "responsibility", "context"]);

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Criterion preparation must be one JSON object.");
  return value as Record<string, any>;
}
function exactKeys(value: Record<string, any>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Criterion preparation has missing or unexpected fields.");
  }
}
function normalized(value: string) { return value.replace(/\s+/g, " ").trim().toLocaleLowerCase(); }
function importanceRank(value: Criterion["importance"]) { return value === "essential" ? 4 : value === "desirable" ? 3 : value === "responsibility" ? 2 : 1; }

export type CriterionUnitResponse = {
  schema_version: "job-fit-criteria-unit-v3.1";
  assessment_request_id: string;
  job_id: string;
  vacancy_snapshot_hash: string;
  source_unit_reference: string;
  disposition: "criteria" | "duplicate" | "non_requirement";
  criteria: Array<{ text: string; dimension: Dimension; importance: Criterion["importance"] }>;
  duplicate_of_source_unit_reference: string | null;
  reason: string;
};

export type CriterionGroupResponse = {
  schema_version: "job-fit-criteria-group-v3.2";
  assessment_request_id: string;
  job_id: string;
  vacancy_snapshot_hash: string;
  group_id: string;
  source_unit_references: string[];
  results: Array<{
    source_unit_reference: string;
    disposition: "criteria" | "non_requirement";
    criteria: Array<{ text: string; dimension: Dimension; importance: Criterion["importance"] }>;
    reason: string;
  }>;
};

export function parseCriterionUnitResponse(raw: string): unknown {
  if (raw.length > 100000) throw new Error("The criterion-preparation response exceeds the safe size limit.");
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try { return object(JSON.parse(candidate)); }
  catch { throw new Error("ChatGPT's criterion-preparation response was not one valid JSON object. The original message was not resent."); }
}

export function parseCriterionGroupResponse(raw: string): unknown {
  if (raw.length > 20000) throw new Error("The grouped criterion-preparation response exceeds the safe size limit.");
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try { return object(JSON.parse(candidate)); }
  catch { throw new Error("ChatGPT's grouped criterion-preparation response was not one valid JSON object. The original message was not resent."); }
}

/** Validate every item in a bounded source group, then reuse the strict v3.1
 * per-source validator so older saved tasks and the criterion finalizer keep
 * the same evidence rules. Grouping changes dispatch count, not the rubric. */
export function validateCriterionGroupResponse(
  value: unknown,
  input: FitInput,
  groupId: string,
  expectedUnits: CriterionSourceUnit[],
): CriterionUnitResponse[] {
  const response = object(value);
  exactKeys(response, ["schema_version", "assessment_request_id", "job_id", "vacancy_snapshot_hash", "group_id", "source_unit_references", "results"]);
  if (response.schema_version !== "job-fit-criteria-group-v3.2"
    || response.assessment_request_id !== input.assessment_request_id
    || response.job_id !== input.job_id
    || response.vacancy_snapshot_hash !== input.vacancy_snapshot_hash
    || response.group_id !== groupId) throw new Error("Criterion group response does not match the frozen assessment request.");
  const expectedReferences = expectedUnits.map((unit) => unit.reference);
  if (!expectedUnits.length || new Set(expectedReferences).size !== expectedReferences.length
    || !Array.isArray(response.source_unit_references)
    || response.source_unit_references.length !== expectedReferences.length
    || response.source_unit_references.some((reference: unknown, index: number) => reference !== expectedReferences[index])) {
    throw new Error("Criterion group response does not cover its exact saved source units in order.");
  }
  if (!Array.isArray(response.results) || response.results.length !== expectedUnits.length) {
    throw new Error("Every saved source unit in this criterion group must have exactly one result.");
  }
  const results = new Map<string, CriterionUnitResponse>();
  for (let index = 0; index < expectedUnits.length; index += 1) {
    const raw = object(response.results[index]);
    exactKeys(raw, ["source_unit_reference", "disposition", "criteria", "reason"]);
    const unit = expectedUnits[index];
    if (raw.source_unit_reference !== unit.reference) throw new Error("Criterion group contains a missing, duplicate or out-of-order source reference.");
    if (raw.disposition === "duplicate") throw new Error("Grouped criterion preparation cannot discard a source as a cross-group duplicate.");
    const prepared = validateCriterionUnitResponse({
      schema_version: "job-fit-criteria-unit-v3.1",
      assessment_request_id: response.assessment_request_id,
      job_id: response.job_id,
      vacancy_snapshot_hash: response.vacancy_snapshot_hash,
      source_unit_reference: raw.source_unit_reference,
      disposition: raw.disposition,
      criteria: raw.criteria,
      duplicate_of_source_unit_reference: null,
      reason: raw.reason,
    }, input, unit);
    results.set(unit.reference, prepared);
  }
  return expectedReferences.map((reference) => results.get(reference)!);
}

export function validateCriterionUnitResponse(value: unknown, input: FitInput, unit: CriterionSourceUnit): CriterionUnitResponse {
  const response = object(value);
  exactKeys(response, ["schema_version", "assessment_request_id", "job_id", "vacancy_snapshot_hash", "source_unit_reference", "disposition", "criteria", "duplicate_of_source_unit_reference", "reason"]);
  if (response.schema_version !== "job-fit-criteria-unit-v3.1"
    || response.assessment_request_id !== input.assessment_request_id
    || response.job_id !== input.job_id
    || response.vacancy_snapshot_hash !== input.vacancy_snapshot_hash
    || response.source_unit_reference !== unit.reference) throw new Error("Criterion preparation does not match this frozen listing source.");
  if (!Array.isArray(response.criteria) || response.criteria.length > 30) throw new Error("Criterion preparation contains an invalid criterion list.");
  if (!["criteria", "duplicate", "non_requirement"].includes(response.disposition)) throw new Error("Criterion preparation has an unknown source disposition.");
  if (typeof response.reason !== "string" || !response.reason.trim() || response.reason.length > 1500) throw new Error("Every source unit needs a bounded explanation.");
  const units = new Map(input.criteria_source_units.map((candidate) => [candidate.reference, candidate]));
  if (response.disposition === "criteria") {
    if (!response.criteria.length || response.duplicate_of_source_unit_reference !== null) throw new Error("A source classified as criteria must contain criteria and no duplicate target.");
  } else if (response.criteria.length) throw new Error("Duplicate and non-requirement source units cannot silently add scoreable criteria.");
  if (response.disposition === "non_requirement" && ["essential_requirements", "desirable_requirements", "responsibilities"].includes(unit.source_field)) {
    throw new Error("A source already classified by the listing extractor as a requirement or responsibility cannot be discarded as general prose.");
  }
  if (response.disposition === "duplicate") {
    const target = units.get(response.duplicate_of_source_unit_reference);
    if (!target || target.reference === unit.reference || normalized(target.text) !== normalized(unit.text)) throw new Error("A duplicate source must point to an earlier exact duplicate source unit.");
  } else if (response.duplicate_of_source_unit_reference !== null) throw new Error("Only a duplicate source can name another source unit.");
  const seenText = new Set<string>();
  for (const raw of response.criteria) {
    const criterion = object(raw);
    exactKeys(criterion, ["text", "dimension", "importance"]);
    if (typeof criterion.text !== "string" || criterion.text.trim().length < 1 || criterion.text.length > 3000
      || !unit.text.includes(criterion.text)) throw new Error("Every criterion must be an exact non-empty text span from its saved source.");
    if (!DIMENSIONS.has(criterion.dimension) || !IMPORTANCE.has(criterion.importance)) throw new Error("Criterion preparation contains an unsupported dimension or importance.");
    const key = normalized(criterion.text);
    if (seenText.has(key)) throw new Error("Criterion preparation duplicated a criterion from one source unit.");
    seenText.add(key);
    if ((unit.importance === "essential" || unit.importance === "desirable") && criterion.importance !== unit.importance) {
      throw new Error("Structured essential/desirable requirement importance must be preserved exactly.");
    }
    if (unit.source_field === "responsibilities" && criterion.dimension !== "role_type") {
      throw new Error("Saved responsibilities must remain role-scope evidence, not be scored as technical requirements.");
    }
  }
  return response as CriterionUnitResponse;
}

/** Generate app-owned stable references only after validating exact model-selected spans. */
export function finalizePreparedCriteria(input: FitInput, values: CriterionUnitResponse[]): Criterion[] {
  const byReference = new Map(values.map((value) => [value.source_unit_reference, value]));
  if (byReference.size !== input.criteria_source_units.length || input.criteria_source_units.some((unit) => !byReference.has(unit.reference))) {
    throw new Error("Not every saved listing source unit has a persisted preparation result.");
  }
  const selected: Criterion[] = [];
  for (const unit of input.criteria_source_units) {
    const result = byReference.get(unit.reference)!;
    if (result.disposition !== "criteria") continue;
    result.criteria.forEach((value, spanIndex) => selected.push({
      reference: `requirement:${snapshotHash([input.job_snapshot_id, unit.reference, spanIndex, value.text])}`,
      text: value.text,
      importance: value.importance,
      dimension: value.dimension,
      source_field: unit.source_field,
    }));
  }
  // Repeated exact wording from structured extraction and the prose has one
  // scoring weight. Keep the strongest source importance and stable first ref.
  const unique = new Map<string, Criterion>();
  for (const criterion of selected) {
    const key = normalized(criterion.text);
    const prior = unique.get(key);
    if (!prior || importanceRank(criterion.importance) > importanceRank(prior.importance)) unique.set(key, criterion);
  }
  return [...unique.values()];
}
