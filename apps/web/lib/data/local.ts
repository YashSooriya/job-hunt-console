import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildApplicationPreparationPlan, preparationProgress } from "@jobhunt/application-preparation";
import { buildReviewChecklist } from "@jobhunt/review-center";
import { repoPath } from "@/lib/repo-path";
import type {
  CandidateProfileData,
  JobDataset,
  JobRecord,
  PreparationApplicationDataset,
  PreparationApplicationRecord,
  ApplicationReviewPackage,
  TrackerDataset,
} from "@/lib/types";

export async function getLocalTracker(): Promise<TrackerDataset> {
  const raw = JSON.parse(
    await fs.readFile(repoPath("data", "imports", "tracker.normalized.json"), "utf8")
  );
  return {
    source: "local_snapshot",
    generatedAt: raw.generatedAt ?? null,
    summary: raw.summary,
    quality: raw.quality || { issueCount: 0, errorCount: 0, warningCount: 0, infoCount: 0, issues: [] },
    records: raw.records,
  };
}

export async function getLocalProfile(): Promise<CandidateProfileData> {
  const knowledge = JSON.parse(
    await fs.readFile(repoPath("data", "knowledge", "knowledge-base.generated.json"), "utf8")
  );
  const manifest = JSON.parse(
    await fs.readFile(repoPath("data", "knowledge", "source-manifest.json"), "utf8")
  );

  return {
    source: "local_snapshot",
    displayName: knowledge.profile?.display_name || "Candidate",
    facts: (knowledge.profile?.facts || []).map((fact: any) => ({
      factKey: fact.fact_key,
      value: fact.value,
      status: fact.status,
      sourceKey: fact.source_key ?? null,
    })),
    evidence: (knowledge.evidence || []).map((item: any) => ({
      evidenceKey: item.evidence_key,
      category: item.category,
      claim: item.claim,
      detail: item.detail ?? null,
      tags: item.tags || [],
      strength: item.strength,
      status: item.status,
      sourceKey: item.source_key ?? null,
      sourceLocator: item.source_locator ?? null,
    })),
    sources: (manifest.sources || []).map((source: any) => ({
      sourceKey: source.source_key,
      title: source.title,
      sourceType: source.source_type,
      provider: source.provider ?? null,
    })),
    preferences: knowledge.preferences || {},
  };
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

export async function getLocalJobs(): Promise<JobDataset> {
  const path = repoPath("data", "jobs", "inbox.json");
  let raw: any = { generatedAt: null, records: [] };
  try { raw = JSON.parse(await fs.readFile(path, "utf8")); } catch {}
  const records = (raw.records || []) as JobRecord[];
  return {
    source: "local_snapshot",
    generatedAt: raw.generatedAt ?? null,
    summary: jobSummary(records),
    records,
  };
}

export async function saveLocalJob(record: JobRecord): Promise<JobRecord> {
  const path = repoPath("data", "jobs", "inbox.json");
  const dataset = await getLocalJobs();
  const records = [...dataset.records];
  const index = records.findIndex((item) => item.dedupeKey && record.dedupeKey && item.dedupeKey === record.dedupeKey);
  if (index >= 0) {
    record.id = records[index].id;
    records[index] = record;
  } else {
    records.unshift(record);
  }
  await fs.writeFile(path, JSON.stringify({ schemaVersion: "1.0.0", generatedAt: new Date().toISOString(), records }, null, 2) + "\n");
  return record;
}

function applicationSummary(records: PreparationApplicationRecord[]) {
  return {
    total: records.length,
    autoPrepared: records.filter((item) => item.origin === "auto_prepare").length,
    preparing: records.filter((item) => item.state === "preparing").length,
    readyForReview: records.filter((item) => item.state === "ready_for_review").length,
    needsUser: records.filter((item) => item.tasks.some((task) => task.state === "needs_user")).length,
  };
}

export async function getLocalPreparationApplications(): Promise<PreparationApplicationDataset> {
  const path = repoPath("data", "applications", "preparing.json");
  let raw: any = { generatedAt: null, records: [] };
  try { raw = JSON.parse(await fs.readFile(path, "utf8")); } catch {}
  const records = (raw.records || []) as PreparationApplicationRecord[];
  return {
    source: "local_snapshot",
    generatedAt: raw.generatedAt ?? null,
    summary: applicationSummary(records),
    records,
  };
}

export async function saveLocalApplicationFromJob(
  job: JobRecord,
  origin: "manual" | "auto_prepare" = "manual"
): Promise<PreparationApplicationRecord> {
  const path = repoPath("data", "applications", "preparing.json");
  const dataset = await getLocalPreparationApplications();
  const existing = dataset.records.find((item) => item.jobId === job.id);
  if (existing) return existing;

  const plan = buildApplicationPreparationPlan(job, { origin });
  const now = new Date().toISOString();
  const tasks = plan.tasks.map((item) => ({ ...item, id: randomUUID(), createdAt: now, updatedAt: now }));
  const record: PreparationApplicationRecord = {
    id: randomUUID(),
    jobId: job.id,
    company: job.company,
    role: job.title,
    state: plan.state,
    origin: plan.origin,
    selectedCvFamily: plan.selectedCvFamily,
    strategyText: plan.strategyText,
    evidenceIds: plan.evidenceIds,
    nextAction: plan.nextAction,
    notes: origin === "auto_prepare" ? "Application created automatically from a high-confidence job match." : null,
    salaryText: job.salaryText,
    fitScore: job.analysis?.fitScore ?? null,
    priorityScore: job.analysis?.priorityScore ?? null,
    triage: job.analysis?.triage ?? null,
    jobSnapshotId: null,
    jobAnalysisId: job.analysis?.id || null,
    createdAt: now,
    updatedAt: now,
    tasks,
    progress: preparationProgress(tasks),
  };

  const records = [record, ...dataset.records];
  await fs.writeFile(path, JSON.stringify({ schemaVersion: "1.0.0", generatedAt: now, records }, null, 2) + "\n");
  return record;
}

export async function getLocalDocuments() {
  const path = repoPath("data", "documents", "documents.json");
  let raw: any = { generatedAt: null, records: [] };
  try { raw = JSON.parse(await fs.readFile(path, "utf8")); } catch {}
  return { source: "local_snapshot" as const, generatedAt: raw.generatedAt ?? null, records: raw.records || [] };
}

export async function saveLocalCvVersion(args: {
  applicationId: string;
  cvFamily: any;
  structuredContent: any;
  latexSource: string;
  pdf: Buffer;
  evidenceLinks: Array<{ claimKey: string; evidenceId: string }>;
  engine: string;
}) {
  const documentsPath = repoPath("data", "documents", "documents.json");
  const latexDir = repoPath("data", "documents", "latex");
  const renderedDir = repoPath("data", "documents", "rendered");
  await fs.mkdir(latexDir, { recursive: true });
  await fs.mkdir(renderedDir, { recursive: true });
  const dataset = await getLocalDocuments();
  const records: any[] = [...dataset.records];
  let document = records.find((item: any) => item.applicationId === args.applicationId && item.kind === "cv");
  const now = new Date().toISOString();
  if (!document) {
    document = { id: randomUUID(), applicationId: args.applicationId, profileId: null, kind: "cv", title: `${args.cvFamily} CV`, cvFamily: args.cvFamily, createdAt: now, versions: [] };
    records.unshift(document);
  }
  const versionNumber = Math.max(0, ...(document.versions || []).map((v: any) => Number(v.versionNumber) || 0)) + 1;
  const versionId = randomUUID();
  const latexRelative = `data/documents/latex/${versionId}.tex`;
  const pdfRelative = `data/documents/rendered/${versionId}.pdf`;
  await fs.writeFile(repoPath(...latexRelative.split("/")), args.latexSource, "utf8");
  await fs.writeFile(repoPath(...pdfRelative.split("/")), args.pdf);
  const version = {
    id: versionId, documentId: document.id, versionNumber,
    structuredContent: args.structuredContent, latexSource: args.latexSource,
    latexPath: latexRelative, renderedObjectKey: pdfRelative, engine: args.engine,
    contractVersion: args.structuredContent.contract_version || null,
    changeSummary: args.structuredContent.change_summary || [], approvalStatus: "needs_review",
    unsupportedClaimsCount: (args.structuredContent.unsupported_claims || []).length,
    submissionLockedAt: null, createdAt: now, evidenceLinks: args.evidenceLinks,
  };
  document.versions = [version, ...(document.versions || [])];
  await fs.writeFile(documentsPath, JSON.stringify({ schemaVersion: "1.0.0", generatedAt: now, records }, null, 2) + "\n");

  const appsPath = repoPath("data", "applications", "preparing.json");
  const apps = await getLocalPreparationApplications();
  const app = apps.records.find((item) => item.id === args.applicationId);
  if (app) {
    const task = app.tasks.find((item) => item.taskType === "prepare_cv");
    if (task) {
      task.state = "completed";
      task.output = { documentId: document.id, documentVersionId: versionId, versionNumber, unsupportedClaimsCount: 0, engine: args.engine };
      task.updatedAt = now;
    }
    app.updatedAt = now;
    app.progress = preparationProgress(app.tasks);
    await fs.writeFile(appsPath, JSON.stringify({ schemaVersion: "1.0.0", generatedAt: now, records: apps.records }, null, 2) + "\n");
  }
  return { document, version };
}

export async function saveLocalApplicationContentPackage(args: {
  applicationId: string;
  salary: any;
  answers: any[];
  coverLetter: any | null;
  latexSource: string | null;
  pdf: Buffer | null;
  evidenceLinks: Array<{ claimKey: string; evidenceId: string }>;
  engine: string;
}) {
  const now = new Date().toISOString();
  const contentDir = repoPath("data", "applications", "content");
  await fs.mkdir(contentDir, { recursive: true });
  const packagePath = pathForApplicationContent(args.applicationId);
  let coverLetterDocumentId: string | null = null;
  let coverLetterVersionId: string | null = null;

  if (args.coverLetter && args.latexSource && args.pdf) {
    const documentsPath = repoPath("data", "documents", "documents.json");
    const latexDir = repoPath("data", "documents", "latex");
    const renderedDir = repoPath("data", "documents", "rendered");
    await fs.mkdir(latexDir, { recursive: true });
    await fs.mkdir(renderedDir, { recursive: true });
    const dataset = await getLocalDocuments();
    const records: any[] = [...dataset.records];
    let document = records.find((item: any) => item.applicationId === args.applicationId && item.kind === "cover_letter");
    if (!document) {
      document = { id: randomUUID(), applicationId: args.applicationId, profileId: null, kind: "cover_letter", title: "Cover Letter", cvFamily: null, createdAt: now, versions: [] };
      records.unshift(document);
    }
    const versionNumber = Math.max(0, ...(document.versions || []).map((v: any) => Number(v.versionNumber) || 0)) + 1;
    const versionId = randomUUID();
    const latexRelative = `data/documents/latex/${versionId}-cover-letter.tex`;
    const pdfRelative = `data/documents/rendered/${versionId}-cover-letter.pdf`;
    await fs.writeFile(repoPath(...latexRelative.split("/")), args.latexSource, "utf8");
    await fs.writeFile(repoPath(...pdfRelative.split("/")), args.pdf);
    const version = {
      id: versionId, documentId: document.id, versionNumber,
      structuredContent: args.coverLetter, latexSource: args.latexSource,
      latexPath: latexRelative, renderedObjectKey: pdfRelative, engine: args.engine,
      contractVersion: args.coverLetter.contract_version || null,
      changeSummary: args.coverLetter.change_summary || [], approvalStatus: "needs_review",
      unsupportedClaimsCount: (args.coverLetter.unsupported_claims || []).length,
      submissionLockedAt: null, createdAt: now, evidenceLinks: args.evidenceLinks,
    };
    document.versions = [version, ...(document.versions || [])];
    await fs.writeFile(documentsPath, JSON.stringify({ schemaVersion: "1.0.0", generatedAt: now, records }, null, 2) + "\n");
    coverLetterDocumentId = document.id;
    coverLetterVersionId = versionId;
  }

  const unresolved = args.answers.filter((a: any) => a.required && (a.trust === "user_required" || !a.answer_text)).length;
  const content = { schemaVersion: "1.0.0", generatedAt: now, salary: args.salary, answers: args.answers, unresolvedRequired: unresolved };
  await fs.writeFile(packagePath, JSON.stringify(content, null, 2) + "\n");

  const appsPath = repoPath("data", "applications", "preparing.json");
  const apps = await getLocalPreparationApplications();
  const app = apps.records.find((item) => item.id === args.applicationId);
  if (app) {
    for (const task of app.tasks) {
      if (task.taskType === "research_salary") {
        task.state = "completed"; task.output = { salaryContext: args.salary }; task.updatedAt = now;
      }
      if (task.taskType === "prepare_screening_answers") {
        task.state = unresolved ? "needs_user" : "completed";
        task.output = { answerCount: args.answers.length, unresolvedUserRequired: unresolved };
        task.updatedAt = now;
      }
      if (task.taskType === "prepare_cover_letter" && args.coverLetter) {
        task.state = "completed";
        task.output = { documentId: coverLetterDocumentId, documentVersionId: coverLetterVersionId, engine: args.engine };
        task.updatedAt = now;
      }
    }
    app.updatedAt = now;
    app.progress = preparationProgress(app.tasks);
    await fs.writeFile(appsPath, JSON.stringify({ schemaVersion: "1.0.0", generatedAt: now, records: apps.records }, null, 2) + "\n");
  }
  return { source: "local_snapshot" as const, application_id: args.applicationId, cover_letter_document_id: coverLetterDocumentId, cover_letter_version_id: coverLetterVersionId, screening_answer_count: args.answers.length, unresolved_user_required: unresolved, salary_context: args.salary };
}

function pathForApplicationContent(applicationId: string) {
  return repoPath("data", "applications", "content", `${applicationId}.json`);
}

export async function getLocalApplicationContentPackage(applicationId: string) {
  let raw: any = null;
  try { raw = JSON.parse(await fs.readFile(pathForApplicationContent(applicationId), "utf8")); } catch {}
  const documents = await getLocalDocuments();
  const coverLetter = documents.records.find((item: any) => item.applicationId === applicationId && item.kind === "cover_letter") || null;
  return {
    source: "local_snapshot" as const,
    salary: raw?.salary ? {
      source: raw.salary.source,
      advertisedText: raw.salary.advertised_text ?? null,
      estimatedLow: raw.salary.estimated_low ?? null,
      estimatedHigh: raw.salary.estimated_high ?? null,
      recommendedValue: raw.salary.recommended_value ?? null,
      currency: raw.salary.currency || "GBP",
      confidence: raw.salary.confidence || "medium",
      trust: raw.salary.trust || "proposed",
      basis: raw.salary.basis || [],
      approvedAt: raw.salary.approved_at ?? null,
    } : null,
    answers: (raw?.answers || []).map((a: any) => ({
      questionKey: a.question_key ?? null, questionText: a.question_text, answerText: a.answer_text ?? null,
      required: Boolean(a.required), trust: a.trust, category: a.category ?? null, colour: a.colour,
      rationale: a.rationale ?? null, evidenceIds: a.evidence_ids || [], approvedAt: a.approved_at ?? null,
    })),
    coverLetter,
    unresolvedRequired: raw?.unresolvedRequired ?? 0,
  };
}

function pathForApplicationReview(applicationId: string) {
  return repoPath("data", "applications", "review", `${applicationId}.json`);
}

async function writeLocalApplications(dataset: PreparationApplicationDataset) {
  const now = new Date().toISOString();
  await fs.writeFile(repoPath("data", "applications", "preparing.json"), JSON.stringify({ schemaVersion: "1.0.0", generatedAt: now, records: dataset.records }, null, 2) + "\n");
}

async function readLocalReviewRaw(applicationId: string) {
  try { return JSON.parse(await fs.readFile(pathForApplicationReview(applicationId), "utf8")); } catch { return null; }
}

async function writeLocalReviewRaw(applicationId: string, raw: any) {
  await fs.mkdir(repoPath("data", "applications", "review"), { recursive: true });
  await fs.writeFile(pathForApplicationReview(applicationId), JSON.stringify(raw, null, 2) + "\n");
}

export async function assembleLocalApplicationReviewPackage(applicationId: string) {
  const apps = await getLocalPreparationApplications();
  const app = apps.records.find((x) => x.id === applicationId);
  if (!app) throw new Error("Application not found.");
  const docs = await getLocalDocuments();
  const cvDoc: any = docs.records.find((d: any) => d.applicationId === applicationId && d.kind === "cv");
  const cvVersion: any = cvDoc?.versions?.[0];
  if (!cvVersion || cvVersion.unsupportedClaimsCount !== 0 || !cvVersion.renderedObjectKey) throw new Error("A rendered evidence-backed CV is required before Ready for Review.");
  const coverTask = app.tasks.find((t) => t.taskType === "prepare_cover_letter");
  if (!coverTask || coverTask.state !== "completed") throw new Error("Cover-letter preparation is not complete.");
  const skipped = Boolean((coverTask.output as any)?.skipped);
  const coverDoc: any = docs.records.find((d: any) => d.applicationId === applicationId && d.kind === "cover_letter");
  const coverVersion: any = coverDoc?.versions?.[0] || null;
  if (!skipped && (!coverVersion || !coverVersion.renderedObjectKey)) throw new Error("A rendered cover letter is required before Ready for Review.");
  const content = await getLocalApplicationContentPackage(applicationId);
  if (!content.salary) throw new Error("Salary context is required before Ready for Review.");
  const screeningTask = app.tasks.find((t) => t.taskType === "prepare_screening_answers");
  if (!screeningTask || !["completed", "needs_user"].includes(screeningTask.state)) throw new Error("Screening-answer package is not prepared.");
  const now = new Date().toISOString();
  const raw = { applicationId, cvVersionId: cvVersion.id, coverLetterVersionId: skipped ? null : coverVersion.id, coverLetterDecision: skipped ? "not_required" : "use", assembledAt: now, approvedAt: null };
  await writeLocalReviewRaw(applicationId, raw);
  const task = app.tasks.find((t) => t.taskType === "assemble_review_package");
  if (task) { task.state = "completed"; task.output = { cvVersionId: raw.cvVersionId, coverLetterVersionId: raw.coverLetterVersionId, coverLetterDecision: raw.coverLetterDecision }; task.updatedAt = now; }
  app.state = "ready_for_review";
  app.nextAction = "Review and approve the prepared application package.";
  app.updatedAt = now;
  app.progress = preparationProgress(app.tasks);
  await writeLocalApplications(apps);
  return raw;
}

export async function getLocalApplicationReviewPackage(applicationId: string): Promise<ApplicationReviewPackage> {
  const raw = await readLocalReviewRaw(applicationId);
  const apps = await getLocalPreparationApplications();
  const app = apps.records.find((x) => x.id === applicationId);
  if (!app) throw new Error("Application not found.");
  const docs = await getLocalDocuments();
  const content = await getLocalApplicationContentPackage(applicationId);
  const cvDoc: any = docs.records.find((d: any) => d.applicationId === applicationId && d.kind === "cv");
  const coverDoc: any = docs.records.find((d: any) => d.applicationId === applicationId && d.kind === "cover_letter");
  const cvVersion = cvDoc?.versions?.find((v: any) => v.id === raw?.cvVersionId) || null;
  const coverVersion = coverDoc?.versions?.find((v: any) => v.id === raw?.coverLetterVersionId) || null;
  const assembled = Boolean(raw?.assembledAt) && app.tasks.some((t) => t.taskType === "assemble_review_package" && t.state === "completed");
  const gate = buildReviewChecklist({ application: app, cvVersion, coverLetterVersion: coverVersion, coverLetterDecision: raw?.coverLetterDecision || "not_required", salary: content.salary, answers: content.answers, assembled });
  return { source: "local_snapshot", applicationId, cvVersionId: raw?.cvVersionId || null, coverLetterVersionId: raw?.coverLetterVersionId || null, coverLetterDecision: raw?.coverLetterDecision || "not_required", assembledAt: raw?.assembledAt || null, approvedAt: raw?.approvedAt || null, ...gate };
}

export async function reviewLocalApplicationAction(applicationId: string, action: string, payload: any = {}) {
  const apps = await getLocalPreparationApplications();
  const app = apps.records.find((x) => x.id === applicationId);
  if (!app) throw new Error("Application not found.");
  if (action === "assemble") return assembleLocalApplicationReviewPackage(applicationId);
  if (app.state !== "ready_for_review") throw new Error("Application must be Ready for Review.");
  const now = new Date().toISOString();
  const review = await readLocalReviewRaw(applicationId);
  if (!review) throw new Error("Review package has not been assembled.");

  if (action === "document") {
    const docsPath = repoPath("data", "documents", "documents.json");
    const docs = await getLocalDocuments();
    let found: any = null;
    for (const d of docs.records as any[]) for (const v of d.versions || []) if (v.id === payload.versionId && d.applicationId === applicationId) found = v;
    if (!found) throw new Error("Document version not found.");
    found.approvalStatus = payload.decision === "approve" ? "approved" : "rejected";
    found.approvedAt = payload.decision === "approve" ? now : null;
    await fs.writeFile(docsPath, JSON.stringify({ schemaVersion: "1.0.0", generatedAt: now, records: docs.records }, null, 2) + "\n");
  } else if (action === "salary") {
    const contentPath = pathForApplicationContent(applicationId);
    const rawContent = JSON.parse(await fs.readFile(contentPath, "utf8"));
    const value = Number(payload.recommendedValue);
    if (!value || value <= 0) throw new Error("A positive salary expectation is required.");
    rawContent.salary.recommended_value = value;
    rawContent.salary.approved_at = now;
    await fs.writeFile(contentPath, JSON.stringify(rawContent, null, 2) + "\n");
  } else if (action === "answer") {
    const contentPath = pathForApplicationContent(applicationId);
    const rawContent = JSON.parse(await fs.readFile(contentPath, "utf8"));
    const answer = rawContent.answers.find((a: any) => (payload.answerId && a.id === payload.answerId) || a.question_key === payload.questionKey);
    if (!answer) throw new Error("Answer not found.");
    const text = String(payload.answerText || "").trim();
    if (answer.required && !text) throw new Error("A required answer cannot be approved blank.");
    if (answer.trust === "verified" && text && text !== answer.answer_text) throw new Error("Verified answers cannot be edited.");
    if (answer.trust !== "verified") answer.answer_text = text || null;
    answer.approved_at = now;
    rawContent.unresolvedRequired = rawContent.answers.filter((a: any) => a.required && !String(a.answer_text || "").trim()).length;
    await fs.writeFile(contentPath, JSON.stringify(rawContent, null, 2) + "\n");
  } else if (action === "cover_letter") {
    if (!["use", "remove"].includes(payload.decision)) throw new Error("Unsupported cover-letter decision.");
    review.coverLetterDecision = payload.decision;
    if (payload.decision === "remove") review.coverLetterVersionId = null;
    else {
      const docs = await getLocalDocuments();
      const doc: any = docs.records.find((d: any) => d.applicationId === applicationId && d.kind === "cover_letter");
      if (!doc?.versions?.[0]) throw new Error("No cover-letter version exists.");
      review.coverLetterVersionId = doc.versions[0].id;
    }
  } else if (action === "approve") {
    const gate = await getLocalApplicationReviewPackage(applicationId);
    if (!gate.canApprove) throw new Error(`${gate.unresolvedCount} review item(s) remain unresolved.`);
    review.approvedAt = now;
    app.state = "content_approved";
    app.nextAction = "Complete the employer application form using the approved package.";
    app.updatedAt = now;
    await writeLocalApplications(apps);
  } else throw new Error("Unsupported review action.");

  if (action !== "approve") review.approvedAt = null;
  await writeLocalReviewRaw(applicationId, review);
  return { ok: true, action };
}

export async function getLocalProgressionDataset(): Promise<import("@/lib/types").ProgressionDataset> {
  const raw = JSON.parse(await fs.readFile(repoPath("data", "progression", "workflows.json"), "utf8"));
  const assessments = raw.assessments || [];
  const interviews = raw.interviews || [];
  const now = Date.now();
  const dueSoon = assessments.filter((a: any) => a.deadlineAt && new Date(a.deadlineAt).valueOf() >= now && new Date(a.deadlineAt).valueOf() - now <= 72 * 3600000).length
    + interviews.filter((i: any) => i.scheduledAt && new Date(i.scheduledAt).valueOf() >= now && new Date(i.scheduledAt).valueOf() - now <= 72 * 3600000).length;
  return {
    source: "local_snapshot",
    generatedAt: raw.generatedAt || null,
    summary: {
      assessments: assessments.length,
      interviews: interviews.length,
      dueSoon,
      needsPreparation: assessments.filter((a: any) => a.preparationStatus === "not_prepared").length + interviews.filter((i: any) => i.preparationStatus === "not_prepared").length,
    },
    assessments,
    interviews,
  };
}

export async function saveLocalProgressionPreparation(args: {
  kind: "assessment" | "interview";
  workflowId: string;
  contextQuality: import("@/lib/types").ProgressionContextQuality;
  contextSnapshot: Record<string, any>;
  preparationPackage: Record<string, any>;
  generator: string;
}) {
  const path = repoPath("data", "progression", "workflows.json");
  const raw = JSON.parse(await fs.readFile(path, "utf8"));
  const list = args.kind === "assessment" ? raw.assessments : raw.interviews;
  const record = (list || []).find((item: any) => item.id === args.workflowId);
  if (!record) throw new Error("Progression workflow not found.");
  const now = new Date().toISOString();
  const versionNumber = Math.max(0, ...(record.preparationVersions || []).map((v: any) => Number(v.versionNumber) || 0)) + 1;
  const version = {
    id: randomUUID(),
    versionNumber,
    contextQuality: args.contextQuality,
    contextSnapshot: args.contextSnapshot,
    preparationPackage: args.preparationPackage,
    generator: args.generator,
    createdAt: now,
  };
  record.preparationVersions = [version, ...(record.preparationVersions || [])];
  record.currentPreparationVersionId = version.id;
  record.preparationStatus = "prepared";
  raw.generatedAt = now;
  await fs.writeFile(path, JSON.stringify(raw, null, 2) + "\n");
  return version;
}
