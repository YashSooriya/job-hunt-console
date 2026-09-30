const FIT_WEIGHTS = {
  technical_capability: 0.30,
  evidence_strength: 0.20,
  seniority_fit: 0.15,
  domain_fit: 0.15,
  role_type_fit: 0.10,
  qualifications: 0.10,
};

const PRIORITY_WEIGHTS = {
  fit: 0.35,
  screening_probability: 0.20,
  compensation_value: 0.15,
  geography: 0.10,
  posting_freshness: 0.10,
  application_effort: 0.05,
  closing_urgency: 0.05,
};

export const JOB_ANALYSIS_ENGINE_VERSION = "job-fit-v2";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

/** Hash exactly the analysis inputs, engine contract, and assessment time. */
export async function hashJobAnalysisInput({ job, profile, jobRevision, profileRevision, assessmentAsOf }) {
  const canonicalProfile = {
    displayName: profile.displayName || "",
    facts: [...(profile.facts || [])].map((fact) => ({
      id: fact.id || null,
      factKey: fact.factKey,
      value: fact.value,
      status: fact.status,
    })).sort((a, b) => `${a.factKey}:${a.id || ""}`.localeCompare(`${b.factKey}:${b.id || ""}`)),
    evidence: [...(profile.evidence || [])].map((item) => ({
      id: item.id || null,
      evidenceKey: item.evidenceKey,
      category: item.category,
      claim: item.claim,
      detail: item.detail || null,
      tags: [...(item.tags || [])],
      strength: item.strength,
      status: item.status,
    })).sort((a, b) => `${a.evidenceKey}:${a.id || ""}`.localeCompare(`${b.evidenceKey}:${b.id || ""}`)),
    preferences: profile.preferences || {},
  };
  const payload = stableJson({
    engineVersion: JOB_ANALYSIS_ENGINE_VERSION,
    jobRevision: Number(jobRevision),
    profileRevision: Number(profileRevision),
    assessmentAsOf: new Date(assessmentAsOf).toISOString(),
    job,
    profile: canonicalProfile,
  });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const STOPWORDS = new Set([
  "the","a","an","and","or","to","of","in","for","with","on","as","at","by","be","is","are","will","you","your",
  "we","our","this","that","from","have","has","using","use","into","within","across","role","work","working","team",
  "experience","skills","skill","ability","candidate","required","preferred","desirable","essential","including","such",
]);

const FAMILY_KEYWORDS = {
  simulation_cae: {
    high: ["fem","fea","finite element","cfd","simulation","modelling","modeling","structural","stress","dynamics","mechanics","multiphysics","electromagnetic","electromagnetics","ansys","cae","aerothermal","aerodynamics","thermal","vibration"],
    medium: ["engineering","solver","numerical","physics","validation","mesh","continuum","mechanical"],
  },
  scientific_software: {
    high: ["scientific software","software engineer","software developer","python","c++","numerical software","hpc","high performance computing","algorithms","solver","scientific computing"],
    medium: ["testing","git","linux","parallel","performance","codebase","developer","programming","automation"],
  },
  quantitative_data: {
    high: ["quantitative","quant","data scientist","data science","machine learning","statistics","statistical","financial","trading","research engineer","modelling"],
    medium: ["python","mathematics","probability","optimisation","optimization","data","analysis","analytics"],
  },
  motorsport: {
    high: ["formula 1","formula one","f1","motorsport","racing","race car","racecar","vehicle performance","aero performance"],
    medium: ["aerodynamics","lap time","vehicle dynamics","race","trackside"],
  },
};

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}
function round1(value) { return Math.round(value * 10) / 10; }
function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(value) {
  return norm(value).split(" ").filter((token) => token.length > 1 && !STOPWORDS.has(token));
}
function uniq(items) { return [...new Set(items)]; }
function phraseCount(text, phrase) {
  if (!phrase) return 0;
  const hay = ` ${norm(text)} `;
  const needle = ` ${norm(phrase)} `;
  let count = 0;
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) >= 0) { count += 1; idx += needle.length; }
  return count;
}

export function createJobDedupeKey(input) {
  const company = norm(input.company);
  const title = norm(input.title);
  const external = norm(input.externalJobId || "");
  if (external) return `${company}|external:${external}`;
  let host = "";
  try { host = input.sourceUrl ? new URL(input.sourceUrl).hostname.replace(/^www\./, "") : ""; } catch {}
  return `${company}|${title}|${host || "no-host"}`;
}

function classifyRequirement(text) {
  const lower = norm(text);
  if (/\b(right to work|work authori[sz]ation|security clearance|sc clearance|dv clearance|citizen|citizenship|visa|sponsorship)\b/.test(lower)) return "eligibility";
  if (/\b(preferred|desirable|advantage|nice to have|ideally|bonus)\b/.test(lower)) return "desirable";
  if (/\b(must|required|essential|need to|you will have|minimum|at least)\b/.test(lower)) return "essential";
  return "context";
}

function categoryFor(text) {
  const lower = norm(text);
  if (/\b(clearance|citizen|visa|sponsorship|right to work|authorisation|authorization)\b/.test(lower)) return "eligibility";
  if (/\b(phd|masters|master|bachelor|beng|meng|degree|qualification|chartered)\b/.test(lower)) return "education";
  if (/\b(python|c\+\+|c#|java|matlab|software|programming|git|linux|aws|cloud|api)\b/.test(lower)) return "software";
  if (/\b(fem|fea|cfd|simulation|modelling|modeling|stress|structural|thermal|dynamics|mechanics|ansys|cae|electromagnetic|vibration)\b/.test(lower)) return "simulation_cae";
  if (/\b(quant|statistics|probability|data|machine learning|financial|trading|optimisation|optimization)\b/.test(lower)) return "quantitative_data";
  if (/\b(years?|senior|lead|principal|staff|graduate|junior|entry level|manager)\b/.test(lower)) return "experience";
  if (/\b(communicat|stakeholder|presentation|collaborat|team)\b/.test(lower)) return "communication";
  return "general";
}

export function extractRequirements(description) {
  const lines = String(description || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•▪◦–—\d.)]+\s*/, "").trim())
    .filter(Boolean);
  let candidates = lines.filter((line) => line.length >= 18 && line.length <= 360);
  if (candidates.length < 5) {
    candidates = String(description || "")
      .split(/(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 25 && line.length <= 360);
  }
  const signal = /\b(must|required|essential|preferred|desirable|experience|degree|phd|python|c\+\+|matlab|fem|fea|cfd|simulation|modelling|modeling|data|quant|clearance|citizen|visa|sponsorship|responsib|develop|design|analyse|analyze|engineering|software)\b/i;
  const filtered = candidates.filter((line) => signal.test(line));
  const source = filtered.length >= 4 ? filtered : candidates;
  return uniq(source.map((line) => line.replace(/\s+/g, " ")))
    .slice(0, 16)
    .map((text) => ({ text, type: classifyRequirement(text), category: categoryFor(text) }));
}

function evidenceScore(requirement, evidence) {
  if (evidence.status !== "verified") return 0;
  const reqTokens = new Set(tokens(requirement));
  if (!reqTokens.size) return 0;
  const evidenceText = `${evidence.claim} ${evidence.detail || ""} ${(evidence.tags || []).join(" ")} ${evidence.category || ""}`;
  const evTokens = new Set(tokens(evidenceText));
  let overlap = 0;
  for (const token of reqTokens) if (evTokens.has(token)) overlap += 1;
  const coverage = overlap / Math.max(3, Math.min(reqTokens.size, 10));
  const tagHits = (evidence.tags || []).filter((tag) => phraseCount(requirement, tag) > 0).length;
  const phraseBoost = phraseCount(evidenceText, requirement) ? 0.25 : 0;
  const strength = Number(evidence.strength || 3) / 5;
  return clamp(Math.round((coverage * 68 + Math.min(tagHits, 3) * 9 + phraseBoost * 20 + strength * 12)));
}

function analyseRequirements(requirements, evidence) {
  return requirements.map((req) => {
    const ranked = evidence
      .map((item) => ({ item, score: evidenceScore(req.text, item) }))
      .filter((x) => x.score >= 22)
      .sort((a, b) => b.score - a.score || b.item.strength - a.item.strength)
      .slice(0, 3);
    const best = ranked[0]?.score ?? 0;
    const evidenceIds = ranked.map(({ item }) => item.id || item.evidenceKey);
    return { ...req, matchScore: best, evidenceIds };
  });
}

function familyScores(input) {
  const text = `${input.company} ${input.title} ${input.description}`;
  const scores = {};
  for (const [family, groups] of Object.entries(FAMILY_KEYWORDS)) {
    let raw = 0;
    for (const phrase of groups.high) raw += Math.min(2, phraseCount(text, phrase)) * 5;
    for (const phrase of groups.medium) raw += Math.min(2, phraseCount(text, phrase)) * 2;
    scores[family] = raw;
  }
  const explicitMotorsport = FAMILY_KEYWORDS.motorsport.high.some((phrase) => phraseCount(text, phrase) > 0);
  if (!explicitMotorsport) scores.motorsport = -1;
  return scores;
}

function recommendedFamily(input) {
  const scores = familyScores(input);
  const text = `${input.company} ${input.title} ${input.description}`;
  const explicitMotorsport = FAMILY_KEYWORDS.motorsport.high.some((phrase) => phraseCount(text, phrase) > 0);
  if (explicitMotorsport) return "motorsport";
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] || "simulation_cae";
}

function seniorityBand(value) {
  const text = norm(value);
  if (/\b(graduate|junior|entry level|entry-level|associate|assistant)\b/.test(text)) return "junior";
  if (/\b(principal|staff|lead|director|head|vp|vice president|manager)\b/.test(text)) return "senior";
  if (/\b(mid|intermediate|experienced)\b/.test(text)) return "mid";
  return null;
}

function seniorityFit(title, description, preferences = {}) {
  const text = norm(`${title} ${description.slice(0, 1800)}`);
  const target = seniorityBand(preferences.target_seniority || preferences.targetSeniority);
  const role = seniorityBand(text);
  if (!target || !role) return 70;
  if (role === target) return 92;
  if (target === "mid" && (role === "junior" || role === "senior")) return 62;
  if (target === "junior" && role === "mid") return 55;
  if (target === "junior" && role === "senior") return 30;
  if (target === "senior" && role === "mid") return 58;
  return 35;
}

function qualificationFit(requirements, facts) {
  const educationReqs = requirements.filter((r) => r.category === "education");
  if (!educationReqs.length) return 88;
  const factText = norm(facts.filter((f) => f.status === "verified").map((f) => `${f.factKey} ${JSON.stringify(f.value)}`).join(" "));
  let score = 88;
  for (const req of educationReqs) {
    const lower = norm(req.text);
    if (/\bphd|doctorate\b/.test(lower)) score = Math.min(score, /\bphd|doctorate\b/.test(factText) ? 100 : 60);
    if (/\b(bachelor|degree|beng|meng|masters|master)\b/.test(lower)) score = Math.min(score, /\bbeng|bachelor|degree|phd|master\b/.test(factText) ? 100 : 50);
    if (/\bchartered\b/.test(lower) && !/chartered/.test(factText)) score = Math.min(score, 35);
  }
  return score;
}

function eligibilityState(requirements, facts) {
  const reqs = requirements.filter((r) => r.type === "eligibility");
  if (!reqs.length) return { state: "eligible", notes: [] };
  const factText = norm(facts.filter((f) => f.status === "verified").map((f) => `${f.factKey} ${JSON.stringify(f.value)}`).join(" "));
  const notes = [];
  let unknown = false;
  for (const req of reqs) {
    const lower = norm(req.text);
    if (/\bsecurity clearance|sc clearance|dv clearance\b/.test(lower) && !/clearance/.test(factText)) {
      unknown = true; notes.push(`Clearance requirement needs user verification: ${req.text}`);
    } else if (/\bvisa|sponsorship|right to work|work authori[sz]ation|citizen|citizenship\b/.test(lower)) {
      unknown = true; notes.push(`Work-authorisation or citizenship requirement needs user verification: ${req.text}`);
    }
  }
  return { state: unknown ? "unknown" : "eligible_with_concerns", notes };
}

function salaryMidpoint(input) {
  if (Number.isFinite(input.salaryMin) || Number.isFinite(input.salaryMax)) {
    const lo = Number.isFinite(input.salaryMin) ? Number(input.salaryMin) : Number(input.salaryMax);
    const hi = Number.isFinite(input.salaryMax) ? Number(input.salaryMax) : Number(input.salaryMin);
    return (lo + hi) / 2;
  }
  const text = String(input.salaryText || "").replace(/,/g, "");
  const nums = [...text.matchAll(/(?:£|gbp\s*)?(\d{2,3})(?:000|k)\b/gi)].map((m) => Number(m[1]) * 1000);
  if (nums.length) return nums.reduce((a, b) => a + b, 0) / nums.length;
  return null;
}

function compensationValue(input, preferences = {}) {
  const mid = salaryMidpoint(input);
  const salary = preferences.salary && typeof preferences.salary === "object" ? preferences.salary : {};
  const floorValue = salary.minimum ?? preferences.salary_minimum;
  const targetValue = salary.target ?? preferences.salary_target;
  const floor = floorValue === null || floorValue === undefined || floorValue === "" ? Number.NaN : Number(floorValue);
  const target = targetValue === null || targetValue === undefined || targetValue === "" ? Number.NaN : Number(targetValue);
  const candidateCurrency = String(salary.currency ?? preferences.salary_currency ?? "").trim().toUpperCase();
  const jobCurrency = String(input.salaryCurrency || "GBP").trim().toUpperCase();
  if (mid == null || (!Number.isFinite(floor) && !Number.isFinite(target)) || (candidateCurrency && candidateCurrency !== jobCurrency)) return 55;
  const lowerBound = Number.isFinite(floor) ? floor : Number.isFinite(target) ? target * 0.8 : null;
  const upperTarget = Number.isFinite(target) ? target : lowerBound;
  if (lowerBound == null || upperTarget == null) return 55;
  if (mid >= upperTarget) return 100;
  if (mid >= lowerBound) return round1(75 + ((mid - lowerBound) / Math.max(1, upperTarget - lowerBound)) * 25);
  const gapRatio = (lowerBound - mid) / Math.max(1, lowerBound);
  return round1(clamp(70 - gapRatio * 120, 0, 70));
}

function geographyValue(input, preferences = {}) {
  const preferredLocations = Array.isArray(preferences.locations) ? preferences.locations : [];
  const preferredModes = Array.isArray(preferences.work_modes) ? preferences.work_modes : [];
  if (!preferredLocations.length && !preferredModes.length) return 65;
  const location = norm(input.location || "");
  const mode = norm(input.workMode || "");
  const locationMatch = preferredLocations.some((item) => {
    const preferred = norm(item);
    return preferred && location && (location.includes(preferred) || preferred.includes(location));
  });
  const modeAliases = { onsite: ["onsite", "on site", "office"], hybrid: ["hybrid"], remote: ["remote", "home based", "home-based"] };
  const normalMode = mode.replaceAll("_", " ");
  const modeMatch = preferredModes.some((item) => (modeAliases[norm(item)] || [norm(item)]).some((alias) => normalMode.includes(alias)));
  if ((locationMatch || !preferredLocations.length) && (modeMatch || !preferredModes.length)) return 100;
  if (!location && !mode) return 50;
  if (locationMatch || modeMatch) return 75;
  return 25;
}

function postingFreshness(input, now) {
  if (!input.postedAt) return 55;
  const posted = new Date(input.postedAt);
  if (Number.isNaN(posted.getTime())) return 55;
  const days = Math.max(0, (now.getTime() - posted.getTime()) / 86400000);
  if (days <= 1) return 100;
  if (days <= 3) return 96;
  if (days <= 7) return 90;
  if (days <= 14) return 76;
  if (days <= 30) return 50;
  return 24;
}

function closingUrgency(input, now) {
  if (!input.closesAt) return 45;
  const closes = new Date(input.closesAt);
  if (Number.isNaN(closes.getTime())) return 45;
  const days = (closes.getTime() - now.getTime()) / 86400000;
  if (days < 0) return 0;
  if (days <= 2) return 100;
  if (days <= 7) return 88;
  if (days <= 14) return 66;
  if (days <= 30) return 42;
  return 25;
}

function effortValue(input) {
  const text = norm(input.description);
  let score = 72;
  if (/\b(cover letter|supporting statement|personal statement)\b/.test(text)) score -= 10;
  if (/\b(answer the following|written questions|application questions|competency questions)\b/.test(text)) score -= 12;
  if (/\b(easy apply|quick apply|one click)\b/.test(text)) score += 18;
  return clamp(score);
}

export function calculateFitScore(components) {
  return round1(Object.entries(FIT_WEIGHTS).reduce((sum, [key, weight]) => sum + (components[key] ?? 0) * weight, 0));
}

export function calculatePriorityScore(fitScore, components) {
  return round1(
    fitScore * PRIORITY_WEIGHTS.fit +
    components.screening_probability * PRIORITY_WEIGHTS.screening_probability +
    components.compensation_value * PRIORITY_WEIGHTS.compensation_value +
    components.geography * PRIORITY_WEIGHTS.geography +
    components.posting_freshness * PRIORITY_WEIGHTS.posting_freshness +
    components.application_effort * PRIORITY_WEIGHTS.application_effort +
    components.closing_urgency * PRIORITY_WEIGHTS.closing_urgency
  );
}

function domainAndRoleFit(input, family) {
  const scores = familyScores(input);
  const selected = Math.max(0, scores[family] || 0);
  const domain = clamp(50 + selected * 2.8);
  const role = clamp(55 + selected * 2.3);
  return { domain, role };
}

function aggregateRequirementMatch(requirements) {
  const technical = requirements.filter((r) => !["education", "eligibility", "communication"].includes(r.category));
  const core = technical.filter((r) => r.type === "essential" || r.type === "context");
  const source = core.length ? core : technical.length ? technical : requirements.filter((r) => r.category !== "eligibility");
  if (!source.length) return 58;
  const weighted = source.map((r) => r.matchScore * (r.type === "essential" ? 1.2 : 1));
  return clamp(weighted.reduce((a, b) => a + b, 0) / weighted.length);
}

function evidenceStrength(requirements, evidence) {
  const ids = uniq(requirements.flatMap((r) => r.evidenceIds));
  if (!ids.length) return 40;
  const selected = evidence.filter((e) => ids.includes(e.id || e.evidenceKey));
  if (!selected.length) return 40;
  const avg = selected.reduce((sum, item) => sum + Number(item.strength || 3), 0) / selected.length;
  return clamp(45 + (avg / 5) * 50 + Math.min(ids.length, 8) * 1.5);
}

function buildStrengths(requirements, evidence) {
  const ranked = [...requirements].filter((r) => r.matchScore >= 58 && r.evidenceIds.length).sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);
  return ranked.map((r) => ({ description: `${r.matchScore}% evidence match: ${r.text}`, evidenceIds: r.evidenceIds }));
}

function buildWeaknesses(requirements, eligibility) {
  const gaps = requirements.filter((r) => (r.type === "essential" || r.type === "eligibility") && r.matchScore < 48).slice(0, 5);
  const weaknesses = gaps.map((r) => ({
    description: r.type === "eligibility" ? `Needs verification: ${r.text}` : `Limited direct evidence for: ${r.text}`,
    severity: r.type === "eligibility" ? "high" : r.matchScore < 25 ? "high" : "medium",
  }));
  if (eligibility.state === "unknown" && !weaknesses.some((w) => w.description.startsWith("Needs verification"))) {
    weaknesses.unshift({ description: "At least one eligibility condition requires user verification.", severity: "high" });
  }
  return weaknesses;
}

function coverLetterValue(input, fitScore) {
  const text = norm(input.description);
  if (/\bcover letter not accepted|do not submit a cover letter\b/.test(text)) return "not_accepted";
  if (/\bcover letter|required supporting statement|supporting statement required\b/.test(text)) return "high";
  if (fitScore >= 85) return "medium";
  return "low";
}

function triageFor(fitScore, priorityScore, eligibility, priority) {
  if (eligibility === "ineligible") return { triage: "reject", reason: "Hard eligibility conflict." };
  if (eligibility === "eligible" && fitScore >= 88 && priorityScore >= 80) return { triage: "auto_prepare", reason: "Excellent fit and high priority with no unresolved eligibility concern." };
  if (fitScore >= 78 && priorityScore >= 65) return { triage: "recommend", reason: "Strong fit and worthwhile application priority." };
  if (fitScore >= 65 || priorityScore >= 70 || (priority.compensation_value >= 90 && fitScore >= 58)) return { triage: "maybe", reason: "Plausible role, but fit, urgency, or evidence strength is below the automatic recommendation threshold." };
  return { triage: "reject", reason: "Current evidence and role fit are below the application threshold." };
}

export function analyseJob(input, profile, now = new Date()) {
  const rawRequirements = extractRequirements(input.description);
  const requirements = analyseRequirements(rawRequirements, profile.evidence || []);
  const family = recommendedFamily(input);
  const domainRole = domainAndRoleFit(input, family);
  const eligibility = eligibilityState(requirements, profile.facts || []);
  const fitComponents = {
    technical_capability: round1(aggregateRequirementMatch(requirements)),
    evidence_strength: round1(evidenceStrength(requirements, profile.evidence || [])),
    seniority_fit: seniorityFit(input.title, input.description, profile.preferences || {}),
    domain_fit: round1(domainRole.domain),
    role_type_fit: round1(domainRole.role),
    qualifications: qualificationFit(requirements, profile.facts || []),
  };
  const fitScore = calculateFitScore(fitComponents);
  const screeningProbability = clamp(round1(fitScore * 0.68 + fitComponents.evidence_strength * 0.18 + fitComponents.seniority_fit * 0.14));
  const priorityComponents = {
    screening_probability: screeningProbability,
    compensation_value: compensationValue(input, profile.preferences || {}),
    geography: geographyValue(input, profile.preferences || {}),
    posting_freshness: postingFreshness(input, now),
    application_effort: effortValue(input),
    closing_urgency: closingUrgency(input, now),
  };
  const priorityScore = calculatePriorityScore(fitScore, priorityComponents);
  const triage = triageFor(fitScore, priorityScore, eligibility.state, priorityComponents);
  const strengths = buildStrengths(requirements, profile.evidence || []);
  const weaknesses = buildWeaknesses(requirements, eligibility);
  const evidenceIds = uniq(strengths.flatMap((s) => s.evidenceIds));
  const strategyLead = strengths[0]?.description.replace(/^\d+% evidence match:\s*/, "") || "the strongest directly supported technical requirements";
  const applicationStrategy = `Lead with ${strategyLead}. Use the ${family.replaceAll("_", " ")} CV family, emphasise verified evidence only, and address ${weaknesses.length ? "the identified gaps explicitly rather than overstating experience" : "the role requirements directly and concisely"}.`;

  return {
    contractVersion: "1.0.0",
    analysisSource: "deterministic_v2",
    eligibility: eligibility.state,
    eligibilityNotes: eligibility.notes,
    fitScore,
    priorityScore,
    fitComponents,
    priorityComponents,
    recommendedCvFamily: family,
    strengths,
    weaknesses,
    requirements,
    applicationStrategy,
    coverLetterValue: coverLetterValue(input, fitScore),
    evidenceIds,
    triage: triage.triage,
    triageReason: triage.reason,
  };
}
