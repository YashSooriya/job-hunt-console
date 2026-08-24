import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  APPLICATION_CONTENT_ENGINE_VERSION,
  buildSalaryContext,
  buildScreeningPackage,
  collectCoverLetterEvidenceLinks,
  generateCoverLetter,
  renderCoverLetterLatex,
} from "@jobhunt/application-content";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { getCandidateProfile, getJobById, getPreparationApplicationById } from "@/lib/data/repository";
import { saveLocalApplicationContentPackage } from "@/lib/data/local";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobhunt-letter-"));
  try {
    const tex = path.join(dir, "letter.tex");
    await fs.writeFile(tex, latexSource, "utf8");
    const result = await run("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-output-directory", dir, tex], dir);
    if (result.code !== 0) throw new Error(`Cover-letter PDF rendering failed. ${result.stdout.slice(-1600)} ${result.stderr.slice(-600)}`.trim());
    return Buffer.from(await fs.readFile(path.join(dir, "letter.pdf")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function mapEvidenceIdsToPersistent<T extends Record<string, any>>(value: T, profile: any): T {
  if (profile.source !== "supabase") return value;
  const keyToId = new Map(profile.evidence.map((x: any) => [x.evidenceKey, String(x.id)]));
  const knownIds = new Set(profile.evidence.filter((x: any) => x.id).map((x: any) => String(x.id)));
  const mapIds = (ids: string[]) => ids.map((id) => knownIds.has(String(id)) ? String(id) : String(keyToId.get(id) || id));
  const out: any = JSON.parse(JSON.stringify(value));
  if (out.paragraphs) for (const p of out.paragraphs) p.evidence_ids = mapIds(p.evidence_ids || []);
  if (out.answers) for (const a of out.answers) a.evidence_ids = mapIds(a.evidence_ids || []);
  return out;
}

export async function prepareApplicationContent(applicationId: string) {
  const [application, profile] = await Promise.all([getPreparationApplicationById(applicationId), getCandidateProfile()]);
  if (!application) throw new Error("Application not found.");
  if (!["preparing", "ready_for_review", "revision_requested"].includes(application.state)) throw new Error("Application content is frozen after Approval Gate 1.");
  const job = await getJobById(application.jobId);
  if (!job?.analysis) throw new Error("Frozen job analysis is unavailable.");

  const salary = buildSalaryContext({ job, analysis: job.analysis });
  const letterResult = generateCoverLetter({ application, job, evidence: profile.evidence, candidateName: profile.displayName });
  const screening = buildScreeningPackage({ application, job, profile, salaryContext: salary });

  let coverLetter: any = null;
  let latexSource: string | null = null;
  let pdf: Buffer | null = null;
  let evidenceLinks: Array<{ claimKey: string; evidenceId: string }> = [];
  if (letterResult.decision === "prepare") {
    coverLetter = mapEvidenceIdsToPersistent(letterResult.structured, profile);
    latexSource = renderCoverLetterLatex(coverLetter);
    pdf = await compileLatex(latexSource);
    evidenceLinks = collectCoverLetterEvidenceLinks(coverLetter);
  }
  const persistentScreening = mapEvidenceIdsToPersistent(screening, profile);

  const mode = getDataMode();
  if (isSupabaseConfigured() && mode !== "local" && profile.source === "supabase") {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_application_content_package", {
      p_application_id: applicationId,
      p_salary: salary,
      p_answers: persistentScreening.answers,
      p_cover_letter: coverLetter,
      p_latex_source: latexSource,
      p_evidence_links: evidenceLinks.map((x) => ({ claim_key: x.claimKey, evidence_id: x.evidenceId })),
      p_engine: APPLICATION_CONTENT_ENGINE_VERSION,
    });
    if (error) throw error;
    const result: any = data;

    if (pdf && result.cover_letter_version_id) {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) throw userError || new Error("Authentication required for document storage.");
      const objectKey = `${userData.user.id}/${applicationId}/${result.cover_letter_version_id}/cover-letter.pdf`;
      const upload = await supabase.storage.from("application-documents").upload(objectKey, pdf, { contentType: "application/pdf", upsert: false });
      if (upload.error) {
        await supabase.from("automation_tasks").update({ state: "retrying", last_error: upload.error.message, updated_at: new Date().toISOString() }).eq("entity_type", "application").eq("entity_id", applicationId).eq("task_type", "prepare_cover_letter");
        throw upload.error;
      }
      const update = await supabase.from("document_versions").update({ rendered_object_key: objectKey }).eq("id", result.cover_letter_version_id);
      if (update.error) {
        await supabase.storage.from("application-documents").remove([objectKey]);
        await supabase.from("automation_tasks").update({ state: "retrying", last_error: update.error.message, updated_at: new Date().toISOString() }).eq("entity_type", "application").eq("entity_id", applicationId).eq("task_type", "prepare_cover_letter");
        throw update.error;
      }
      await supabase.from("automation_tasks").update({
        output_json: { document_id: result.cover_letter_document_id, document_version_id: result.cover_letter_version_id, engine: APPLICATION_CONTENT_ENGINE_VERSION, rendered_object_key: objectKey },
        updated_at: new Date().toISOString(),
      }).eq("entity_type", "application").eq("entity_id", applicationId).eq("task_type", "prepare_cover_letter");
    }
    await tryAssembleReviewPackage(applicationId);
    return { source: "supabase" as const, ...result };
  }

  const saved = await saveLocalApplicationContentPackage({
    applicationId, salary, answers: persistentScreening.answers, coverLetter, latexSource, pdf, evidenceLinks, engine: APPLICATION_CONTENT_ENGINE_VERSION,
  });
  await tryAssembleReviewPackage(applicationId);
  return saved;
}
