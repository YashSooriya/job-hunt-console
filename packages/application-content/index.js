export const APPLICATION_CONTENT_CONTRACT_VERSION = "1.0.0";
export const APPLICATION_CONTENT_ENGINE_VERSION = "deterministic_v1";

const moneyRound = (value) => Math.round(value / 1000) * 1000;
const norm = (v) => String(v || "").toLowerCase();

export const trustColour = (trust) => trust === "verified" ? "green" : trust === "proposed" ? "amber" : "red";

function familySalaryBase(family) {
  return {
    simulation_cae: [42000, 58000],
    scientific_software: [46000, 65000],
    quantitative_data: [55000, 80000],
    motorsport: [45000, 65000],
  }[family] || [42000, 60000];
}

export function buildSalaryContext({ job, analysis }) {
  const currency = job.salaryCurrency || "GBP";
  if (job.salaryMin != null || job.salaryMax != null || job.salaryText) {
    const low = job.salaryMin ?? job.salaryMax ?? null;
    const high = job.salaryMax ?? job.salaryMin ?? null;
    const recommendation = low != null && high != null ? moneyRound((low + high) / 2) : low ?? high;
    return {
      contract_version: APPLICATION_CONTENT_CONTRACT_VERSION,
      source: "advertised",
      advertised_text: job.salaryText || null,
      estimated_low: low,
      estimated_high: high,
      recommended_value: recommendation,
      currency,
      confidence: "high",
      trust: "proposed",
      basis: ["Employer-advertised compensation"],
      label: "Advertised salary",
    };
  }

  let [low, high] = familySalaryBase(analysis.recommendedCvFamily);
  const title = norm(job.title);
  const location = norm(job.location);
  if (/senior|lead|principal|staff/.test(title)) { low += 12000; high += 22000; }
  if (/graduate|junior|entry|associate/.test(title)) { low -= 7000; high -= 9000; }
  if (/london/.test(location)) { low += 7000; high += 9000; }
  else if (/reading|oxford|cambridge/.test(location)) { low += 3000; high += 5000; }
  low = moneyRound(Math.max(28000, low));
  high = moneyRound(Math.max(low + 5000, high));
  const recommendation = moneyRound(low + (high - low) * 0.58);

  return {
    contract_version: APPLICATION_CONTENT_CONTRACT_VERSION,
    source: "estimated",
    advertised_text: null,
    estimated_low: low,
    estimated_high: high,
    recommended_value: recommendation,
    currency,
    confidence: "medium",
    trust: "proposed",
    basis: [
      `Role family: ${analysis.recommendedCvFamily}`,
      job.location ? `Location adjustment: ${job.location}` : "No location adjustment available",
      /senior|lead|principal|staff/.test(title) ? "Seniority uplift" : /graduate|junior|entry|associate/.test(title) ? "Early-career adjustment" : "Mid-level baseline",
    ],
    label: "Estimated salary range",
  };
}

function evidenceMap(evidence = []) {
  const m = new Map();
  for (const item of evidence) {
    if (item.id) m.set(String(item.id), item);
    if (item.evidenceKey) m.set(item.evidenceKey, item);
  }
  return m;
}

function pickEvidence(application, evidence, count = 3) {
  const map = evidenceMap(evidence);
  const selected = [];
  for (const id of application.evidenceIds || []) {
    const item = map.get(String(id));
    if (item && item.status === "verified" && !selected.some((x) => x.evidenceKey === item.evidenceKey)) selected.push(item);
    if (selected.length >= count) break;
  }
  if (selected.length < count) {
    for (const item of evidence.filter((x) => x.status === "verified").sort((a,b) => b.strength - a.strength)) {
      if (!selected.some((x) => x.evidenceKey === item.evidenceKey)) selected.push(item);
      if (selected.length >= count) break;
    }
  }
  return selected;
}

function firstPersonClaim(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const verbs = ["Developed","Implemented","Verified","Ran","Used","Worked","Collaborated","Built","Conducted","Performed","Supported","Presented","Authored","Took","Created","Designed","Automated"];
  for (const verb of verbs) {
    if (clean.startsWith(`${verb} `)) return `I ${verb.toLowerCase()} ${clean.slice(verb.length + 1)}.`;
  }
  return `My work includes ${clean.charAt(0).toLowerCase()}${clean.slice(1)}.`;
}

export function generateCoverLetter({ application, job, evidence, candidateName }) {
  const value = job.analysis?.coverLetterValue || "low";
  if (!['high','medium'].includes(value)) return { decision: "skip", reason: value === "not_accepted" ? "Employer does not accept a cover letter." : "Low expected value." };
  const chosen = pickEvidence(application, evidence, 4);
  if (chosen.length < 2) throw new Error("At least two verified evidence records are required for a cover letter draft.");

  const p1 = `Dear Hiring Manager,\n\nI am applying for the ${job.title} position at ${job.company}. The role is a strong match for the computational engineering and scientific software work I have been doing through my PhD and industry collaboration.`;
  const p2 = `${firstPersonClaim(chosen[0].claim)} ${firstPersonClaim(chosen[1].claim)} This work has required me to be careful about verification, numerical behaviour and whether simulation results are genuinely useful for engineering decisions.`;
  const p3 = chosen[2]
    ? `${firstPersonClaim(chosen[2].claim)} ${chosen[3] ? firstPersonClaim(chosen[3].claim) : ""}`.trim()
    : "I have also worked across technical communication, validation and collaborative engineering development.";
  const fitSentence = application.strategyText
    ? `What particularly interests me about this vacancy is the overlap with the areas in which I can contribute immediately, while still giving me room to broaden the work beyond my current research setting.`
    : `I would value the opportunity to bring this experience into the role and contribute to the team from the outset.`;
  const p4 = `${fitSentence}\n\nThank you for considering my application. I would be very happy to discuss the role further.\n\nKind regards,\n${candidateName}`;

  const paragraphs = [
    { paragraph_key: "opening", text: p1, material: false, evidence_ids: [] },
    { paragraph_key: "primary_evidence", text: p2, material: true, evidence_ids: chosen.slice(0,2).map((x) => x.id || x.evidenceKey) },
    { paragraph_key: "secondary_evidence", text: p3, material: true, evidence_ids: chosen.slice(2,4).map((x) => x.id || x.evidenceKey) },
    { paragraph_key: "closing", text: p4, material: false, evidence_ids: [] },
  ];
  return {
    decision: "prepare",
    structured: {
      contract_version: APPLICATION_CONTENT_CONTRACT_VERSION,
      engine: APPLICATION_CONTENT_ENGINE_VERSION,
      kind: "cover_letter",
      application_id: application.id,
      job_title: job.title,
      company: job.company,
      candidate_name: candidateName,
      paragraphs,
      unsupported_claims: [],
      change_summary: [{ area: "cover_letter", change_type: "generated", reason: "Role-specific draft assembled from locked strategy and verified evidence." }],
    },
  };
}

function factMap(facts = []) {
  const m = new Map();
  for (const fact of facts) m.set(fact.factKey, fact);
  return m;
}

function salaryText(ctx) {
  if (!ctx?.recommended_value) return null;
  const symbol = ctx.currency === "GBP" ? "£" : `${ctx.currency} `;
  return `${symbol}${Number(ctx.recommended_value).toLocaleString("en-GB")}`;
}

export function buildScreeningPackage({ application, job, profile, salaryContext }) {
  const facts = factMap(profile.facts || []);
  const answers = [];
  const add = (key, question, category, trust, answer, required = true, sourceFactKey = null, rationale = null, evidenceIds = []) => answers.push({
    question_key: key, question_text: question, category, trust, colour: trustColour(trust), answer_text: answer, required, source_fact_key: sourceFactKey, rationale, evidence_ids: evidenceIds,
  });

  const phdField = facts.get("education.phd.field");
  const phdInst = facts.get("education.phd.institution");
  if (phdField?.status === "verified" && phdInst?.status === "verified") {
    add("highest_qualification", "What is your highest qualification?", "education", "verified", `PhD in ${phdField.value}, ${phdInst.value}`, true, "education.phd.field", "Directly supported by verified candidate facts.");
  }

  const salary = salaryText(salaryContext);
  add("salary_expectation", "What is your expected base annual salary?", "compensation", "proposed", salary, true, null, salary ? "Suggested from the application salary context and requires user approval." : "Salary requires user review.");

  const chosen = pickEvidence(application, profile.evidence || [], 2);
  const why = chosen.length
    ? `The role matches my background in ${chosen.map((x) => x.category.replaceAll("_", " ")).join(" and ")}. My recent work includes ${chosen.map((x) => x.claim.replace(/\.$/, "").toLowerCase()).join("; ")}.`
    : `The role is a strong match for my recent computational engineering work and the direction I want to continue developing.`;
  add("why_this_role", `Why are you interested in the ${job.title} role?`, "motivation", "proposed", why, true, null, "Generated from the locked application evidence and should be reviewed for tone.", chosen.map((x) => x.id || x.evidenceKey));

  const notice = facts.get("employment.notice_period");
  add("notice_period", "What is your notice period?", "employment", notice?.status === "verified" ? "verified" : "user_required", notice?.status === "verified" ? String(notice.value) : null, true, notice?.status === "verified" ? "employment.notice_period" : null, notice?.status === "verified" ? "Verified candidate fact." : "No verified notice-period fact is stored, so the system will not infer it.");

  const workAuth = facts.get("work_authorisation.uk");
  add("work_authorisation_uk", "Do you have the right to work in the UK?", "eligibility", workAuth?.status === "verified" ? "verified" : "user_required", workAuth?.status === "verified" ? String(workAuth.value) : null, true, workAuth?.status === "verified" ? "work_authorisation.uk" : null, workAuth?.status === "verified" ? "Verified candidate fact." : "Legal/work-authorisation status is user-only unless explicitly verified.");

  const requiresClearance = (job.requirements || []).some((r) => /security clearance|sc cleared|dv cleared|developed vetting|clearance/i.test(r.text));
  if (requiresClearance) add("security_clearance", "Please confirm your current security-clearance status.", "eligibility", "user_required", null, true, null, "Security-clearance status must never be inferred.");

  return {
    contract_version: APPLICATION_CONTENT_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    answers,
    summary: {
      total: answers.length,
      green: answers.filter((x) => x.trust === "verified").length,
      amber: answers.filter((x) => x.trust === "proposed").length,
      red: answers.filter((x) => x.trust === "user_required").length,
      unresolved_required: answers.filter((x) => x.required && (!x.answer_text || x.trust === "user_required")).length,
    },
  };
}

function latexEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

export function renderCoverLetterLatex(structured) {
  const body = structured.paragraphs.map((p) => latexEscape(p.text).replace(/\n\n/g, "\\par\n\\vspace{0.65em}\n")).join("\n\\par\n\\vspace{0.85em}\n");
  return `\\documentclass[11pt,a4paper]{article}\n\\usepackage[margin=24mm]{geometry}\n\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n\\usepackage{microtype}\n\\usepackage{parskip}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0pt}\n\\begin{document}\n{\\Large\\bfseries ${latexEscape(structured.candidate_name)}}\\par\n\\vspace{0.3em}\n${latexEscape(structured.job_title)} - ${latexEscape(structured.company)}\\par\n\\vspace{1.4em}\n${body}\n\\end{document}\n`;
}

export function collectCoverLetterEvidenceLinks(structured) {
  const links = [];
  for (const p of structured.paragraphs || []) for (const id of p.evidence_ids || []) links.push({ claimKey: p.paragraph_key, evidenceId: String(id) });
  return links;
}
