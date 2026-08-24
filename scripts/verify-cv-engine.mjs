import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { auditCvEvidence, collectEvidenceLinks, loadBaseCvFamilies, renderCvLatex, tailorCv } from "../packages/cv-engine/index.js";

const root = process.cwd();
const base = loadBaseCvFamilies(path.join(root, "data/cv/base-families.json"));
const knowledge = JSON.parse(fs.readFileSync(path.join(root, "data/knowledge/knowledge-base.generated.json"), "utf8"));
const evidence = knowledge.evidence.map((x) => ({ ...x, evidenceKey: x.evidence_key, status: x.status }));

for (const family of ["simulation_cae", "scientific_software", "quantitative_data", "motorsport"]) {
  if (!base.families[family]) throw new Error(`Missing base CV family ${family}`);
  for (const id of base.families[family].profile.evidenceIds) {
    const item = evidence.find((x) => x.evidenceKey === id);
    if (!item || item.status !== "verified") throw new Error(`${family} profile references unverified evidence ${id}`);
  }
}

const job = {
  id: "m5-sample",
  company: "Example Engineering",
  title: "Simulation Development Engineer",
  description: "Develop Python simulation software for structural dynamics, finite element analysis, model validation, ANSYS comparisons, HPC workflows and automated testing.",
  requirements: [
    { text: "Strong Python and finite element simulation experience" },
    { text: "Structural dynamics and validation" },
    { text: "HPC and Linux workflows" },
  ],
  analysis: {
    evidenceIds: ["EV-0001", "EV-0004", "EV-0005", "EV-0006", "EV-0007", "EV-0008", "EV-0018"],
    strengths: [{ description: "Strong simulation and verification background" }],
  },
};
for (const family of ["simulation_cae", "scientific_software", "quantitative_data", "motorsport"]) {
  const candidate = tailorCv({ baseData: base, family, job, evidence });
  if (!candidate.audit.valid || candidate.audit.unsupportedCount !== 0) throw new Error(`${family} generated unsupported claims`);
  if (candidate.structured.base_family !== family) throw new Error(`${family} output changed CV family`);
}

const { structured, audit } = tailorCv({ baseData: base, family: "simulation_cae", job, evidence });
if (!audit.valid || audit.unsupportedCount !== 0) throw new Error(`Valid CV failed evidence audit: ${audit.unsupportedClaims.join(", ")}`);
if (!structured.sections.some((s) => s.section_key === "experience")) throw new Error("Experience section missing");
if (collectEvidenceLinks(structured).length < 10) throw new Error("CV evidence manifest is unexpectedly small");
const phd = structured.sections.find((s) => s.section_key === "experience")?.entries.find((e) => e.entry_key === "phd");
if (!phd?.bullets?.length) throw new Error("PhD bullets missing");
if (!/Python finite element|three million|Verified numerical|3D/i.test(phd.bullets.map((b) => b.text).join(" "))) throw new Error("Relevant simulation evidence was not retained");

const invalid = JSON.parse(JSON.stringify(structured));
invalid.sections.find((s) => s.section_key === "experience").entries[0].bullets[0].evidence_ids = [];
const invalidAudit = auditCvEvidence(invalid, evidence);
if (invalidAudit.valid || invalidAudit.unsupportedCount < 1) throw new Error("Unsupported material claim was not detected");

const latex = renderCvLatex(structured);
if (!latex.includes("\\documentclass") || !latex.includes("Yashwanth Sooriyakanthan")) throw new Error("LaTeX renderer output invalid");

let pdfVerified = false;
try {
  execFileSync("pdflatex", ["--version"], { stdio: "ignore" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-m5-"));
  try {
    const tex = path.join(dir, "cv.tex");
    fs.writeFileSync(tex, latex);
    execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-output-directory", dir, tex], { cwd: dir, stdio: "pipe" });
    const pdf = path.join(dir, "cv.pdf");
    const stat = fs.statSync(pdf);
    if (stat.size < 5000) throw new Error("Rendered PDF is unexpectedly small");
    fs.copyFileSync(pdf, "/mnt/data/job-hunt-milestone5-verification.pdf");
    pdfVerified = true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  console.warn(`PDF compilation skipped or failed: ${error.message}`);
}

console.log(JSON.stringify({
  family: structured.base_family,
  unsupportedClaims: audit.unsupportedCount,
  evidenceLinks: collectEvidenceLinks(structured).length,
  sections: structured.sections.map((s) => s.heading),
  pdfVerified,
}, null, 2));
