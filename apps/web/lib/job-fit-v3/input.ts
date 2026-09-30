import { createHash } from "node:crypto";
import { INPUT_VERSION, RUBRIC_VERSION, type BackgroundRecord, type Criterion, type CriterionSourceUnit, type Dimension, type FitInput, type RecordType, type Vacancy } from "./contract.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.trim() : value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
}
export function snapshotHash(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
const FACT_KEYS = new Set(["qualifications", "degree", "certifications", "work_authorisation", "right_to_work_countries", "visa_status", "visa_expiry", "sponsorship_requirement", "security_clearance", "clearance", "professional_registration", "notice_period", "availability_date"]);
const FIELDS: Record<RecordType, string[]> = {
  employment: ["employer", "role_title", "start_date", "end_date", "current", "details"],
  education: ["institution", "qualification", "field_of_study", "grade", "start_date", "end_date", "details"],
  skill: ["name", "category", "proficiency", "years_experience", "details"],
  project: ["title", "start_date", "end_date", "details", "description", "technologies", "url"],
  publication: ["title", "publication_type", "venue", "published_on", "citation", "url"],
  certification: ["name", "issuer", "issued_on", "expires_on", "details"],
  fact: ["fact_key", "value_json"], evidence: ["evidence_key", "category", "claim", "detail", "tags", "source_locator"],
};
export function buildBackground(tables: Partial<Record<RecordType, Array<Record<string, unknown>>>>): BackgroundRecord[] {
  const records: BackgroundRecord[] = [];
  for (const [type, rows] of Object.entries(tables) as Array<[RecordType, Array<Record<string, unknown>>]>) {
    for (const row of rows) {
      if (row.verification_status !== "verified" || typeof row.id !== "string" || !row.id) continue;
      if (type === "fact" && !FACT_KEYS.has(String(row.fact_key))) continue;
      const content = Object.fromEntries(FIELDS[type].filter(k => row[k] !== undefined && row[k] !== null && row[k] !== "").map(k => [k, canonical(row[k])]));
      if (type === "project" && !content.details && typeof content.description === "string") content.details = content.description;
      if (!Object.keys(content).length) continue;
      records.push({ reference: `${type}:${row.id}`, record_type: type, source_record_id: row.id, verification_status: "verified", content, source_reference: typeof row.source_id === "string" ? row.source_id : null });
    }
  }
  const unique = new Map(records.map(r => [r.reference, r]));
  if (unique.size !== records.length) throw new Error("Duplicate professional-background references.");
  return records.sort((a, b) => a.reference.localeCompare(b.reference));
}
export function backgroundReady(records: BackgroundRecord[]) { return records.some(r => r.record_type !== "fact" && Object.values(r.content).some(v => typeof v === "string" ? Boolean(v.trim()) : Array.isArray(v) ? v.length > 0 : v != null)); }
export function classifyDimension(text: string, source: string): Dimension {
  if (/\b(right to work|work authori[sz]ation|visa|sponsorship|citizenship|clearance|BPSS)\b/i.test(text)) return "eligibility";
  if (/\b(degree|Ph\.?D|doctorate|master'?s|bachelor|qualification|chartered|accredit|registration)\b/i.test(text)) return "qualification";
  if (/\b(\d+\+? years|senior|junior|graduate|principal|staff|leadership|manage a team|lead a team|independently|independent work)\b/i.test(text)) return "seniority";
  if (/\b(industry experience|sector experience|domain knowledge|regulatory|plasma physics|motorsport experience|medical device|Maxwell|electromagnetic wave)\b/i.test(text)) return "domain";
  if (source === "responsibilities") return "role_type";
  return "technical";
}
export function buildCriteriaSourceUnits(vacancy: Vacancy, snapshotId: string): CriterionSourceUnit[] {
  const entries: Array<[string, Criterion["importance"], string[]]> = [
    ["essential_requirements", "essential", vacancy.essential_requirements || []],
    ["desirable_requirements", "desirable", vacancy.desirable_requirements || []],
    ["responsibilities", "responsibility", vacancy.responsibilities || []],
    ["skills", "context", vacancy.skills || []],
  ];
  const paragraphs = vacancy.description.split(/\n\s*\n+/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!paragraphs.length && vacancy.description.trim()) paragraphs.push(vacancy.description.replace(/\s+/g, " ").trim());
  entries.push(["description", "context", paragraphs]);
  const units: CriterionSourceUnit[] = [];
  for (const [sourceField, importance, texts] of entries) texts.forEach((raw, sourceIndex) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    units.push({
      reference: `source:${snapshotHash([snapshotId, sourceField, sourceIndex, text])}`,
      text,
      importance,
      source_field: sourceField,
      source_index: sourceIndex,
    });
  });
  return units;
}
/** No length/count filter: full extracted requirements take precedence over summary parsing. */
export function buildCriteria(vacancy: Vacancy, snapshotId: string): Criterion[] {
  const sourceUnits = buildCriteriaSourceUnits(vacancy, snapshotId);
  const seen = new Set<string>();
  const result: Criterion[] = [];
  for (const unit of sourceUnits) {
    const { text, source_field: source, importance } = unit;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ reference: `requirement:${snapshotHash([snapshotId, source, key])}`, text, importance, dimension: classifyDimension(text, source), source_field: source });
  }
  // The advertised description is also the task/scope source when no separate responsibilities were extracted.
  if (!result.some(c => c.dimension === "role_type") && vacancy.description.trim()) {
    const text = vacancy.description.replace(/\s+/g, " ").trim();
    result.push({ reference: `requirement:${snapshotHash([snapshotId, "role_scope", text])}`, text, importance: "responsibility", dimension: "role_type", source_field: "role_scope" });
  }
  return result;
}
export function buildFitInput(args: { requestId: string; jobId: string; snapshotId: string; jobRevision: number; profileId: string; profileRevision: number; background: BackgroundRecord[]; vacancy: Vacancy }): FitInput {
  if (!backgroundReady(args.background)) throw new Error("Add or confirm your professional background before analysing jobs.");
  if (!args.vacancy.title.trim() || !args.vacancy.company.trim() || args.vacancy.description.trim().length < 40) throw new Error("This listing needs a complete saved job description before it can be assessed.");
  const background = [...args.background].sort((a, b) => a.reference.localeCompare(b.reference));
  const criteria = buildCriteria(args.vacancy, args.snapshotId);
  const criteriaSourceUnits = buildCriteriaSourceUnits(args.vacancy, args.snapshotId);
  return { schema_version: INPUT_VERSION, assessment_request_id: args.requestId, job_id: args.jobId, job_snapshot_id: args.snapshotId, job_revision: args.jobRevision, profile_id: args.profileId, profile_revision: args.profileRevision, profile_snapshot_hash: snapshotHash(background), vacancy_snapshot_hash: snapshotHash(args.vacancy), rubric_version: RUBRIC_VERSION, candidate_background: background, vacancy: args.vacancy, criteria_source_units: criteriaSourceUnits, criteria };
}
export function semanticKey(userId: string, input: FitInput, preferences: Record<string, unknown> = {}) {
  // Semantic suitability is independent of user preferences, execution
  // revisions and time-dependent listing metadata. Those affect the current
  // recommendation readout, not whether ChatGPT needs to reassess the fit.
  void preferences;
  const v = input.vacancy;
  const semanticVacancy = {
    title: v.title,
    industry: v.industry ?? null,
    description: v.description,
    summary: v.summary ?? null,
    responsibilities: v.responsibilities ?? [],
    essential_requirements: v.essential_requirements ?? [],
    desirable_requirements: v.desirable_requirements ?? [],
    skills: v.skills ?? [],
    employment_type: v.employment_type ?? null,
  };
  return snapshotHash([
    userId,
    input.profile_snapshot_hash,
    snapshotHash(semanticVacancy),
    input.schema_version,
    input.rubric_version,
  ]);
}
/** Merge overlapping intervals; do not turn education into employment experience. */
export function employmentDays(records: BackgroundRecord[], asOf: Date): number | null {
  const intervals: Array<[number, number]> = [];
  for (const r of records.filter(r => r.record_type === "employment")) {
    const start = Date.parse(String(r.content.start_date || ""));
    const end = r.content.current === true ? asOf.getTime() : Date.parse(String(r.content.end_date || ""));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start > asOf.getTime()) return null;
    intervals.push([start, Math.min(end, asOf.getTime())]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const item of intervals) { const last = merged.at(-1); if (last && item[0] <= last[1]) last[1] = Math.max(last[1], item[1]); else merged.push([...item]); }
  return merged.reduce((sum, [s, e]) => sum + Math.max(0, e - s), 0) / 86400000;
}
