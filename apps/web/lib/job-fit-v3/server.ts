import { MATCH_VALUES, type FitInput, type FitResult, type Vacancy } from "./contract.ts";
import { buildBackground, buildFitInput, semanticKey, snapshotHash } from "./input.ts";
import { buildInitialAssessmentSteps } from "./prompt.ts";
import { priorityAndRecommendation } from "./priority.ts";

const FACT_KEYS = ["qualifications", "degree", "certifications", "work_authorisation", "right_to_work_countries", "visa_status", "visa_expiry", "sponsorship_requirement", "security_clearance", "clearance", "professional_registration", "notice_period", "availability_date"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATCH_LABELS: Record<string, string> = {
  direct: "Direct match", strong_transfer: "Strong transferable match", partial: "Partial match",
  weak_transfer: "Weak transferable match", not_evidenced: "Not evidenced", conflict: "Explicit conflict", not_assessable: "Needs more information",
};

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function array(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []; }
function nullableText(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function period(value: unknown): Vacancy["salary_period"] {
  const normalized = String(value || "").toLowerCase().trim();
  return ["annual", "monthly", "weekly", "daily", "hourly"].includes(normalized) ? normalized as Vacancy["salary_period"] : "unknown";
}
function numeric(value: unknown): number | null { const n = Number(value); return value === null || value === undefined || value === "" || !Number.isFinite(n) ? null : n; }

/** Loads only owner-scoped, verified background rows used in the frozen assessment. */
export async function loadVerifiedBackground(supabase: any, profileId: string) {
  const [facts, evidence, employment, education, skills, projects, publications, preferenceRow] = await Promise.all([
    // candidate_facts has source_note, not a source_id foreign key. Keep this
    // selection aligned with the deployed schema; verified fact IDs themselves
    // remain the stable, exact evidence references used by the assessment.
    supabase.from("candidate_facts").select("id,fact_key,value_json,verification_status").eq("profile_id", profileId).in("fact_key", FACT_KEYS),
    supabase.from("evidence_items").select("id,evidence_key,category,claim,detail,tags,source_locator,verification_status,source_id").eq("profile_id", profileId).eq("verification_status", "verified"),
    supabase.from("candidate_employment").select("*").eq("profile_id", profileId).eq("verification_status", "verified"),
    supabase.from("candidate_education").select("*").eq("profile_id", profileId).eq("verification_status", "verified"),
    supabase.from("candidate_skills").select("*").eq("profile_id", profileId).eq("verification_status", "verified"),
    supabase.from("candidate_projects").select("*").eq("profile_id", profileId).eq("verification_status", "verified"),
    supabase.from("candidate_publications").select("*").eq("profile_id", profileId).eq("verification_status", "verified"),
    supabase.from("candidate_preferences").select("preferences").eq("profile_id", profileId).maybeSingle(),
  ]);
  for (const result of [facts, evidence, employment, education, skills, projects, publications, preferenceRow]) if (result.error) throw result.error;
  const background = buildBackground({
    fact: facts.data || [], evidence: evidence.data || [], employment: employment.data || [], education: education.data || [],
    skill: skills.data || [], project: projects.data || [], publication: publications.data || [],
  });
  return { background, preferences: object(preferenceRow.data?.preferences) };
}

/** Reads an exact current saved snapshot rather than reconstructing an advert from a URL. */
export async function loadVacancies(supabase: any, userId: string, jobIds: string[]) {
  const { data: jobs, error: jobsError } = await supabase.from("jobs").select(`
    id,user_id,title,industry,external_job_id,source_url,application_url,location_text,work_mode,salary_text,
    salary_min,salary_max,salary_currency,posted_at,closes_at,employment_type,analysis_revision,current_snapshot_id,
    archived_at,triage,companies(canonical_name)
  `).eq("user_id", userId).in("id", jobIds);
  if (jobsError) throw jobsError;
  if (!jobs || jobs.length !== jobIds.length) throw new Error("One or more selected jobs are no longer available in your pool.");
  const snapshotIds = jobs.map((job: any) => job.current_snapshot_id).filter(Boolean);
  const [{ data: snapshots, error: snapshotError }, { data: requirements, error: requirementsError }] = await Promise.all([
    snapshotIds.length ? supabase.from("job_snapshots").select("id,job_id,captured_at,title,company_name,description_text,source_url,raw_metadata").in("id", snapshotIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("job_requirements").select("job_id,requirement_text,requirement_type,category").in("job_id", jobIds).is("analysis_id", null),
  ]);
  if (snapshotError) throw snapshotError;
  if (requirementsError) throw requirementsError;
  const snapshotsById = new Map((snapshots || []).map((item: any) => [item.id, item]));
  return jobs.map((job: any) => {
    if (!job.current_snapshot_id || !snapshotsById.has(job.current_snapshot_id)) throw new Error(`The saved listing “${job.title}” has no current frozen snapshot.`);
    const snapshot: any = snapshotsById.get(job.current_snapshot_id);
    const extraction = object(snapshot.raw_metadata?.listing_extraction);
    const fallbackRequirements = (requirements || []).filter((item: any) => item.job_id === job.id);
    const relation = Array.isArray(job.companies) ? job.companies[0] : job.companies;
    const textByType = (type: string) => fallbackRequirements.filter((item: any) => item.requirement_type === type).map((item: any) => item.requirement_text);
    const salaryPeriod = period(extraction.salary_period ?? extraction.salaryPeriod);
    const vacancy: Vacancy = {
      title: String(job.title || snapshot.title || "").trim(),
      company: String(relation?.canonical_name || snapshot.company_name || "Unknown company").trim(),
      description: String(snapshot.description_text || ""),
      summary: nullableText(extraction.summary),
      industry: nullableText(job.industry || extraction.industry),
      responsibilities: array(extraction.responsibilities),
      essential_requirements: array(extraction.essential_requirements || extraction.requirements).length ? array(extraction.essential_requirements || extraction.requirements) : textByType("essential"),
      desirable_requirements: array(extraction.desirable_requirements).length ? array(extraction.desirable_requirements) : textByType("desirable"),
      skills: array(extraction.skills),
      location: nullableText(job.location_text),
      work_mode: nullableText(job.work_mode),
      employment_type: nullableText(job.employment_type),
      application_instructions: nullableText(extraction.application_instructions),
      salary_min: numeric(job.salary_min),
      salary_max: numeric(job.salary_max),
      salary_currency: String(job.salary_currency || "GBP"),
      salary_period: salaryPeriod,
      salary_hours_per_week: numeric(extraction.salary_hours_per_week ?? extraction.hours_per_week),
      salary_days_per_week: numeric(extraction.salary_days_per_week ?? extraction.days_per_week),
      salary_source: extraction.salary_source === "advertised" || extraction.salary_source === "chatgpt_estimate" ? extraction.salary_source : job.salary_text || job.salary_min != null || job.salary_max != null ? "advertised" : "not_available",
      salary_confidence: nullableText(extraction.salary_confidence),
      salary_text: nullableText(job.salary_text),
      salary_basis: array(extraction.salary_basis),
      posted_at: nullableText(job.posted_at),
      closes_at: nullableText(job.closes_at),
      source_url: nullableText(job.source_url),
    };
    return { job, snapshot, vacancy };
  });
}

export function makeTaskSpec(args: {
  userId: string; requestId: string; job: Record<string, any>; snapshot: Record<string, any>;
  vacancy: Vacancy; profile: Record<string, any>; testingMode: boolean; assessmentAsOf: Date;
}) {
  const assessmentRequestId = `${args.requestId}:${args.job.id}`;
  const input: FitInput = buildFitInput({
    requestId: assessmentRequestId, jobId: args.job.id, snapshotId: args.snapshot.id,
    jobRevision: Number(args.job.analysis_revision), profileId: args.profile.id,
    profileRevision: Number(args.profile.analysis_revision), background: args.profile.background, vacancy: args.vacancy,
  });
  const steps = buildInitialAssessmentSteps(input, args.testingMode);
  return {
    job_id: args.job.id,
    assessment_request_id: assessmentRequestId,
    semantic_key: semanticKey(args.userId, input),
    input_hash: snapshotHash(input),
    job_revision: Number(args.job.analysis_revision),
    profile_revision: Number(args.profile.analysis_revision),
    assessment_as_of: args.assessmentAsOf.toISOString(),
    testing_mode: args.testingMode,
    input_payload: { fit_input: input, priority_preferences: args.profile.preferences },
    steps,
  };
}

function uuidEvidence(ids: string[]) { return [...new Set(ids.filter((id) => UUID.test(id)))]; }
function cvFamily(text: string): string {
  const value = text.toLowerCase();
  if (/formula\s*1|formula one|motorsport|race car|racing/.test(value)) return "motorsport";
  if (/data scientist|statistics|quantitative|machine learning|analytics|financial modelling/.test(value)) return "quantitative_data";
  if (/software engineer|software developer|scientific software|python developer|c\+\+/.test(value)) return "scientific_software";
  return "simulation_cae";
}

/** Convert model labels to the legacy database columns used by application preparation. */
export function buildPersistencePayload(input: FitInput, result: FitResult, preferences: Record<string, unknown>, asOf: Date) {
  const priority = priorityAndRecommendation(result, input.vacancy, preferences, asOf);
  const category = priority.recommendation;
  const triage = category === "Recommended" ? "recommend" : category === "Worth reviewing" || category === "Needs information" ? "maybe" : "reject";
  const eligibility = result.eligibility === "confirmed_conflict" ? "ineligible" : result.eligibility === "confirmed_eligible" ? "eligible" : "unknown";
  const analysisText = `${input.vacancy.title} ${input.vacancy.description}`;
  const evidenceIds = uuidEvidence(result.criteria.flatMap((finding) => finding.evidence.map((item) => item.reference.split(":").slice(1).join(":"))));
  const positive = result.criteria.filter((finding) => ["direct", "strong_transfer"].includes(finding.match) && finding.evidence.length);
  const gaps = result.criteria.filter((finding) => ["partial", "weak_transfer", "not_evidenced", "conflict", "not_assessable"].includes(finding.match));
  const analysis = {
    fit_score: result.fit_score,
    priority_score: priority.priority_score,
    fit_components: Object.fromEntries(Object.entries(result.components).map(([key, component]) => [key, component.score])),
    fit_component_details: result.components,
    semantic_eligibility: result.eligibility,
    seniority_calculations: result.seniority_calculations,
    priority_components: priority.components,
    eligibility,
    eligibility_notes: result.eligibility_findings.filter((item) => item.state !== "confirmed_eligible").map((item) => item.explanation),
    recommended_cv_family: cvFamily(analysisText),
    strengths: positive.slice(0, 12).map((finding) => ({ description: finding.explanation, evidenceIds: uuidEvidence(finding.evidence.map((item) => item.reference.split(":").slice(1).join(":"))) })),
    weaknesses: gaps.slice(0, 20).map((finding) => ({ description: finding.explanation, severity: finding.match === "conflict" || finding.match === "not_assessable" ? "high" : finding.match === "not_evidenced" ? "medium" : "low" })),
    application_strategy: result.summary,
    cover_letter_value: /no cover letter|do not (?:send|include) a cover letter|cover letters? (?:are )?not accepted/i.test(input.vacancy.application_instructions || "") ? "not_accepted" : /cover letter|supporting statement/i.test(input.vacancy.application_instructions || "") ? "high" : "medium",
    evidence_item_ids: evidenceIds,
    triage,
    triage_reason: category,
  };
  const findingByReference = new Map(result.criteria.map((finding) => [finding.requirement_reference, finding]));
  const requirements = input.criteria.map((criterion) => {
    const finding = findingByReference.get(criterion.reference)!;
    const type = criterion.dimension === "eligibility" ? "eligibility" : criterion.importance === "essential" ? "essential" : criterion.importance === "desirable" ? "desirable" : "context";
    return {
      requirement_text: criterion.text,
      requirement_type: type,
      category: criterion.dimension,
      evidence_item_ids: uuidEvidence(finding.evidence.map((item) => item.reference.split(":").slice(1).join(":"))),
      match_score: MATCH_VALUES[finding.match],
      analysis_reference: criterion.reference,
      match_label: MATCH_LABELS[finding.match],
      evidence_quotes: finding.evidence,
      match_explanation: finding.explanation,
    };
  });
  return { assessment: result, priority, analysis, requirements };
}

export function isCurrentV3Analysis(analysis: Record<string, any> | null, jobRevision: number, profileRevision: number) {
  return Boolean(analysis?.engine_version === "job-fit-v3"
    && Number(analysis.job_revision) === jobRevision && Number(analysis.profile_revision) === profileRevision
    && /^[0-9a-f]{64}$/.test(String(analysis.input_hash || "")) && analysis.assessment_as_of);
}
