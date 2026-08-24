import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { getLocalApplicationContentPackage, getLocalApplicationReviewPackage, getLocalDocuments, getLocalJobs, getLocalPreparationApplications, getLocalProfile, getLocalTracker } from "@/lib/data/local";
import type {
  CandidateProfileData,
  ApplicationContentPackage,
  ApplicationReviewPackage,
  DocumentDataset,
  DocumentRecord,
  JobDataset,
  JobRecord,
  PreparationApplicationDataset,
  PreparationApplicationRecord,
  TrackerDataset,
  TrackerQuality,
  TrackerRecord,
  TrackerSummary,
} from "@/lib/types";


function trackerQuality(records: TrackerRecord[]): TrackerQuality {
  const issues: TrackerQuality["issues"] = [];
  for (const record of records) {
    if (/not identified/i.test(record.company)) {
      issues.push({ sourceRow: record.sourceRow, code: "unknown_company", severity: "warning", message: `Employer is not identified for ${record.role}.` });
    }
    if (/role not identified/i.test(record.role)) {
      issues.push({ sourceRow: record.sourceRow, code: "unknown_role", severity: "warning", message: `Role is not identified for ${record.company}.` });
    }
    if (/spreadsheet formula error/i.test(record.notes || "")) {
      issues.push({ sourceRow: record.sourceRow, code: "source_formula_error", severity: "info", message: `${record.company} has a tracker note that originated from a spreadsheet formula error.` });
    }
  }
  return {
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length,
    infoCount: issues.filter((issue) => issue.severity === "info").length,
    issues,
  };
}

function trackerSummary(records: TrackerRecord[]): TrackerSummary {
  return {
    total: records.length,
    actionRequired: records.filter((r) => r.status === "Action Required").length,
    underReview: records.filter((r) => r.status === "Under Review").length,
    received: records.filter((r) => r.status === "Received").length,
    rejected: records.filter((r) => r.applicationState === "rejected").length,
    assessments: records.filter((r) => r.applicationState === "assessment").length,
    interviews: records.filter((r) => r.applicationState === "interview").length,
  };
}

async function getSupabaseTracker(): Promise<TrackerDataset> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("applications")
    .select(`
      id,state,source_tracker_row,source_tracker_values,applied_at,submitted_at,
      next_action,deadline_at,notes,
      jobs(title,external_job_id,companies(canonical_name))
    `)
    .order("applied_at", { ascending: false });

  if (error) throw error;

  const records: TrackerRecord[] = (data || []).map((row: any) => {
    const source = row.source_tracker_values || {};
    const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
    const companyRelation = job?.companies;
    const company = Array.isArray(companyRelation) ? companyRelation[0] : companyRelation;
    return {
      id: row.id,
      sourceRow: row.source_tracker_row ?? null,
      company: company?.canonical_name || source.company || "Unknown company",
      role: job?.title || source.role || "Unknown role",
      externalJobId: job?.external_job_id || source.externalJobId || null,
      applicationDate: row.applied_at?.slice(0, 10) || source.applicationDate || null,
      lastEmail: source.lastEmail || null,
      status: source.status || row.state,
      stage: source.stage || row.state,
      priority: source.priority || "Medium",
      nextAction: row.next_action || source.nextAction || null,
      deadline: row.deadline_at?.slice(0, 10) || source.deadline || null,
      daysSinceUpdate: source.daysSinceUpdate ?? null,
      notes: row.notes || source.notes || null,
      emailSource: source.emailSource || null,
      applicationState: row.state,
    };
  });

  return {
    source: "supabase",
    generatedAt: new Date().toISOString(),
    summary: trackerSummary(records),
    quality: trackerQuality(records),
    records,
  };
}

async function getSupabaseProfile(): Promise<CandidateProfileData> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: profile, error: profileError } = await supabase
    .from("candidate_profiles")
    .select("id,display_name")
    .single();
  if (profileError) throw profileError;

  const [factsResult, evidenceResult, sourcesResult, preferencesResult, employmentResult, educationResult, skillsResult, projectsResult, publicationsResult] = await Promise.all([
    supabase.from("candidate_facts").select("*").eq("profile_id", profile.id).order("fact_key"),
    supabase.from("evidence_items").select("*,evidence_sources(source_key)").eq("profile_id", profile.id).order("evidence_key"),
    supabase.from("evidence_sources").select("*").eq("profile_id", profile.id).order("title"),
    supabase.from("candidate_preferences").select("preferences").eq("profile_id", profile.id).maybeSingle(),
    supabase.from("candidate_employment").select("*").eq("profile_id", profile.id).eq("verification_status", "verified").order("start_date", { ascending: false }),
    supabase.from("candidate_education").select("*").eq("profile_id", profile.id).eq("verification_status", "verified").order("start_date", { ascending: false }),
    supabase.from("candidate_skills").select("*").eq("profile_id", profile.id).eq("verification_status", "verified").order("name"),
    supabase.from("candidate_projects").select("*").eq("profile_id", profile.id).eq("verification_status", "verified").order("created_at", { ascending: false }),
    supabase.from("candidate_publications").select("*").eq("profile_id", profile.id).eq("verification_status", "verified").order("published_on", { ascending: false }),
  ]);
  for (const result of [factsResult, evidenceResult, sourcesResult, preferencesResult, employmentResult, educationResult, skillsResult, projectsResult, publicationsResult]) {
    if (result.error) throw result.error;
  }

  return {
    source: "supabase",
    displayName: profile.display_name,
    facts: (factsResult.data || []).map((fact: any) => ({
      id: fact.id,
      factKey: fact.fact_key,
      value: fact.value_json,
      status: fact.verification_status,
      sourceKey: null,
    })),
    evidence: (evidenceResult.data || []).map((item: any) => ({
      id: item.id,
      evidenceKey: item.evidence_key,
      category: item.category,
      claim: item.claim,
      detail: item.detail,
      tags: item.tags || [],
      strength: item.strength,
      status: item.verification_status,
      sourceKey: Array.isArray(item.evidence_sources)
        ? item.evidence_sources[0]?.source_key ?? null
        : item.evidence_sources?.source_key ?? null,
      sourceLocator: item.source_locator,
    })),
    sources: (sourcesResult.data || []).map((source: any) => ({
      id: source.id,
      sourceKey: source.source_key,
      title: source.title,
      sourceType: source.source_type,
      provider: source.provider,
    })),
    preferences: preferencesResult.data?.preferences || {},
    structured: {
      employment: employmentResult.data || [],
      education: educationResult.data || [],
      skills: skillsResult.data || [],
      projects: projectsResult.data || [],
      publications: publicationsResult.data || [],
    },
  };
}

export async function getTrackerDataset(): Promise<TrackerDataset> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalTracker();
  if (mode === "supabase") return getSupabaseTracker();
  try {
    return await getSupabaseTracker();
  } catch (error) {
    console.warn("Supabase tracker read failed; using local validated snapshot.", error);
    return getLocalTracker();
  }
}

export async function getCandidateProfile(): Promise<CandidateProfileData> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalProfile();
  if (mode === "supabase") return getSupabaseProfile();
  try {
    return await getSupabaseProfile();
  } catch (error) {
    console.warn("Supabase profile read failed; using local validated knowledge base.", error);
    return getLocalProfile();
  }
}


function jobSummary(records: JobRecord[]) {
  return {
    total: records.length,
    autoPrepare: records.filter((r) => r.triage === "auto_prepare").length,
    recommend: records.filter((r) => r.triage === "recommend").length,
    maybe: records.filter((r) => r.triage === "maybe").length,
    reject: records.filter((r) => r.triage === "reject").length,
  };
}

async function getSupabaseJobs(): Promise<JobDataset> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: jobs, error: jobsError } = await supabase
    .from("jobs")
    .select(`
      id,title,external_job_id,source_url,application_url,location_text,work_mode,
      salary_text,salary_min,salary_max,salary_currency,posted_at,closes_at,
      employment_type,ats_provider,discovery_source,dedupe_key,discovered_at,
      triage,triage_reason,current_snapshot_id,companies(canonical_name)
    `)
    .neq("discovery_source", "historical_tracker")
    .order("discovered_at", { ascending: false });
  if (jobsError) throw jobsError;

  const ids = (jobs || []).map((row: any) => row.id);
  const [analysesResult, snapshotsResult, requirementsResult] = ids.length
    ? await Promise.all([
        supabase.from("job_analyses").select("*").in("job_id", ids).order("created_at", { ascending: false }),
        supabase.from("job_snapshots").select("*").in("job_id", ids).order("captured_at", { ascending: false }),
        supabase.from("job_requirements").select("*").in("job_id", ids).order("created_at", { ascending: true }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  for (const result of [analysesResult, snapshotsResult, requirementsResult]) if (result.error) throw result.error;

  const latestAnalysisByJob = new Map<string, any>();
  for (const analysis of analysesResult.data || []) {
    if (!latestAnalysisByJob.has(analysis.job_id)) latestAnalysisByJob.set(analysis.job_id, analysis);
  }
  const snapshotsById = new Map((snapshotsResult.data || []).map((row: any) => [row.id, row]));
  const latestSnapshotByJob = new Map<string, any>();
  for (const snapshot of snapshotsResult.data || []) {
    if (!latestSnapshotByJob.has(snapshot.job_id)) latestSnapshotByJob.set(snapshot.job_id, snapshot);
  }

  const records: JobRecord[] = (jobs || []).map((row: any) => {
    const relation = row.companies;
    const company = Array.isArray(relation) ? relation[0] : relation;
    const analysis = latestAnalysisByJob.get(row.id);
    const snapshot = (row.current_snapshot_id && snapshotsById.get(row.current_snapshot_id)) || latestSnapshotByJob.get(row.id);
    const requirements = (requirementsResult.data || [])
      .filter((item: any) => item.job_id === row.id && (!analysis || !item.analysis_id || item.analysis_id === analysis.id))
      .map((item: any) => ({
        id: item.id,
        text: item.requirement_text,
        type: item.requirement_type,
        category: item.category || "general",
        matchScore: item.match_score ?? 0,
        evidenceIds: item.evidence_item_ids || [],
      }));
    return {
      id: row.id,
      company: company?.canonical_name || snapshot?.company_name || "Unknown company",
      title: row.title,
      externalJobId: row.external_job_id,
      sourceUrl: row.source_url,
      applicationUrl: row.application_url,
      location: row.location_text,
      workMode: row.work_mode,
      salaryText: row.salary_text,
      salaryMin: row.salary_min == null ? null : Number(row.salary_min),
      salaryMax: row.salary_max == null ? null : Number(row.salary_max),
      salaryCurrency: row.salary_currency || "GBP",
      postedAt: row.posted_at,
      closesAt: row.closes_at,
      employmentType: row.employment_type,
      atsProvider: row.ats_provider,
      discoverySource: row.discovery_source || "manual",
      dedupeKey: row.dedupe_key,
      discoveredAt: row.discovered_at,
      triage: row.triage,
      triageReason: row.triage_reason,
      description: snapshot?.description_text || "",
      snapshotCapturedAt: snapshot?.captured_at || null,
      analysis: analysis ? {
        id: analysis.id,
        contractVersion: analysis.contract_version,
        analysisSource: analysis.analysis_source || "deterministic_v1",
        eligibility: analysis.eligibility,
        eligibilityNotes: analysis.eligibility_notes || [],
        fitScore: Number(analysis.fit_score),
        priorityScore: Number(analysis.priority_score),
        fitComponents: analysis.fit_components || {},
        priorityComponents: analysis.priority_components || {},
        recommendedCvFamily: analysis.recommended_cv_family,
        strengths: analysis.strengths || [],
        weaknesses: analysis.weaknesses || [],
        applicationStrategy: analysis.application_strategy || "",
        coverLetterValue: analysis.cover_letter_value || "low",
        evidenceIds: analysis.evidence_item_ids || [],
        triage: analysis.triage || row.triage,
        triageReason: analysis.triage_reason || row.triage_reason || "",
        createdAt: analysis.created_at,
      } : null,
      requirements,
    };
  });

  return { source: "supabase", generatedAt: new Date().toISOString(), summary: jobSummary(records), records };
}

export async function getJobDataset(): Promise<JobDataset> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalJobs();
  if (mode === "supabase") return getSupabaseJobs();
  try {
    return await getSupabaseJobs();
  } catch (error) {
    console.warn("Supabase job read failed; using local job inbox.", error);
    return getLocalJobs();
  }
}

export async function getJobById(id: string): Promise<JobRecord | null> {
  const dataset = await getJobDataset();
  return dataset.records.find((record) => record.id === id) || null;
}


const preparationTaskLabels: Record<string, string> = {
  freeze_job_context: "Freeze vacancy and analysis",
  lock_application_strategy: "Lock application strategy",
  select_cv_family: "Select base CV family",
  prepare_cv: "Prepare tailored CV",
  prepare_cover_letter: "Prepare cover letter",
  prepare_screening_answers: "Prepare screening answers",
  research_salary: "Resolve salary context",
  assemble_review_package: "Assemble Ready for Review package",
};

function preparationSummary(records: PreparationApplicationRecord[]) {
  return {
    total: records.length,
    autoPrepared: records.filter((item) => item.origin === "auto_prepare").length,
    preparing: records.filter((item) => item.state === "preparing").length,
    readyForReview: records.filter((item) => item.state === "ready_for_review").length,
    needsUser: records.filter((item) => item.tasks.some((task) => task.state === "needs_user")).length,
  };
}

function progressForTasks(tasks: PreparationApplicationRecord["tasks"]) {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.state === "completed").length;
  const failed = tasks.filter((task) => task.state === "failed").length;
  const needsUser = tasks.filter((task) => task.state === "needs_user").length;
  return {
    total,
    completed,
    pending: Math.max(0, total - completed - failed),
    needsUser,
    failed,
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
}

async function getSupabasePreparationApplications(): Promise<PreparationApplicationDataset> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: applications, error: appError } = await supabase
    .from("applications")
    .select(`
      id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,
      preparation_origin,next_action,notes,created_at,updated_at,
      jobs(title,salary_text,triage,companies(canonical_name))
    `)
    .is("source_tracker_row", null)
    .order("updated_at", { ascending: false });
  if (appError) throw appError;

  const ids = (applications || []).map((row: any) => row.id);
  const analysisIds = (applications || []).map((row: any) => row.job_analysis_id).filter(Boolean);
  const [strategiesResult, tasksResult, analysesResult] = ids.length
    ? await Promise.all([
        supabase.from("application_strategies").select("*").in("application_id", ids).order("created_at", { ascending: false }),
        supabase.from("automation_tasks").select("*").eq("entity_type", "application").in("entity_id", ids).order("created_at", { ascending: true }),
        analysisIds.length ? supabase.from("job_analyses").select("id,fit_score,priority_score,triage,evidence_item_ids").in("id", analysisIds) : Promise.resolve({ data: [], error: null }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  for (const result of [strategiesResult, tasksResult, analysesResult]) if (result.error) throw result.error;

  const currentStrategyByApplication = new Map<string, any>();
  for (const strategy of strategiesResult.data || []) {
    if (!currentStrategyByApplication.has(strategy.application_id)) currentStrategyByApplication.set(strategy.application_id, strategy);
  }
  const analysisById = new Map((analysesResult.data || []).map((row: any) => [row.id, row]));
  const tasksByApplication = new Map<string, any[]>();
  for (const task of tasksResult.data || []) {
    const current = tasksByApplication.get(task.entity_id) || [];
    current.push(task);
    tasksByApplication.set(task.entity_id, current);
  }

  const records: PreparationApplicationRecord[] = (applications || []).map((row: any) => {
    const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
    const companyRelation = job?.companies;
    const company = Array.isArray(companyRelation) ? companyRelation[0] : companyRelation;
    const strategy = currentStrategyByApplication.get(row.id);
    const analysis = row.job_analysis_id ? analysisById.get(row.job_analysis_id) : null;
    const tasks = (tasksByApplication.get(row.id) || []).map((task: any) => ({
      id: task.id,
      taskType: task.task_type,
      state: task.state,
      label: preparationTaskLabels[task.task_type] || task.task_type.replaceAll("_", " "),
      input: task.input_json || {},
      output: task.output_json || null,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    }));
    return {
      id: row.id,
      jobId: row.job_id,
      company: company?.canonical_name || "Unknown company",
      role: job?.title || "Unknown role",
      state: row.state,
      origin: row.preparation_origin,
      selectedCvFamily: row.selected_cv_family,
      strategyText: strategy?.strategy_text || "",
      evidenceIds: strategy?.evidence_item_ids || analysis?.evidence_item_ids || [],
      nextAction: row.next_action,
      notes: row.notes,
      salaryText: job?.salary_text || null,
      fitScore: analysis?.fit_score == null ? null : Number(analysis.fit_score),
      priorityScore: analysis?.priority_score == null ? null : Number(analysis.priority_score),
      triage: analysis?.triage || job?.triage || null,
      jobSnapshotId: row.job_snapshot_id,
      jobAnalysisId: row.job_analysis_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tasks,
      progress: progressForTasks(tasks),
    };
  });

  return { source: "supabase", generatedAt: new Date().toISOString(), summary: preparationSummary(records), records };
}

export async function getPreparationApplications(): Promise<PreparationApplicationDataset> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalPreparationApplications();
  if (mode === "supabase") return getSupabasePreparationApplications();
  try {
    return await getSupabasePreparationApplications();
  } catch (error) {
    console.warn("Supabase preparation application read failed; using local preparation queue.", error);
    return getLocalPreparationApplications();
  }
}

export async function getPreparationApplicationById(id: string): Promise<PreparationApplicationRecord | null> {
  const dataset = await getPreparationApplications();
  return dataset.records.find((record) => record.id === id) || null;
}

export async function getApplicationForJob(jobId: string): Promise<PreparationApplicationRecord | null> {
  const dataset = await getPreparationApplications();
  return dataset.records.find((record) => record.jobId === jobId) || null;
}


async function getSupabaseDocuments(): Promise<DocumentDataset> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select(`
      id,application_id,profile_id,kind,title,cv_family,created_at,
      document_versions(
        id,version_number,structured_content,latex_source,rendered_object_key,model,prompt_version,
        change_summary,approval_status,submission_locked_at,created_at,
        document_evidence_links(evidence_item_id,claim_key)
      )
    `)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const records: DocumentRecord[] = (data || []).map((row: any) => ({
    id: row.id,
    applicationId: row.application_id,
    profileId: row.profile_id,
    kind: row.kind,
    title: row.title,
    cvFamily: row.cv_family,
    createdAt: row.created_at,
    versions: (row.document_versions || []).map((version: any) => ({
      id: version.id,
      documentId: row.id,
      versionNumber: version.version_number,
      structuredContent: version.structured_content || {},
      latexSource: version.latex_source,
      renderedObjectKey: version.rendered_object_key,
      engine: version.model,
      contractVersion: version.prompt_version,
      changeSummary: version.change_summary || [],
      approvalStatus: version.approval_status,
      approvedAt: version.approved_at,
      unsupportedClaimsCount: (version.structured_content?.unsupported_claims || []).length,
      submissionLockedAt: version.submission_locked_at,
      createdAt: version.created_at,
      evidenceLinks: (version.document_evidence_links || []).map((link: any) => ({ claimKey: link.claim_key, evidenceId: link.evidence_item_id })),
    })).sort((a: any, b: any) => b.versionNumber - a.versionNumber),
  }));
  return { source: "supabase", generatedAt: new Date().toISOString(), records };
}

export async function getDocumentDataset(): Promise<DocumentDataset> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalDocuments();
  if (mode === "supabase") return getSupabaseDocuments();
  try { return await getSupabaseDocuments(); }
  catch (error) { console.warn("Supabase document read failed; using local document store.", error); return getLocalDocuments(); }
}

export async function getApplicationCvDocument(applicationId: string): Promise<DocumentRecord | null> {
  const dataset = await getDocumentDataset();
  return dataset.records.find((item) => item.applicationId === applicationId && item.kind === "cv") || null;
}

export async function getDocumentVersionById(versionId: string) {
  const dataset = await getDocumentDataset();
  for (const document of dataset.records) {
    const version = document.versions.find((item) => item.id === versionId);
    if (version) return { source: dataset.source, document, version };
  }
  return null;
}


export async function getApplicationCoverLetterDocument(applicationId: string): Promise<DocumentRecord | null> {
  const dataset = await getDocumentDataset();
  return dataset.records.find((item) => item.applicationId === applicationId && item.kind === "cover_letter") || null;
}

async function getSupabaseApplicationContentPackage(applicationId: string): Promise<ApplicationContentPackage> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const [salaryResult, answersResult, coverLetter] = await Promise.all([
    supabase.from("application_salary_contexts").select("*").eq("application_id", applicationId).maybeSingle(),
    supabase.from("application_answers").select("*").eq("application_id", applicationId).eq("metadata->>package_source", "milestone6").order("created_at", { ascending: true }),
    getApplicationCoverLetterDocument(applicationId),
  ]);
  if (salaryResult.error) throw salaryResult.error;
  if (answersResult.error) throw answersResult.error;
  const salary: any = salaryResult.data;
  const answers = (answersResult.data || []).map((a: any) => ({
    id: a.id, questionKey: a.question_key, questionText: a.question_text, answerText: a.answer_text,
    required: a.required, trust: a.trust, category: a.metadata?.category || null,
    colour: a.metadata?.colour || (a.trust === "verified" ? "green" : a.trust === "proposed" ? "amber" : "red"),
    rationale: a.metadata?.rationale || null, evidenceIds: a.metadata?.evidence_ids || [], approvedAt: a.approved_at,
  }));
  return {
    source: "supabase",
    salary: salary ? {
      source: salary.source, advertisedText: salary.advertised_text, estimatedLow: salary.estimated_low, estimatedHigh: salary.estimated_high,
      recommendedValue: salary.recommended_value, currency: salary.currency, confidence: salary.confidence, trust: salary.trust, basis: salary.basis || [], approvedAt: salary.approved_at,
    } : null,
    answers, coverLetter,
    unresolvedRequired: answers.filter((a: any) => a.required && (a.trust === "user_required" || !a.answerText)).length,
  };
}

export async function getApplicationContentPackage(applicationId: string): Promise<ApplicationContentPackage> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalApplicationContentPackage(applicationId);
  if (mode === "supabase") return getSupabaseApplicationContentPackage(applicationId);
  try { return await getSupabaseApplicationContentPackage(applicationId); }
  catch (error) { console.warn("Supabase application content read failed; using local content package.", error); return getLocalApplicationContentPackage(applicationId); }
}


async function getSupabaseApplicationReviewPackage(applicationId: string): Promise<ApplicationReviewPackage> {
  const { createClient } = await import("@/lib/supabase/server");
  const { buildReviewChecklist } = await import("@jobhunt/review-center");
  const supabase = await createClient();
  const [packageResult, app, cvDocument, content] = await Promise.all([
    supabase.from("application_review_packages").select("*").eq("application_id", applicationId).maybeSingle(),
    getPreparationApplicationById(applicationId),
    getApplicationCvDocument(applicationId),
    getApplicationContentPackage(applicationId),
  ]);
  if (packageResult.error) throw packageResult.error;
  if (!app) throw new Error("Application not found.");
  const pkg: any = packageResult.data;
  const cvVersion = cvDocument?.versions.find((v) => v.id === pkg?.cv_version_id) || null;
  const coverVersion = content.coverLetter?.versions.find((v) => v.id === pkg?.cover_letter_version_id) || null;
  const assembled = Boolean(pkg?.assembled_at) && app.tasks.some((t) => t.taskType === "assemble_review_package" && t.state === "completed");
  const gate = buildReviewChecklist({ application: app, cvVersion, coverLetterVersion: coverVersion, coverLetterDecision: pkg?.cover_letter_decision || "not_required", salary: content.salary, answers: content.answers, assembled });
  return { source: "supabase", applicationId, cvVersionId: pkg?.cv_version_id || null, coverLetterVersionId: pkg?.cover_letter_version_id || null, coverLetterDecision: pkg?.cover_letter_decision || "not_required", assembledAt: pkg?.assembled_at || null, approvedAt: pkg?.approved_at || null, ...gate };
}

export async function getApplicationReviewPackage(applicationId: string): Promise<ApplicationReviewPackage> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalApplicationReviewPackage(applicationId);
  if (mode === "supabase") return getSupabaseApplicationReviewPackage(applicationId);
  try { return await getSupabaseApplicationReviewPackage(applicationId); }
  catch (error) { console.warn("Supabase review-package read failed; using local review state.", error); return getLocalApplicationReviewPackage(applicationId); }
}

async function getSupabaseEmailMonitoring(): Promise<import("@/lib/types").EmailMonitoringDataset> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const [syncResult, emailResult] = await Promise.all([
    supabase.from("gmail_sync_state").select("*").maybeSingle(),
    supabase.from("emails").select(`
      id,provider_message_id,sender,subject,snippet,received_at,classification,confidence,classification_reason,classification_source,classification_model,chatgpt_classified_at,needs_user,auto_applied_at,proposed_state,
      application_email_links(application_id,confidence,match_method,reason,is_primary,applications(id,jobs(title,companies(canonical_name))))
    `).order("received_at", { ascending: false }).limit(60),
  ]);
  if (syncResult.error) throw syncResult.error;
  if (emailResult.error) throw emailResult.error;
  const records = (emailResult.data || []).map((row: any) => {
    const links = (row.application_email_links || []).filter((x: any) => x.is_primary !== false).sort((a: any,b: any)=>(b.confidence||0)-(a.confidence||0));
    const link = links[0] || null;
    const app = link?.applications ? (Array.isArray(link.applications) ? link.applications[0] : link.applications) : null;
    const job = app?.jobs ? (Array.isArray(app.jobs) ? app.jobs[0] : app.jobs) : null;
    const companyRel = job?.companies ? (Array.isArray(job.companies) ? job.companies[0] : job.companies) : null;
    return {
      id: row.id, providerMessageId: row.provider_message_id, sender: row.sender, subject: row.subject, snippet: row.snippet,
      receivedAt: row.received_at, classification: row.classification, confidence: row.confidence == null ? null : Number(row.confidence),
      classificationReason: row.classification_reason, classificationSource: row.classification_source || "deterministic", classificationModel: row.classification_model || null, chatgptClassifiedAt: row.chatgpt_classified_at || null, needsUser: row.needs_user, autoAppliedAt: row.auto_applied_at, proposedState: row.proposed_state,
      applicationId: link?.application_id || null, company: companyRel?.canonical_name || null, role: job?.title || null,
      matchConfidence: link?.confidence == null ? null : Number(link.confidence), matchMethod: link?.match_method || null, matchReason: link?.reason || null,
    };
  });
  const sync: any = syncResult.data;
  return {
    source: "supabase", status: sync?.status || "never_synced", lastSyncedAt: sync?.last_synced_at || null, lastError: sync?.last_error || null,
    summary: { total: records.length, relevant: records.filter((r: any)=>r.classification && r.classification!=="other").length, needsUser: records.filter((r: any)=>r.needsUser).length, autoUpdated: records.filter((r: any)=>Boolean(r.autoAppliedAt)).length }, records,
  };
}

async function getLocalEmailMonitoring(): Promise<import("@/lib/types").EmailMonitoringDataset> {
  const fs = await import("node:fs/promises");
  const { repoPath } = await import("@/lib/repo-path");
  const { classifyRecruitingEmail, matchEmailToApplication, emailRequiresUser } = await import("@jobhunt/email-intelligence");
  const raw = JSON.parse(await fs.readFile(repoPath("data","emails","recent.json"), "utf8"));
  const tracker = await getLocalTracker();
  const candidates = tracker.records.map((r: any)=>({ id:r.id, company:r.company, role:r.role, externalJobId:r.externalJobId, appliedAt:r.applicationDate, state:r.applicationState }));
  const records = raw.records.map((email: any)=>{
    const c=classifyRecruitingEmail(email); const m=matchEmailToApplication(email,c,candidates);
    const app=tracker.records.find((r: any)=>r.id===m.applicationId);
    return { id:email.id,providerMessageId:email.id,sender:email.sender,subject:email.subject,snippet:email.snippet,receivedAt:email.receivedAt,classification:c.classification,confidence:c.confidence,classificationReason:c.reason,classificationSource:"deterministic",classificationModel:null,chatgptClassifiedAt:null,needsUser:emailRequiresUser(c,m),autoAppliedAt:null,proposedState:c.classification==="assessment"?"assessment":c.classification==="rejection"?"rejected":null,applicationId:m.applicationId,company:app?.company||null,role:app?.role||null,matchConfidence:m.confidence,matchMethod:m.method,matchReason:m.reason };
  });
  return { source:"local_snapshot", status:"local_snapshot", lastSyncedAt:null,lastError:null,summary:{total:records.length,relevant:records.filter((r:any)=>r.classification!=="other").length,needsUser:records.filter((r:any)=>r.needsUser).length,autoUpdated:0},records };
}

export async function getEmailMonitoringDataset(): Promise<import("@/lib/types").EmailMonitoringDataset> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) return getLocalEmailMonitoring();
  if (mode === "supabase") return getSupabaseEmailMonitoring();
  try { return await getSupabaseEmailMonitoring(); }
  catch (error) { console.warn("Supabase email monitoring read failed; using local email fixture.", error); return getLocalEmailMonitoring(); }
}

export async function getApplicationEmailActivity(applicationId: string) {
  const dataset = await getEmailMonitoringDataset();
  return { ...dataset, records: dataset.records.filter((record) => record.applicationId === applicationId) };
}

function progressionSummary(assessments: import("@/lib/types").AssessmentWorkspaceRecord[], interviews: import("@/lib/types").InterviewWorkspaceRecord[]) {
  const now = Date.now();
  const within72 = (value: string | null) => {
    if (!value) return false;
    const ts = new Date(value).valueOf();
    return Number.isFinite(ts) && ts >= now && ts - now <= 72 * 3600000;
  };
  return {
    assessments: assessments.length,
    interviews: interviews.length,
    dueSoon: assessments.filter((a) => within72(a.deadlineAt) && !["completed", "cancelled", "expired"].includes(a.status)).length
      + interviews.filter((i) => within72(i.scheduledAt) && !["completed", "cancelled"].includes(i.status)).length,
    needsPreparation: assessments.filter((a) => a.preparationStatus === "not_prepared" && !["completed", "cancelled", "expired"].includes(a.status)).length
      + interviews.filter((i) => i.preparationStatus === "not_prepared" && !["completed", "cancelled"].includes(i.status)).length,
  };
}

async function getSupabaseProgressionDataset(): Promise<import("@/lib/types").ProgressionDataset> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const [assessmentResult, interviewResult, versionResult] = await Promise.all([
    supabase.from("assessments").select(`
      id,application_id,provider,assessment_type,invited_at,deadline_at,estimated_minutes,status,notes,source_email_id,
      preparation_status,current_preparation_version_id,created_at,updated_at,
      applications(id,jobs(title,companies(canonical_name)))
    `).order("deadline_at", { ascending: true, nullsFirst: false }),
    supabase.from("interviews").select(`
      id,application_id,interview_type,round_label,scheduled_at,participants,status,notes,source_email_id,
      preparation_status,current_preparation_version_id,created_at,updated_at,
      applications(id,jobs(title,companies(canonical_name)))
    `).order("scheduled_at", { ascending: true, nullsFirst: false }),
    supabase.from("workflow_preparation_versions").select("*").order("created_at", { ascending: false }),
  ]);
  for (const result of [assessmentResult, interviewResult, versionResult]) if (result.error) throw result.error;
  const versions = (versionResult.data || []).map((v: any) => ({
    id: v.id,
    versionNumber: v.version_number,
    contextQuality: v.context_quality,
    contextSnapshot: v.context_snapshot || {},
    preparationPackage: v.preparation_package || {},
    generator: v.generator || "deterministic_v1",
    createdAt: v.created_at,
    assessmentId: v.assessment_id,
    interviewId: v.interview_id,
  }));
  const companyRole = (row: any) => {
    const app = Array.isArray(row.applications) ? row.applications[0] : row.applications;
    const job = app?.jobs ? (Array.isArray(app.jobs) ? app.jobs[0] : app.jobs) : null;
    const companyRel = job?.companies ? (Array.isArray(job.companies) ? job.companies[0] : job.companies) : null;
    return { company: companyRel?.canonical_name || "Unknown company", role: job?.title || "Unknown role" };
  };
  const assessments = (assessmentResult.data || []).map((row: any) => {
    const identity = companyRole(row);
    return {
      id: row.id, applicationId: row.application_id, ...identity, provider: row.provider, assessmentType: row.assessment_type,
      invitedAt: row.invited_at, deadlineAt: row.deadline_at, estimatedMinutes: row.estimated_minutes, status: row.status,
      preparationStatus: row.preparation_status || "not_prepared", notes: row.notes, sourceEmailId: row.source_email_id,
      currentPreparationVersionId: row.current_preparation_version_id,
      preparationVersions: versions.filter((v: any) => v.assessmentId === row.id).map(({ assessmentId: _a, interviewId: _i, ...v }: any) => v),
    } as import("@/lib/types").AssessmentWorkspaceRecord;
  });
  const interviews = (interviewResult.data || []).map((row: any) => {
    const identity = companyRole(row);
    return {
      id: row.id, applicationId: row.application_id, ...identity, interviewType: row.interview_type, roundLabel: row.round_label,
      scheduledAt: row.scheduled_at, participants: row.participants || [], status: row.status,
      preparationStatus: row.preparation_status || "not_prepared", notes: row.notes, sourceEmailId: row.source_email_id,
      currentPreparationVersionId: row.current_preparation_version_id,
      preparationVersions: versions.filter((v: any) => v.interviewId === row.id).map(({ assessmentId: _a, interviewId: _i, ...v }: any) => v),
    } as import("@/lib/types").InterviewWorkspaceRecord;
  });
  return { source: "supabase", generatedAt: new Date().toISOString(), summary: progressionSummary(assessments, interviews), assessments, interviews };
}

export async function getProgressionDataset(): Promise<import("@/lib/types").ProgressionDataset> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) {
    const { getLocalProgressionDataset } = await import("@/lib/data/local");
    return getLocalProgressionDataset();
  }
  if (mode === "supabase") return getSupabaseProgressionDataset();
  try { return await getSupabaseProgressionDataset(); }
  catch (error) {
    console.warn("Supabase progression read failed; using local progression fixture.", error);
    const { getLocalProgressionDataset } = await import("@/lib/data/local");
    return getLocalProgressionDataset();
  }
}

export async function getAssessmentWorkspaceById(id: string) {
  const dataset = await getProgressionDataset();
  return dataset.assessments.find((record) => record.id === id) || null;
}

export async function getInterviewWorkspaceById(id: string) {
  const dataset = await getProgressionDataset();
  return dataset.interviews.find((record) => record.id === id) || null;
}

export async function getProgressionApplicationContext(applicationId: string): Promise<any> {
  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) {
    const tracker = await getLocalTracker();
    const profile = await getLocalProfile();
    const rowNumber = applicationId.startsWith("tracker-row-") ? Number(applicationId.replace("tracker-row-", "")) : NaN;
    const record = tracker.records.find((r) => r.id === applicationId || (!Number.isNaN(rowNumber) && r.sourceRow === rowNumber));
    if (!record) throw new Error("Application context not found.");
    return {
      quality: "best_available",
      capturedAt: new Date().toISOString(),
      applicationId,
      company: record.company,
      role: record.role,
      strategy: record.notes || "Historical application imported from the tracker; exact application strategy is not available.",
      selectedCvFamily: null,
      cvVersionId: null,
      coverLetterVersionId: null,
      screeningAnswers: [],
      salaryExpectation: null,
      jobDescription: null,
      strengths: [],
      weaknesses: [],
      evidence: profile.evidence.filter((e) => e.status === "verified").sort((a, b) => b.strength - a.strength).slice(0, 8).map((e) => ({ id: e.evidenceKey, claim: e.claim, detail: e.detail })),
    };
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: app, error: appError } = await supabase.from("applications").select(`
    id,state,selected_cv_family,job_id,job_snapshot_id,job_analysis_id,submitted_at,source_tracker_values,
    jobs(title,description_text,companies(canonical_name)),
    application_strategies(id,strategy_text,evidence_item_ids,created_at)
  `).eq("id", applicationId).single();
  if (appError) throw appError;

  const submissionResult = await supabase.from("application_submission_contexts").select("*").eq("application_id", applicationId).maybeSingle();
  if (submissionResult.error) throw submissionResult.error;
  if (submissionResult.data) return { ...(submissionResult.data.context_snapshot || {}), quality: "exact_submitted", capturedAt: submissionResult.data.locked_at, applicationId };

  const [documentsResult, answersResult, salaryResult, analysisResult, snapshotResult] = await Promise.all([
    supabase.from("documents").select(`id,kind,document_versions(id,version_number,structured_content,approval_status,submission_locked_at,created_at)`).eq("application_id", applicationId),
    supabase.from("application_answers").select("question_text,answer_text,approved_at,created_at").eq("application_id", applicationId).order("created_at", { ascending: true }),
    supabase.from("application_salary_contexts").select("recommended_value,approved_at").eq("application_id", applicationId).maybeSingle(),
    app.job_analysis_id ? supabase.from("job_analyses").select("strengths,weaknesses,evidence_item_ids").eq("id", app.job_analysis_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    app.job_snapshot_id ? supabase.from("job_snapshots").select("description_text").eq("id", app.job_snapshot_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const result of [documentsResult, answersResult, salaryResult, analysisResult, snapshotResult]) if (result.error) throw result.error;
  const docs: any[] = documentsResult.data || [];
  const pickVersion = (kind: string) => {
    const doc = docs.find((d: any) => d.kind === kind);
    const versions = [...(doc?.document_versions || [])].sort((a: any, b: any) => b.version_number - a.version_number);
    return versions.find((v: any) => v.submission_locked_at) || versions.find((v: any) => v.approval_status === "submitted") || versions.find((v: any) => v.approval_status === "approved") || versions[0] || null;
  };
  const cv = pickVersion("cv");
  const cover = pickVersion("cover_letter");
  const strategyRows: any[] = (app as any).application_strategies || [];
  const strategy = [...strategyRows].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  const analysis: any = analysisResult.data;
  const evidenceIds = strategy?.evidence_item_ids || analysis?.evidence_item_ids || [];
  const evidenceResult = evidenceIds.length ? await supabase.from("evidence_items").select("id,claim,detail").in("id", evidenceIds) : { data: [], error: null };
  if (evidenceResult.error) throw evidenceResult.error;
  const job = Array.isArray((app as any).jobs) ? (app as any).jobs[0] : (app as any).jobs;
  const companyRel = job?.companies ? (Array.isArray(job.companies) ? job.companies[0] : job.companies) : null;
  const approvedQuality = ["content_approved", "form_in_progress", "form_needs_user", "final_review", "approved_for_submission", "submitted", "awaiting_response", "assessment", "interview", "offer", "rejected"].includes((app as any).state) && cv?.approval_status === "approved";
  return {
    quality: approvedQuality ? "approved_pre_submission" : "best_available",
    capturedAt: new Date().toISOString(), applicationId,
    company: companyRel?.canonical_name || "Unknown company", role: job?.title || "Unknown role",
    strategy: strategy?.strategy_text || "No structured application strategy is available for this historical application.",
    selectedCvFamily: (app as any).selected_cv_family || null,
    cvVersionId: cv?.id || null, coverLetterVersionId: cover?.id || null,
    screeningAnswers: (answersResult.data || []).filter((a: any) => a.answer_text).map((a: any) => ({ question: a.question_text, answer: a.answer_text })),
    salaryExpectation: salaryResult.data?.recommended_value || null,
    jobDescription: snapshotResult.data?.description_text || job?.description_text || null,
    strengths: (analysis?.strengths || []).map((s: any) => typeof s === "string" ? s : s.description).filter(Boolean),
    weaknesses: (analysis?.weaknesses || []).map((w: any) => typeof w === "string" ? w : w.description).filter(Boolean),
    evidence: (evidenceResult.data || []).map((e: any) => ({ id: e.id, claim: e.claim, detail: e.detail })),
  };
}
