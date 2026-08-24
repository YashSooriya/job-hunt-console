import fs from "node:fs";
import path from "node:path";

export const CV_CONTRACT_VERSION = "1.0.0";
export const CV_ENGINE_VERSION = "deterministic_v1";

const STOP = new Set(["and","the","with","for","from","into","using","used","role","work","this","that","are","our","you","your","will","have","has","who","what","their","they","its","but","not","all","can","job","team"]);
const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
function tokens(value) { return [...new Set(normalize(value).split(/\s+/).filter((x) => x.length > 2 && !STOP.has(x)))]; }
function overlap(a, b) { const B = new Set(b); return a.reduce((n, x) => n + (B.has(x) ? 1 : 0), 0); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function loadBaseCvFamilies(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function evidenceIndex(evidence = []) {
  const out = new Map();
  for (const item of evidence) {
    const id = item.id || item.evidenceKey || item.evidence_key;
    if (id) out.set(String(id), item);
    if (item.evidenceKey) out.set(item.evidenceKey, item);
    if (item.evidence_key) out.set(item.evidence_key, item);
  }
  return out;
}

function targetTokens(job, family) {
  const familyDef = job.baseData.families[family];
  const requirements = (job.requirements || []).map((r) => r.text || r.requirementText || "").join(" ");
  const strengths = (job.analysis?.strengths || []).map((s) => s.description || "").join(" ");
  return tokens([job.title, job.company, job.description, requirements, strengths, ...(familyDef.emphasisTags || [])].join(" "));
}

function bulletScore(bullet, target, selectedEvidence, familyDef) {
  const words = tokens([bullet.text, ...(bullet.tags || [])].join(" "));
  let score = overlap(words, target) * 5;
  const emphasis = tokens((familyDef.emphasisTags || []).join(" "));
  score += overlap(words, emphasis) * 3;
  const evidence = bullet.evidenceIds || [];
  score += evidence.filter((id) => selectedEvidence.has(String(id))).length * 4;
  return score;
}

function materialClaims(structured) {
  const claims = [];
  if (structured.profile_summary) claims.push({ claimKey: "profile_summary", material: true, evidenceIds: structured.profile_summary.evidence_ids || [] });
  for (const section of structured.sections || []) {
    for (const entry of section.entries || []) {
      for (const bullet of entry.bullets || []) claims.push({ claimKey: bullet.claim_key, material: Boolean(bullet.material), evidenceIds: bullet.evidence_ids || [] });
    }
  }
  return claims;
}

export function auditCvEvidence(structured, evidence = []) {
  const index = evidenceIndex(evidence);
  const unsupported = [];
  const rejected = [];
  for (const claim of materialClaims(structured)) {
    if (!claim.material) continue;
    if (!claim.evidenceIds.length) { unsupported.push(claim.claimKey); continue; }
    const accepted = claim.evidenceIds.some((id) => {
      const item = index.get(String(id));
      if (!item) return false;
      const status = item.status || item.verification_status;
      return status === "verified";
    });
    if (!accepted) rejected.push(claim.claimKey);
  }
  return {
    unsupportedClaims: [...new Set([...unsupported, ...rejected])],
    unsupportedCount: new Set([...unsupported, ...rejected]).size,
    valid: unsupported.length === 0 && rejected.length === 0,
  };
}

export function tailorCv({ baseData, family, job, evidence }) {
  if (!baseData?.families?.[family]) throw new Error(`Unknown CV family: ${family}`);
  const familyDef = baseData.families[family];
  const selectedEvidence = new Set((job.analysis?.evidenceIds || []).map(String));
  const target = targetTokens({ ...job, baseData }, family);
  const sections = [];
  const changes = [];

  const education = clone(baseData.education || []).map((entry) => ({
    entry_key: entry.entryKey, heading: entry.heading, subheading: entry.subheading, location: entry.location || "", date: entry.date || "",
    bullets: (entry.bullets || []).map((b) => ({ claim_key: b.claimKey, text: b.text, material: Boolean(b.material), evidence_ids: b.evidenceIds || [] })),
  }));
  sections.push({ section_key: "education", heading: "Education", entries: education });

  const grouped = new Map();
  for (const raw of baseData.entries || []) {
    const scored = (raw.bullets || []).map((bullet, index) => ({ bullet, index, score: bulletScore(bullet, target, selectedEvidence, familyDef) }));
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const chosen = scored.slice(0, raw.maxBullets || scored.length);
    if (!chosen.length) continue;
    const reordered = chosen.some((x, i) => x.index !== i);
    const condensed = chosen.length < scored.length;
    if (reordered) changes.push({ area: raw.entryKey, change_type: "reordered", reason: "Higher-relevance evidence is shown first for this vacancy." });
    if (condensed) changes.push({ area: raw.entryKey, change_type: "condensed", reason: "Lower-relevance verified bullets were omitted to keep the CV focused." });
    const entry = {
      entry_key: raw.entryKey,
      heading: raw.title,
      subheading: raw.subheading,
      location: raw.location || "",
      date: raw.date || "",
      bullets: chosen.map(({ bullet }) => ({ claim_key: bullet.claimKey, text: bullet.text, material: Boolean(bullet.material), evidence_ids: bullet.evidenceIds || [] })),
    };
    if (!grouped.has(raw.sectionKey)) grouped.set(raw.sectionKey, { section_key: raw.sectionKey, heading: raw.heading, entries: [] });
    grouped.get(raw.sectionKey).entries.push(entry);
  }
  for (const key of ["experience", "projects"]) if (grouped.has(key)) sections.push(grouped.get(key));

  const pubs = clone(baseData.publications || []).map((entry) => ({
    entry_key: entry.entryKey, heading: entry.heading, subheading: entry.subheading, location: entry.location || "", date: entry.date || "",
    bullets: (entry.bullets || []).map((b) => ({ claim_key: b.claimKey, text: b.text, material: Boolean(b.material), evidence_ids: b.evidenceIds || [] })),
  }));
  if (pubs.length) sections.push({ section_key: "publications", heading: "Publications", entries: pubs });

  sections.push({
    section_key: "skills", heading: "Technical Skills", entries: (familyDef.skills || []).map(([heading, text], i) => ({
      entry_key: `skills_${i + 1}`, heading, subheading: "", location: "", date: "", bullets: [{ claim_key: `skills.${i + 1}`, text, material: false, evidence_ids: [] }],
    })),
  });
  sections.push({
    section_key: "additional", heading: "Additional Information", entries: [{ entry_key: "additional", heading: "", subheading: "", location: "", date: "", bullets: [
      { claim_key: "additional.rtw", text: `Right to work: ${baseData.additional.rightToWork}`, material: false, evidence_ids: [] },
      { claim_key: "additional.languages", text: `Languages: ${baseData.additional.languages}`, material: false, evidence_ids: [] },
      { claim_key: "additional.interests", text: `Interests: ${baseData.additional.interests}`, material: false, evidence_ids: [] }
    ] }],
  });

  const structured = {
    contract_version: CV_CONTRACT_VERSION,
    engine_version: CV_ENGINE_VERSION,
    base_family: family,
    candidate: clone(baseData.candidate),
    target: { job_id: job.id || null, company: job.company || "", title: job.title || "" },
    profile_summary: { text: familyDef.profile.text, evidence_ids: clone(familyDef.profile.evidenceIds) },
    sections,
    change_summary: changes.length ? changes : [{ area: "document", change_type: "unchanged", reason: "Base ordering already matched the vacancy relevance signals." }],
    unsupported_claims: [],
  };
  const audit = auditCvEvidence(structured, evidence);
  structured.unsupported_claims = audit.unsupportedClaims;
  return { structured, audit };
}

export function collectEvidenceLinks(structured) {
  const links = [];
  for (const id of structured.profile_summary?.evidence_ids || []) links.push({ claimKey: "profile_summary", evidenceId: id });
  for (const section of structured.sections || []) for (const entry of section.entries || []) for (const bullet of entry.bullets || []) {
    for (const evidenceId of bullet.evidence_ids || []) links.push({ claimKey: bullet.claim_key, evidenceId });
  }
  const seen = new Set();
  return links.filter((link) => { const key = `${link.claimKey}:${link.evidenceId}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

function esc(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}
function sectionTitle(value) { return `\\section{${esc(value)}}\n`; }

export function renderCvLatex(structured) {
  if (!structured || structured.unsupported_claims?.length) throw new Error("Cannot render a CV containing unsupported material claims.");
  const c = structured.candidate || {};
  const out = [];
  out.push(String.raw`\documentclass[a4paper,10pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage[a4paper,left=14mm,right=14mm,top=11mm,bottom=11mm]{geometry}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage[hidelinks]{hyperref}
\usepackage{xcolor}
\usepackage{microtype}
\usepackage{ragged2e}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0pt}
\definecolor{sectiongray}{RGB}{55,55,55}
\titleformat{\section}{\large\bfseries\color{sectiongray}}{}{0pt}{}[\vspace{-0.5mm}\titlerule]
\titlespacing*{\section}{0pt}{2.4mm}{1.0mm}
\newenvironment{cvitems}{\begin{itemize}[leftmargin=4.2mm,itemsep=0.45mm,topsep=0.5mm,parsep=0pt,partopsep=0pt]}{\end{itemize}}
\begin{document}
`);
  out.push(`\\begin{center}\n{\\LARGE\\bfseries ${esc(c.name)}}\\\\[1.1mm]\n\\small ${esc(c.phone)} \\;|\\; \\href{mailto:${esc(c.email)}}{${esc(c.email)}} \\;|\\; \\href{https://www.${esc(c.linkedin)}}{${esc(c.linkedin)}}\\\\[0.5mm]\n\\href{https://${esc(c.github)}}{${esc(c.github)}} \\;|\\; ORCID ${esc(c.orcid)}\n\\end{center}\n\\vspace{-1.5mm}\n`);
  out.push(sectionTitle("Profile"));
  out.push(`\\justifying\\small ${esc(structured.profile_summary.text)}\n`);
  for (const section of structured.sections || []) {
    if (section.section_key === "additional") {
      const parts = (section.entries || []).flatMap((entry) => entry.bullets || []).map((b) => esc(b.text));
      out.push(`\\vspace{1mm}\n{\\small\\textbf{Additional:} ${parts.join(" \\quad ")}}\n`);
      continue;
    }
    out.push(sectionTitle(section.heading));
    if (section.section_key === "skills") {
      out.push("\\small\n");
      for (const entry of section.entries || []) {
        const text = (entry.bullets || []).map((b) => b.text).join(" ");
        if (entry.heading) out.push(`\\textbf{${esc(entry.heading)}:} ${esc(text)}\\\\[0.45mm]\n`);
        else out.push(`${esc(text)}\\\\[0.45mm]\n`);
      }
      continue;
    }
    if (section.section_key === "publications") {
      out.push("\\small\\begin{enumerate}[leftmargin=5mm,itemsep=0.7mm,topsep=0.4mm]\n");
      for (const entry of section.entries || []) out.push(`\\item \\textbf{${esc(entry.heading)}}. ${esc(entry.subheading)}\n`);
      out.push("\\end{enumerate}\n");
      continue;
    }
    for (const entry of section.entries || []) {
      out.push(`\\textbf{${esc(entry.heading)}} \\hfill \\textbf{${esc(entry.date)}}\\\\[-0.2mm]\n\\textit{${esc(entry.subheading)}} \\hfill \\textit{${esc(entry.location)}}\\par\n`);
      if (entry.bullets?.length) {
        out.push("\\begin{cvitems}\n");
        for (const bullet of entry.bullets) out.push(`\\item ${esc(bullet.text)}\n`);
        out.push("\\end{cvitems}\n");
      }
    }
  }
  out.push("\\end{document}\n");
  return out.join("");
}

export function suggestedFileName(structured, version = 1) {
  const company = normalize(structured.target?.company).replace(/\s+/g, "_") || "company";
  const role = normalize(structured.target?.title).replace(/\s+/g, "_").slice(0, 60) || "role";
  return `Yashwanth_Sooriyakanthan_${company}_${role}_CV_v${version}.pdf`;
}

export function defaultBaseCvPath(repoRoot = process.cwd()) {
  return path.join(repoRoot, "data", "cv", "base-families.json");
}
