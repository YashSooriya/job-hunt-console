import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { analyseJob, createJobDedupeKey, hashJobAnalysisInput, JOB_ANALYSIS_ENGINE_VERSION, type JobInput } from "@jobhunt/job-intelligence";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { getCandidateProfile, getJobById } from "@/lib/data/repository";
import { updateLocalJobs } from "@/lib/data/local";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import type { CandidateProfileData, JobRecord } from "@/lib/types";
import { recordJobPoolSheetSyncInBackground } from "@/lib/google-job-pool-sheet";

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullableText(value: unknown, max: number) {
  return cleanText(value, max) || null;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Salary values must be non-negative numbers.");
  return number;
}

function nullableDate(value: unknown) {
  const text = cleanText(value, 40);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("Enter valid posting and closing dates.");
  return date.toISOString();
}

function nullableUrl(value: unknown) {
  const text = cleanText(value, 4000);
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Source and application URLs must be complete http(s) URLs."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Source and application URLs must be complete http(s) URLs.");
  url.hash = "";
  return url.toString();
}

function jobInputFromRecord(record: JobRecord): JobInput {
  return {
    company: record.company,
    title: record.title,
    industry: record.industry,
    description: record.description,
    externalJobId: record.externalJobId,
    sourceUrl: record.sourceUrl,
    applicationUrl: record.applicationUrl,
    location: record.location,
    workMode: record.workMode,
    salaryText: record.salaryText,
    salaryMin: record.salaryMin,
    salaryMax: record.salaryMax,
    salaryCurrency: record.salaryCurrency,
    postedAt: record.postedAt,
    closesAt: record.closesAt,
    employmentType: record.employmentType,
    atsProvider: record.atsProvider,
    discoverySource: record.discoverySource,
  };
}

function editedJobInput(raw: Record<string, unknown>, current: JobInput): JobInput {
  const salaryMin = nullableNumber(raw.salaryMin);
  const salaryMax = nullableNumber(raw.salaryMax);
  if (salaryMin !== null && salaryMax !== null && salaryMax < salaryMin) {
    throw new Error("Salary maximum cannot be below salary minimum.");
  }
  const postedAt = nullableDate(raw.postedAt);
  const closesAt = nullableDate(raw.closesAt);
  if (postedAt && closesAt && Date.parse(closesAt) < Date.parse(postedAt)) {
    throw new Error("Closing date cannot be before the posted date.");
  }
  const company = cleanText(raw.company, 300);
  const title = cleanText(raw.title, 500);
  const description = cleanText(raw.description, 60000);
  if (!company || !title || description.length < 40) {
    throw new Error("Company, role title, and a meaningful job description are required.");
  }
  return {
    ...current,
    company,
    title,
    industry: nullableText(raw.industry, 300),
    description,
    externalJobId: nullableText(raw.externalJobId, 300),
    sourceUrl: nullableUrl(raw.sourceUrl),
    applicationUrl: nullableUrl(raw.applicationUrl),
    location: nullableText(raw.location, 500),
    workMode: nullableText(raw.workMode, 100),
    salaryText: nullableText(raw.salaryText, 500),
    salaryMin,
    salaryMax,
    salaryCurrency: nullableText(raw.salaryCurrency, 20) || "GBP",
    postedAt,
    closesAt,
    employmentType: nullableText(raw.employmentType, 200),
  };
}

function localAnalysisRecord(record: JobRecord, input: JobInput, profile: CandidateProfileData): Partial<JobRecord> {
  const assessmentAsOf = new Date();
  const analysis = analyseJob(input, profile, assessmentAsOf);
  const contentChanged = input.company !== record.company || input.title !== record.title || input.description !== record.description;
  const now = new Date().toISOString();
  return {
    title: input.title,
    company: input.company,
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
    postedAt: input.postedAt || null,
    closesAt: input.closesAt || null,
    employmentType: input.employmentType || null,
    description: input.description,
    dedupeKey: createJobDedupeKey(input),
    triage: analysis.triage,
    triageReason: analysis.triageReason,
    snapshotCapturedAt: contentChanged ? now : record.snapshotCapturedAt,
    analysis: { ...analysis, createdAt: now },
    requirements: analysis.requirements.map((item) => ({ ...item })),
    userStatus: record.userStatus || "new",
    archivedAt: record.archivedAt || null,
  };
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ ok: false, error: "Vacancy not found." }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    const action = body?.action === "reanalyse" ? "reanalyse" : "edit";
    const { supabase, user } = await requireProfile();
    const record = await getJobById(id);
    if (!record) return NextResponse.json({ ok: false, error: "Vacancy not found." }, { status: 404 });
    if (!record.description || record.description.trim().length < 40) {
      return NextResponse.json({ ok: false, error: "This vacancy has no complete saved description to analyse." }, { status: 409 });
    }
    const currentInput = jobInputFromRecord(record);
    const input = action === "reanalyse" ? currentInput : editedJobInput(body, currentInput);
    const profile = await getCandidateProfile();
    const assessmentAsOf = new Date();
    const analysis = analyseJob(input, profile, assessmentAsOf);

    if (getDataMode() === "local" || !isSupabaseConfigured()) {
      const changes = localAnalysisRecord(record, input, profile);
      await updateLocalJobs([id], changes);
      return NextResponse.json({ ok: true, id, triage: analysis.triage, fitScore: analysis.fitScore });
    }

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .select("id,user_id,current_snapshot_id,analysis_revision")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (jobError) throw jobError;
    if (!job) return NextResponse.json({ ok: false, error: "Vacancy not found." }, { status: 404 });

    const dedupeKey = createJobDedupeKey(input);
    const duplicate = await supabase
      .from("jobs")
      .select("id")
      .eq("user_id", user.id)
      .eq("dedupe_key", dedupeKey)
      .neq("id", id)
      .maybeSingle();
    if (duplicate.error) throw duplicate.error;
    if (duplicate.data) {
      return NextResponse.json({ ok: false, error: "These edits match another vacancy in your pool. Edit that existing vacancy instead." }, { status: 409 });
    }

    const now = new Date().toISOString();
    const contentHash = createHash("sha256").update(`${input.company}\n${input.title}\n${input.description}`).digest("hex");
    const contentChanged = input.company !== record.company || input.title !== record.title || input.description !== record.description;
    let snapshotId = job.current_snapshot_id;
    if (contentChanged) {
      const existingSnapshot = await supabase
        .from("job_snapshots")
        .select("id,raw_metadata")
        .eq("job_id", id)
        .eq("content_hash", contentHash)
        .maybeSingle();
      if (existingSnapshot.error) throw existingSnapshot.error;
      snapshotId = existingSnapshot.data?.id || null;
      if (!existingSnapshot.data) {
      const oldSnapshot = job.current_snapshot_id
        ? await supabase.from("job_snapshots").select("raw_metadata").eq("id", job.current_snapshot_id).eq("job_id", id).maybeSingle()
        : { data: null, error: null };
      if (oldSnapshot.error) throw oldSnapshot.error;
      const rawMetadata = oldSnapshot.data?.raw_metadata && typeof oldSnapshot.data.raw_metadata === "object"
        ? oldSnapshot.data.raw_metadata as Record<string, unknown>
        : {};
      const oldExtraction = rawMetadata.listing_extraction && typeof rawMetadata.listing_extraction === "object"
        ? rawMetadata.listing_extraction as Record<string, unknown>
        : {};
      const insertedSnapshot = await supabase.from("job_snapshots").insert({
        job_id: id,
        title: input.title,
        company_name: input.company,
        description_text: input.description,
        source_url: input.sourceUrl || null,
        content_hash: contentHash,
        raw_metadata: {
          ...rawMetadata,
          user_edit: { saved_at: now, source: "job_pool" },
          listing_extraction: { ...oldExtraction, industry: input.industry || null },
        },
      }).select("id").single();
      if (insertedSnapshot.error) throw insertedSnapshot.error;
      snapshotId = insertedSnapshot.data.id;
      }
    }

    const companyResult = await supabase
      .from("companies")
      .upsert({ user_id: user.id, canonical_name: input.company }, { onConflict: "user_id,canonical_name" })
      .select("id")
      .single();
    if (companyResult.error) throw companyResult.error;

    const updated = await supabase.from("jobs").update({
      company_id: companyResult.data.id,
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
      dedupe_key: dedupeKey,
      triage: analysis.triage,
      triage_reason: analysis.triageReason,
      current_snapshot_id: snapshotId,
      updated_at: now,
    }).eq("id", id).eq("user_id", user.id).select("id,analysis_revision").single();
    if (updated.error) throw updated.error;

    const { data: profileRevision, error: profileRevisionError } = await supabase
      .from("candidate_profiles")
      .select("analysis_revision")
      .eq("user_id", user.id)
      .single();
    if (profileRevisionError) throw profileRevisionError;
    const inputHash = await hashJobAnalysisInput({
      job: input,
      profile,
      jobRevision: Number(updated.data.analysis_revision),
      profileRevision: Number(profileRevision.analysis_revision),
      assessmentAsOf,
    });

    const validEvidenceIds = analysis.evidenceIds.filter((value) => UUID.test(value));
    const insertedAnalysis = await supabase.from("job_analyses").insert({
      job_id: id,
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
      evidence_item_ids: validEvidenceIds,
      triage: analysis.triage,
      triage_reason: analysis.triageReason,
      engine_version: JOB_ANALYSIS_ENGINE_VERSION,
      job_revision: Number(updated.data.analysis_revision),
      profile_revision: Number(profileRevision.analysis_revision),
      input_hash: inputHash,
      assessment_as_of: assessmentAsOf.toISOString(),
    }).select("id").single();
    if (insertedAnalysis.error) throw insertedAnalysis.error;

    if (analysis.requirements.length) {
      const requirements = analysis.requirements.map((item) => ({
        job_id: id,
        analysis_id: insertedAnalysis.data.id,
        requirement_text: item.text,
        requirement_type: item.type,
        category: item.category,
        evidence_item_ids: item.evidenceIds.filter((value) => UUID.test(value)),
        match_score: item.matchScore,
      }));
      const requirementsResult = await supabase.from("job_requirements").insert(requirements);
      if (requirementsResult.error) throw requirementsResult.error;
    }

    await recordJobPoolSheetSyncInBackground(supabase, user.id);
    return NextResponse.json({ ok: true, id, analysisId: insertedAnalysis.data.id, triage: analysis.triage, fitScore: analysis.fitScore });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update or analyse this vacancy.";
    const status = message.startsWith("These edits match another vacancy") ? 409 : statusCode(error);
    return NextResponse.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
