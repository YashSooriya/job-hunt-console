import {
  analyseJob,
  hashJobAnalysisInput,
  JOB_ANALYSIS_ENGINE_VERSION,
  type CandidateProfileLike,
  type JobInput,
  type JobAnalysis,
} from "@jobhunt/job-intelligence";
import type { JobPoolSchedulerEnvironment } from "@/lib/job-pool-scheduler";

type AnalysisTask = {
  task_id: string;
  batch_id: string;
  user_id: string;
  job_id: string;
  lease_token: string;
  attempt_count: number;
  job_revision: number;
  profile_revision: number;
  assessment_as_of: string;
  job: Record<string, unknown>;
  profile: Record<string, unknown>;
};

type AnalysisResult = {
  task_id: string;
  lease_token: string;
  analysis: JobAnalysis | null;
  input_hash: string | null;
  engine_version: string;
  error: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jobInput(raw: Record<string, unknown>): JobInput {
  return {
    company: requiredText(raw.company),
    title: requiredText(raw.title),
    industry: nullableText(raw.industry),
    description: requiredText(raw.description),
    externalJobId: nullableText(raw.externalJobId),
    sourceUrl: nullableText(raw.sourceUrl),
    applicationUrl: nullableText(raw.applicationUrl),
    location: nullableText(raw.location),
    workMode: nullableText(raw.workMode),
    salaryText: nullableText(raw.salaryText),
    salaryMin: nullableNumber(raw.salaryMin),
    salaryMax: nullableNumber(raw.salaryMax),
    salaryCurrency: nullableText(raw.salaryCurrency) || "GBP",
    postedAt: nullableText(raw.postedAt),
    closesAt: nullableText(raw.closesAt),
    employmentType: nullableText(raw.employmentType),
    atsProvider: nullableText(raw.atsProvider),
    discoverySource: nullableText(raw.discoverySource),
  };
}

function candidateProfile(raw: Record<string, unknown>): CandidateProfileLike & { displayName?: string } {
  const facts = Array.isArray(raw.facts) ? raw.facts.map((value) => {
    const fact = record(value);
    return { id: nullableText(fact.id) || undefined, factKey: requiredText(fact.factKey), value: fact.value, status: requiredText(fact.status) };
  }).filter((fact) => fact.factKey) : [];
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map((value) => {
    const item = record(value);
    return {
      id: nullableText(item.id) || undefined,
      evidenceKey: requiredText(item.evidenceKey),
      category: requiredText(item.category),
      claim: requiredText(item.claim),
      detail: nullableText(item.detail),
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
      strength: Number(item.strength) || 3,
      status: requiredText(item.status) as "verified" | "needs_review" | "rejected",
    };
  }).filter((item) => item.evidenceKey && item.claim) : [];
  return {
    displayName: requiredText(raw.displayName),
    facts,
    evidence,
    preferences: record(raw.preferences),
  };
}

async function functionRequest(
  env: JobPoolSchedulerEnvironment,
  fetcher: typeof fetch,
  action: "analysis_claim" | "analysis_finish",
  payload: Record<string, unknown> = {},
) {
  const response = await fetcher(new URL("/functions/v1/job-pool-scheduler", env.NEXT_PUBLIC_SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`,
      "content-type": "application/json",
      "x-job-pool-scheduler-secret": env.JOB_POOL_SCHEDULER_SECRET,
    },
    body: JSON.stringify({ action, ...payload }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`job_analysis_scheduler_function_${response.status}`);
  const body = record(await response.json());
  if (body.ok !== true) throw new Error("job_analysis_scheduler_function_failed");
  return body;
}

async function analyseOne(task: AnalysisTask): Promise<AnalysisResult> {
  const base = {
    task_id: task.task_id,
    lease_token: task.lease_token,
    analysis: null,
    input_hash: null,
    engine_version: JOB_ANALYSIS_ENGINE_VERSION,
    error: null,
  } satisfies AnalysisResult;
  try {
    const job = jobInput(record(task.job));
    const profile = candidateProfile(record(task.profile));
    if (!job.company || !job.title || job.description.length < 40) {
      return { ...base, error: "needs_user:This listing needs a complete saved job description before it can be analysed. Edit the listing and provide at least 40 characters of description." };
    }
    const assessmentAsOf = new Date(task.assessment_as_of);
    if (!Number.isFinite(assessmentAsOf.getTime()) || !Number.isSafeInteger(task.job_revision) || !Number.isSafeInteger(task.profile_revision)) {
      return { ...base, error: "Analysis task metadata was invalid; the scheduler will retry it." };
    }
    const [analysis, inputHash] = await Promise.all([
      Promise.resolve(analyseJob(job, profile, assessmentAsOf)),
      hashJobAnalysisInput({
        job,
        profile,
        jobRevision: task.job_revision,
        profileRevision: task.profile_revision,
        assessmentAsOf,
      }),
    ]);
    return { ...base, analysis, input_hash: inputHash };
  } catch {
    // Provider/content details are deliberately not copied to task rows. The
    // UI receives only a bounded, actionable message after retry exhaustion.
    return { ...base, error: "The fit-analysis engine could not process this listing. The system will retry automatically." };
  }
}

/** Drain up to 50 durable tasks per cron run, in small bounded leases. */
export async function runJobAnalysisScheduler(
  env: JobPoolSchedulerEnvironment,
  fetcher: typeof fetch = fetch,
) {
  const MAX_WAVES = 10;
  const MAX_PARALLEL = 5;
  let claimed = 0;
  let completed = 0;
  let needsUser = 0;
  let failed = 0;
  let retried = 0;

  for (let wave = 0; wave < MAX_WAVES; wave += 1) {
    const claimBody = await functionRequest(env, fetcher, "analysis_claim", { limit: MAX_PARALLEL });
    const tasks = Array.isArray(claimBody.tasks) ? claimBody.tasks.map((item: unknown) => record(item) as AnalysisTask).slice(0, MAX_PARALLEL) : [];
    if (!tasks.length) break;
    claimed += tasks.length;
    const results = await Promise.all(tasks.map(analyseOne));
    const finishBody = await functionRequest(env, fetcher, "analysis_finish", { results });
    const outcomes = Array.isArray(finishBody.outcomes) ? finishBody.outcomes : [];
    for (const [index, result] of results.entries()) {
      const outcome = record(outcomes[index]);
      if (outcome.ok !== true) {
        failed += 1;
        continue;
      }
      const state = outcome.state;
      if (state === "completed") completed += 1;
      else if (state === "needs_user") needsUser += 1;
      else if (state === "failed") failed += 1;
      else retried += 1;
    }
    if (tasks.length < MAX_PARALLEL) break;
  }

  return { claimed, completed, needsUser, failed, retried };
}
