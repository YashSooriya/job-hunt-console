import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { analyseJob, createJobDedupeKey, hashJobAnalysisInput, JOB_ANALYSIS_ENGINE_VERSION, type JobInput } from "@jobhunt/job-intelligence";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { getCandidateProfile } from "@/lib/data/repository";
import { saveLocalJob } from "@/lib/data/local";
import type { CandidateProfileData, JobRecord } from "@/lib/types";
import { recordJobPoolSheetSyncInBackground } from "@/lib/google-job-pool-sheet";

function cleanText(value: unknown, max = 20000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function nullable(value: unknown, max = 4000) {
  const text = cleanText(value, max);
  return text || null;
}
function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function nullableIso(value: unknown) {
  const text = nullable(value, 100);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function nullableUrl(value: unknown, max = 4000) {
  const text = nullable(value, max);
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Source and application URLs must be complete http(s) URLs."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Source and application URLs must be complete http(s) URLs.");
  url.hash = "";
  return url.toString();
}
function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseInput(raw: any): JobInput {
  const company = cleanText(raw?.company, 300);
  const title = cleanText(raw?.title, 500);
  const description = cleanText(raw?.description, 60000);
  if (!company || !title || description.length < 40) throw new Error("Company, role title, and a meaningful job description are required.");
  const salaryMin = nullableNumber(raw.salaryMin);
  const salaryMax = nullableNumber(raw.salaryMax);
  if (salaryMin !== null && salaryMax !== null && salaryMax < salaryMin) throw new Error("Salary maximum cannot be below salary minimum.");
  const postedAt = nullableIso(raw.postedAt);
  const closesAt = nullableIso(raw.closesAt);
  if (postedAt && closesAt && Date.parse(closesAt) < Date.parse(postedAt)) throw new Error("Closing date cannot be before the posted date.");
  return {
    company,
    title,
    industry: nullable(raw.industry, 300),
    description,
    externalJobId: nullable(raw.externalJobId, 300),
    sourceUrl: nullableUrl(raw.sourceUrl),
    applicationUrl: nullableUrl(raw.applicationUrl),
    location: nullable(raw.location, 500),
    workMode: nullable(raw.workMode, 200),
    salaryText: nullable(raw.salaryText, 500),
    salaryMin,
    salaryMax,
    salaryCurrency: nullable(raw.salaryCurrency, 20) || "GBP",
    postedAt,
    closesAt,
    employmentType: nullable(raw.employmentType, 200),
    atsProvider: nullable(raw.atsProvider, 200),
    discoverySource: "manual",
  };
}

function localRecord(input: JobInput, profile: CandidateProfileData): JobRecord {
  const assessmentAsOf = new Date();
  const analysis = analyseJob(input, profile, assessmentAsOf);
  return {
    id: randomUUID(),
    company: input.company,
    title: input.title,
    industry: input.industry || null,
    externalJobId: input.externalJobId || null,
    sourceUrl: input.sourceUrl || null,
    applicationUrl: input.applicationUrl || null,
    location: input.location || null,
    workMode: input.workMode || null,
    salaryText: input.salaryText || null,
    salaryMin: input.salaryMin ?? null,
    salaryMax: input.salaryMax ?? null,
    salaryCurrency: input.salaryCurrency || "GBP",
    salarySource: input.salaryText || input.salaryMin != null || input.salaryMax != null ? "advertised" : "not_available",
    salaryConfidence: null,
    salaryBasis: [],
    postedAt: input.postedAt || null,
    closesAt: input.closesAt || null,
    employmentType: input.employmentType || null,
    atsProvider: input.atsProvider || null,
    discoverySource: input.discoverySource || "manual",
    dedupeKey: createJobDedupeKey(input),
    discoveredAt: new Date().toISOString(),
    triage: analysis.triage,
    triageReason: analysis.triageReason,
    description: input.description,
    snapshotCapturedAt: new Date().toISOString(),
    listingSummary: null,
    responsibilities: [],
    extractedRequirements: [],
    desirableRequirements: [],
    skills: [],
    benefits: [],
    applicationInstructions: null,
    listingExtractionSource: "manual",
    listingExtractedAt: null,
    analysis: {
      ...analysis,
      contractVersion: analysis.contractVersion,
      analysisSource: analysis.analysisSource,
      recommendedCvFamily: analysis.recommendedCvFamily,
      applicationStrategy: analysis.applicationStrategy,
      coverLetterValue: analysis.coverLetterValue,
      createdAt: new Date().toISOString(),
    },
    requirements: analysis.requirements.map((item) => ({
      text: item.text,
      type: item.type,
      category: item.category,
      matchScore: item.matchScore,
      evidenceIds: item.evidenceIds,
    })),
  };
}

async function persistSupabase(input: JobInput, profile: CandidateProfileData) {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user?.email) throw new Error("AUTH_REQUIRED");
  const user = userData.user;

  const assessmentAsOf = new Date();
  const analysis = analyseJob(input, profile, assessmentAsOf);
  const dedupeKey = createJobDedupeKey(input);
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .upsert({ user_id: user.id, canonical_name: input.company }, { onConflict: "user_id,canonical_name" })
    .select("id")
    .single();
  if (companyError) throw companyError;

  const existing = await supabase
    .from("jobs")
    .select("id,discovered_at")
    .eq("user_id", user.id)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (existing.error) throw existing.error;

  const jobValues = {
    user_id: user.id,
    company_id: company.id,
    title: input.title,
    industry: input.industry || null,
    external_job_id: input.externalJobId || null,
    source_url: input.sourceUrl || null,
    application_url: input.applicationUrl || null,
    location_text: input.location || null,
    work_mode: input.workMode || null,
    salary_text: input.salaryText || null,
    salary_min: input.salaryMin ?? null,
    salary_max: input.salaryMax ?? null,
    salary_currency: input.salaryCurrency || "GBP",
    posted_at: input.postedAt || null,
    closes_at: input.closesAt || null,
    employment_type: input.employmentType || null,
    ats_provider: input.atsProvider || null,
    discovery_source: input.discoverySource || "manual",
    dedupe_key: dedupeKey,
    triage: analysis.triage,
    triage_reason: analysis.triageReason,
    updated_at: new Date().toISOString(),
  };

  let jobId: string;
  if (existing.data?.id) {
    const updated = await supabase.from("jobs").update(jobValues).eq("id", existing.data.id).select("id").single();
    if (updated.error) throw updated.error;
    jobId = updated.data.id;
  } else {
    const inserted = await supabase.from("jobs").insert(jobValues).select("id").single();
    if (inserted.error) throw inserted.error;
    jobId = inserted.data.id;
  }

  const contentHash = createHash("sha256").update(`${input.company}\n${input.title}\n${input.description}`).digest("hex");
  let snapshotId: string | null = null;
  const existingSnapshot = await supabase
    .from("job_snapshots")
    .select("id")
    .eq("job_id", jobId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existingSnapshot.error) throw existingSnapshot.error;
  if (existingSnapshot.data?.id) {
    snapshotId = existingSnapshot.data.id;
  } else {
    const insertedSnapshot = await supabase.from("job_snapshots").insert({
      job_id: jobId,
      title: input.title,
      company_name: input.company,
      description_text: input.description,
      source_url: input.sourceUrl || null,
      content_hash: contentHash,
      raw_metadata: {
        ingestion_source: input.discoverySource || "manual",
        listing_extraction: {
          source: "manual",
          industry: input.industry || null,
          captured_at: new Date().toISOString(),
        },
      },
    }).select("id").single();
    if (insertedSnapshot.error) throw insertedSnapshot.error;
    snapshotId = insertedSnapshot.data.id;
  }
  if (snapshotId) {
    const snapshotUpdate = await supabase.from("jobs").update({ current_snapshot_id: snapshotId }).eq("id", jobId);
    if (snapshotUpdate.error) throw snapshotUpdate.error;
  }

  const [{ data: jobRevision, error: jobRevisionError }, { data: profileRevision, error: profileRevisionError }] = await Promise.all([
    supabase.from("jobs").select("analysis_revision").eq("id", jobId).eq("user_id", user.id).single(),
    supabase.from("candidate_profiles").select("analysis_revision").eq("user_id", user.id).single(),
  ]);
  if (jobRevisionError) throw jobRevisionError;
  if (profileRevisionError) throw profileRevisionError;
  const inputHash = await hashJobAnalysisInput({
    job: input,
    profile,
    jobRevision: Number(jobRevision.analysis_revision),
    profileRevision: Number(profileRevision.analysis_revision),
    assessmentAsOf,
  });

  const evidenceIds = analysis.evidenceIds.filter(validUuid);
  const analysisInsert = await supabase.from("job_analyses").insert({
    job_id: jobId,
    model: null,
    contract_version: analysis.contractVersion,
    analysis_source: analysis.analysisSource,
    eligibility: analysis.eligibility,
    eligibility_notes: analysis.eligibilityNotes,
    fit_score: analysis.fitScore,
    priority_score: analysis.priorityScore,
    fit_components: analysis.fitComponents,
    priority_components: analysis.priorityComponents,
    recommended_cv_family: analysis.recommendedCvFamily,
    strengths: analysis.strengths,
    weaknesses: analysis.weaknesses,
    application_strategy: analysis.applicationStrategy,
    cover_letter_value: analysis.coverLetterValue,
    evidence_item_ids: evidenceIds,
    triage: analysis.triage,
    triage_reason: analysis.triageReason,
    engine_version: JOB_ANALYSIS_ENGINE_VERSION,
    job_revision: Number(jobRevision.analysis_revision),
    profile_revision: Number(profileRevision.analysis_revision),
    input_hash: inputHash,
    assessment_as_of: assessmentAsOf.toISOString(),
  }).select("id,created_at").single();
  if (analysisInsert.error) throw analysisInsert.error;

  if (analysis.requirements.length) {
    const requirementRows = analysis.requirements.map((item) => ({
      job_id: jobId,
      analysis_id: analysisInsert.data.id,
      requirement_text: item.text,
      requirement_type: item.type,
      category: item.category,
      evidence_item_ids: item.evidenceIds.filter(validUuid),
      match_score: item.matchScore,
    }));
    const requirementsInsert = await supabase.from("job_requirements").insert(requirementRows);
    if (requirementsInsert.error) throw requirementsInsert.error;
  }

  await supabase.from("audit_events").insert({
    user_id: user.id,
    entity_type: "job",
    entity_id: jobId,
    event_type: existing.data?.id ? "job_reanalysed" : "job_ingested",
    actor_type: "system",
    metadata: { dedupe_key: dedupeKey, triage: analysis.triage, fit_score: analysis.fitScore, priority_score: analysis.priorityScore },
  });
  await recordJobPoolSheetSyncInBackground(supabase, user.id);

  return { id: jobId, analysis };
}

export async function POST(request: Request) {
  try {
    const input = parseInput(await request.json());
    const profile = await getCandidateProfile();
    const mode = getDataMode();

    if (isSupabaseConfigured() && mode !== "local") {
      const result = await persistSupabase(input, profile);
      return NextResponse.json({ ok: true, id: result.id, analysis: result.analysis, source: "supabase" });
    }

    const record = await saveLocalJob(localRecord(input, profile));
    return NextResponse.json({ ok: true, id: record.id, analysis: record.analysis, source: "local_snapshot" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to ingest job.";
    if (message === "AUTH_REQUIRED") return NextResponse.json({ ok: false, error: "Sign in with an active JobHuntAI Console membership before adding live jobs." }, { status: 401 });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
