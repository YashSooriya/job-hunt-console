import { ENGINE_VERSION, FIT_WEIGHTS, MATCH_VALUES, RESPONSE_VERSION, RUBRIC_VERSION, criterionWeight, round1, type BackgroundRecord, type Component, type CriterionFinding, type FitInput, type FitResponse, type FitResult, type SeniorityCalculation } from "./contract.ts";
import { employmentDays } from "./input.ts";

function object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object."); return value as Record<string, any>; }
function keys(value: Record<string, any>, expected: string[]) { if (Object.keys(value).length !== expected.length || expected.some(k => !(k in value)) || Object.keys(value).some(k => !expected.includes(k))) throw new Error("Assessment has missing or unexpected fields."); }
function nonempty(value: unknown, label: string, max = 3000): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a bounded non-empty string.`); }
function normal(value: string) { return value.replace(/\s+/g, " ").trim(); }
function textLeaves(value: unknown): string[] { if (typeof value === "string") return [value]; if (Array.isArray(value)) return value.flatMap(textLeaves); if (value && typeof value === "object") return Object.values(value).flatMap(textLeaves); return []; }
function validateEvidence(evidence: unknown, records: Map<string, BackgroundRecord>, required: boolean) {
  if (!Array.isArray(evidence) || evidence.length > 10 || (required && !evidence.length)) throw new Error("A positive match or conflict needs valid supporting evidence.");
  const seen = new Set<string>();
  for (const raw of evidence) {
    const item = object(raw); keys(item, ["reference", "quote"]);
    nonempty(item.reference, "Evidence reference", 200); nonempty(item.quote, "Evidence quote", 1500);
    const source = records.get(item.reference);
    if (!source || source.verification_status !== "verified" || seen.has(item.reference)) throw new Error("Evidence reference is duplicate, unverified or outside the frozen background.");
    if (!textLeaves(source.content).some(t => normal(t).includes(normal(item.quote)))) throw new Error(`Evidence quotation is not present in ${item.reference}.`);
    seen.add(item.reference);
  }
}
export function parseAssessmentResponse(raw: string): unknown {
  if (raw.length > 1000000) throw new Error("The assessment response exceeds the safe size limit.");
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try { return object(JSON.parse(candidate)); } catch { throw new Error("ChatGPT's assessment was not one valid JSON object. The original message was not resent."); }
}
export function validateAssessmentResponse(value: unknown, input: FitInput): FitResponse {
  const response = object(value);
  keys(response, ["schema_version", "assessment_request_id", "job_id", "profile_snapshot_hash", "vacancy_snapshot_hash", "rubric_version", "criteria", "dimension_applicability", "eligibility_findings", "summary", "limitations"]);
  for (const [key, expected] of Object.entries({ schema_version: RESPONSE_VERSION, assessment_request_id: input.assessment_request_id, job_id: input.job_id, profile_snapshot_hash: input.profile_snapshot_hash, vacancy_snapshot_hash: input.vacancy_snapshot_hash, rubric_version: RUBRIC_VERSION })) if (response[key] !== expected) throw new Error(`Assessment ${key} does not match the frozen request.`);
  const records = new Map(input.candidate_background.map(r => [r.reference, r]));
  const criteria = new Map(input.criteria.map(c => [c.reference, c]));
  if (!Array.isArray(response.criteria) || response.criteria.length !== criteria.size) throw new Error("Every criterion must be assessed exactly once.");
  const seen = new Set<string>();
  for (const raw of response.criteria) {
    const finding = object(raw); keys(finding, ["requirement_reference", "match", "evidence", "explanation"]);
    if (!criteria.has(finding.requirement_reference) || seen.has(finding.requirement_reference)) throw new Error("Assessment contains an unknown or duplicate criterion.");
    if (!Object.hasOwn(MATCH_VALUES, finding.match)) throw new Error("Unknown assessment match category.");
    nonempty(finding.explanation, "Criterion explanation");
    validateEvidence(finding.evidence, records, !["not_evidenced", "not_assessable"].includes(finding.match));
    seen.add(finding.requirement_reference);
  }
  const applicability = object(response.dimension_applicability); keys(applicability, ["seniority", "domain", "qualification"]);
  for (const dimension of ["seniority", "domain", "qualification"]) {
    const expected = input.criteria.some(c => c.dimension === dimension) ? "applicable" : "not_specified";
    if (applicability[dimension] !== expected) throw new Error(`The listing's ${dimension} criteria cannot be silently excluded.`);
  }
  const eligibilityCriteria = input.criteria.filter(c => c.dimension === "eligibility");
  if (!Array.isArray(response.eligibility_findings) || response.eligibility_findings.length !== eligibilityCriteria.length) throw new Error("Every eligibility condition needs a separate finding.");
  const eligibilitySeen = new Set<string>();
  for (const raw of response.eligibility_findings) {
    const finding = object(raw); keys(finding, ["requirement_reference", "state", "evidence", "explanation"]);
    if (!eligibilityCriteria.some(c => c.reference === finding.requirement_reference) || eligibilitySeen.has(finding.requirement_reference)) throw new Error("Unknown or duplicate eligibility condition.");
    if (!["confirmed_eligible", "confirmed_conflict", "needs_confirmation"].includes(finding.state)) throw new Error("Unknown eligibility state.");
    nonempty(finding.explanation, "Eligibility explanation");
    validateEvidence(finding.evidence, records, finding.state !== "needs_confirmation");
    // Legal eligibility can only be established from explicit approved facts/credentials, not inferred from skills or past employers.
    if (finding.state !== "needs_confirmation" && finding.evidence.some((e: any) => !["fact", "certification"].includes(records.get(e.reference)!.record_type))) throw new Error("Eligibility requires explicit verified authorisation or credential facts.");
    const matching = response.criteria.find((f: any) => f.requirement_reference === finding.requirement_reference);
    if (finding.state === "confirmed_conflict" && matching.match !== "conflict") throw new Error("Eligibility conflict contradicts its criterion finding.");
    if (finding.state === "confirmed_eligible" && matching.match !== "direct") throw new Error("Confirmed eligibility requires a directly supported criterion finding.");
    if (finding.state === "needs_confirmation" && !["not_assessable", "not_evidenced"].includes(matching.match)) throw new Error("Unconfirmed eligibility cannot be scored as demonstrated.");
    if (finding.state !== "needs_confirmation") {
      const condition = criteria.get(finding.requirement_reference)!.text;
      const clearance = /clearance|BPSS|security check/i.test(condition);
      const allowedFacts = clearance ? ["security_clearance", "clearance", "certifications"] : ["work_authorisation", "right_to_work_countries", "visa_status", "visa_expiry"];
      if (finding.evidence.some((e: any) => { const record = records.get(e.reference)!; return record.record_type === "fact" && !allowedFacts.includes(String(record.content.fact_key)); })) throw new Error("The eligibility fact is not an explicit authorisation or clearance fact.");
    }
    eligibilitySeen.add(finding.requirement_reference);
  }
  nonempty(response.summary, "Assessment summary", 5000);
  if (!Array.isArray(response.limitations) || response.limitations.length > 100 || response.limitations.some((s: unknown) => typeof s !== "string" || s.length > 2000)) throw new Error("Invalid assessment limitations.");
  return response as FitResponse;
}
function requiredExperienceYears(text: string) {
  const match = text.match(/(?:at\s+least\s+|minimum(?:\s+of)?\s+|more\s+than\s+|over\s+)?(\d{1,2})\s*(?:\+|plus)?\s+years?\b/i);
  return match ? Number(match[1]) : null;
}
export function calculateAssessment(input: FitInput, response: FitResponse, assessmentAsOf = new Date()): FitResult {
  // Revalidate at every persistence boundary, even if an upstream caller validated already.
  validateAssessmentResponse(response, input);
  if (!Number.isFinite(assessmentAsOf.getTime())) throw new Error("The frozen assessment date is invalid.");
  const findings = new Map(response.criteria.map(f => [f.requirement_reference, f]));
  const sources = new Map(input.candidate_background.map(r => [r.reference, r]));
  const components = {} as FitResult["components"];
  for (const dimension of ["technical", "seniority", "domain", "role_type", "qualification"] as const) {
    const selected = input.criteria.filter(c => c.dimension === dimension);
    let component: Component;
    if (!selected.length) component = { score: null, state: "not_specified", explanation: "The listing does not state a criterion for this dimension." };
    else if (selected.some(c => findings.get(c.reference)!.match === "not_assessable")) component = { score: null, state: "cannot_assess", explanation: "Required information is missing or ambiguous; see criterion explanations." };
    else {
      const totalWeight = selected.reduce((sum, c) => sum + criterionWeight(c), 0);
      component = { score: round1(selected.reduce((sum, c) => sum + MATCH_VALUES[findings.get(c.reference)!.match]! * criterionWeight(c), 0) / totalWeight), state: "assessed", explanation: `${selected.length} criterion${selected.length === 1 ? "" : "s"} assessed against the verified background; essential requirements carry twice the weight.` };
    }
    components[dimension] = component;
  }
  const supported = input.criteria.filter(c => c.dimension !== "eligibility");
  components.evidence = { score: null, state: "cannot_assess", explanation: "Evidence support cannot be completed while relevant criteria remain unassessable." };
  if (supported.length && supported.every(c => findings.get(c.reference)!.match !== "not_assessable")) {
    const weight = supported.reduce((sum, c) => sum + criterionWeight(c), 0);
    const strength = supported.reduce((sum, c) => {
      const finding = findings.get(c.reference)!;
      const factor = Math.max(0, ...finding.evidence.map(e => { const r = sources.get(e.reference)!; return r.record_type === "skill" || (r.record_type === "fact" && !["degree", "qualifications", "certifications", "professional_registration"].includes(String(r.content.fact_key))) ? 0.5 : 1; }));
      return sum + criterionWeight(c) * (MATCH_VALUES[finding.match]! / 100) * factor;
    }, 0);
    components.evidence = { score: round1(100 * strength / weight), state: "assessed", explanation: "Weighted supported capability; standalone skills and general facts contribute half the support of substantive activity or credential records." };
  }
  const seniorityCalculations: SeniorityCalculation[] = [];
  for (const criterion of input.criteria.filter(c => c.dimension === "seniority")) {
    const requiredYears = requiredExperienceYears(criterion.text);
    if (requiredYears === null) continue;
    const finding = findings.get(criterion.reference)!;
    const employmentReferences = finding.evidence.map(e => e.reference).filter(reference => sources.get(reference)?.record_type === "employment");
    if (!employmentReferences.length && finding.match === "direct") {
      throw new Error("A direct years-of-experience match must cite verified employment records with usable dates.");
    }
    if (!employmentReferences.length) continue;
    const citedEmployment = employmentReferences.map(reference => sources.get(reference)!);
    const establishedDays = employmentDays(citedEmployment, assessmentAsOf);
    const requiredDays = Math.ceil(requiredYears * 365.2425);
    const established = establishedDays === null ? null : establishedDays >= requiredDays;
    if (finding.match === "direct" && established !== true) {
      throw new Error("A direct years-of-experience match is not supported by the cited verified employment intervals.");
    }
    seniorityCalculations.push({
      requirement_reference: criterion.reference,
      cited_employment_references: employmentReferences,
      assessment_as_of: assessmentAsOf.toISOString(),
      established_days: establishedDays === null ? null : round1(establishedDays),
      required_years: requiredYears,
      required_days: requiredDays,
      established,
    });
  }
  const applicable = Object.entries(FIT_WEIGHTS).filter(([key]) => components[key as keyof typeof FIT_WEIGHTS].state !== "not_specified");
  const applicableWeight = applicable.reduce((sum, [, weight]) => sum + weight, 0);
  // Technical capability, actual evidence support, and role fit are always
  // required. Missing technical or role criteria must not disappear from the
  // denominator and turn a thin advert into an apparently complete score.
  const requiredComponents: Array<keyof typeof FIT_WEIGHTS> = ["technical", "evidence", "role_type"];
  const complete = requiredComponents.every(key => components[key].state === "assessed")
    && applicable.every(([key]) => components[key as keyof typeof FIT_WEIGHTS].state === "assessed");
  const score = complete ? round1(applicable.reduce((sum, [key, weight]) => sum + components[key as keyof typeof FIT_WEIGHTS].score! * weight, 0) / applicableWeight) : null;
  const eligibility = response.eligibility_findings.some(f => f.state === "confirmed_conflict") ? "confirmed_conflict" : response.eligibility_findings.some(f => f.state === "needs_confirmation") ? "needs_confirmation" : response.eligibility_findings.length ? "confirmed_eligible" : "no_condition_identified";
  return { engine_version: ENGINE_VERSION, rubric_version: RUBRIC_VERSION, completeness: complete ? "complete" : "partial", fit_score: score, applicable_weight: applicableWeight, components, criteria: response.criteria as CriterionFinding[], summary: response.summary, limitations: response.limitations, eligibility, eligibility_findings: response.eligibility_findings, seniority_calculations: seniorityCalculations };
}
