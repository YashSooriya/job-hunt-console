import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { collectEvidenceLinks, CV_ENGINE_VERSION, loadBaseCvFamilies, renderCvLatex, tailorCv } from "@jobhunt/cv-engine";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { getCandidateProfile, getJobById, getPreparationApplicationById } from "@/lib/data/repository";
import { saveLocalCvVersion } from "@/lib/data/local";
import { repoPath } from "@/lib/repo-path";
import { tryAssembleReviewPackage } from "@/lib/application/review";

function run(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += String(d));
    child.stderr.on("data", (d) => stderr += String(d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function compileLatex(latexSource: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobhunt-cv-"));
  try {
    const tex = path.join(dir, "cv.tex");
    await fs.writeFile(tex, latexSource, "utf8");
    const result = await run("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-output-directory", dir, tex], dir);
    if (result.code !== 0) throw new Error(`PDF rendering failed. ${result.stdout.slice(-1800)} ${result.stderr.slice(-800)}`.trim());
    return Buffer.from(await fs.readFile(path.join(dir, "cv.pdf")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function mapAnalysisEvidenceToKeys(job: any, profile: any) {
  const idToKey = new Map(profile.evidence.filter((x: any) => x.id).map((x: any) => [String(x.id), x.evidenceKey]));
  return {
    ...job,
    analysis: job.analysis ? { ...job.analysis, evidenceIds: (job.analysis.evidenceIds || []).map((id: string) => idToKey.get(String(id)) || id) } : null,
  };
}

function mapStructuredEvidenceToPersistentIds(structured: any, profile: any) {
  if (profile.source !== "supabase") return structured;
  const keyToId = new Map(profile.evidence.map((x: any) => [x.evidenceKey, x.id]));
  const knownIds = new Set(profile.evidence.map((x: any) => String(x.id)));
  const mapIds = (ids: string[]) => ids.map((id) => knownIds.has(String(id)) ? String(id) : String(keyToId.get(id) || id));
  const out = JSON.parse(JSON.stringify(structured));
  out.profile_summary.evidence_ids = mapIds(out.profile_summary.evidence_ids || []);
  for (const section of out.sections || []) for (const entry of section.entries || []) for (const bullet of entry.bullets || []) bullet.evidence_ids = mapIds(bullet.evidence_ids || []);
  return out;
}

export async function prepareCvForApplication(applicationId: string) {
  const [application, profile] = await Promise.all([getPreparationApplicationById(applicationId), getCandidateProfile()]);
  if (!application) throw new Error("Application not found.");
  if (!["preparing", "ready_for_review", "revision_requested"].includes(application.state)) throw new Error("Application content is frozen after Approval Gate 1.");
  if (!application.selectedCvFamily) throw new Error("Application has no selected CV family.");
  const job = await getJobById(application.jobId);
  if (!job) throw new Error("Frozen job context is not available.");

  const baseData = loadBaseCvFamilies(repoPath("data", "cv", "base-families.json"));
  const engineJob = mapAnalysisEvidenceToKeys(job, profile);
  const { structured: localStructured, audit } = tailorCv({ baseData, family: application.selectedCvFamily, job: engineJob, evidence: profile.evidence });
  if (!audit.valid) throw new Error(`CV evidence audit failed: ${audit.unsupportedClaims.join(", ")}`);
  const structured = mapStructuredEvidenceToPersistentIds(localStructured, profile);
  const latexSource = renderCvLatex(structured);
  const pdf = await compileLatex(latexSource);
  const evidenceLinks = collectEvidenceLinks(structured);

  const mode = getDataMode();
  if (isSupabaseConfigured() && mode !== "local" && profile.source === "supabase") {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_cv_document_version", {
      p_application_id: applicationId,
      p_structured_content: structured,
      p_latex_source: latexSource,
      p_evidence_links: evidenceLinks.map((x) => ({ claim_key: x.claimKey, evidence_id: x.evidenceId })),
      p_engine: CV_ENGINE_VERSION,
    });
    if (error) throw error;
    const result: any = data;
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) throw userError || new Error("Authentication required for document storage.");
    const objectKey = `${userData.user.id}/${applicationId}/${result.document_version_id}/cv.pdf`;
    const upload = await supabase.storage.from("application-documents").upload(objectKey, pdf, { contentType: "application/pdf", upsert: false });
    if (upload.error) {
      await supabase.from("automation_tasks").update({ state: "retrying", last_error: upload.error.message, updated_at: new Date().toISOString() }).eq("entity_type", "application").eq("entity_id", applicationId).eq("task_type", "prepare_cv");
      throw upload.error;
    }
    const versionUpdate = await supabase.from("document_versions").update({ rendered_object_key: objectKey }).eq("id", result.document_version_id);
    if (versionUpdate.error) {
      await supabase.storage.from("application-documents").remove([objectKey]);
      await supabase.from("automation_tasks").update({ state: "retrying", last_error: versionUpdate.error.message, updated_at: new Date().toISOString() }).eq("entity_type", "application").eq("entity_id", applicationId).eq("task_type", "prepare_cv");
      throw versionUpdate.error;
    }
    const taskUpdate = await supabase.from("automation_tasks").update({
      output_json: { document_id: result.document_id, document_version_id: result.document_version_id, version_number: result.version_number, unsupported_claims_count: 0, engine: CV_ENGINE_VERSION, rendered_object_key: objectKey },
      updated_at: new Date().toISOString(),
    }).eq("entity_type", "application").eq("entity_id", applicationId).eq("task_type", "prepare_cv");
    if (taskUpdate.error) throw taskUpdate.error;
    await tryAssembleReviewPackage(applicationId);
    return { source: "supabase" as const, documentId: result.document_id, versionId: result.document_version_id, versionNumber: result.version_number, unsupportedClaimsCount: 0 };
  }

  const saved = await saveLocalCvVersion({ applicationId, cvFamily: application.selectedCvFamily, structuredContent: structured, latexSource, pdf, evidenceLinks, engine: CV_ENGINE_VERSION });
  await tryAssembleReviewPackage(applicationId);
  return { source: "local_snapshot" as const, documentId: saved.document.id, versionId: saved.version.id, versionNumber: saved.version.versionNumber, unsupportedClaimsCount: 0 };
}
