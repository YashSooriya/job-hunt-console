import { PRIORITY_VERSION, round1, type FitResult, type Vacancy } from "./contract.ts";

export type Constraint = { state: "satisfied" | "conflict" | "unknown" | "not_configured"; explanation: string };
export type Preferences = Record<string, any>;
function norm(v: unknown) { return String(v || "").toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim(); }
function wordsMatch(a: string, b: string) { return a === b || (` ${a} `).includes(` ${b} `) || (` ${b} `).includes(` ${a} `); }
const COUNTRY_ALIASES: Record<string, string> = { uk: "united kingdom", "great britain": "united kingdom", england: "united kingdom", scotland: "united kingdom", wales: "united kingdom", "northern ireland": "united kingdom", usa: "united states", us: "united states" };
const KNOWN_UK_CITIES = new Set(["london", "bristol", "reading", "oxford", "cambridge", "manchester", "leeds", "edinburgh", "glasgow", "birmingham", "milton keynes", "aberdeen", "cardiff", "belfast", "culham"]);
function locationMatch(location: string, wanted: string) {
  const a = COUNTRY_ALIASES[location] || location, b = COUNTRY_ALIASES[wanted] || wanted;
  if (wordsMatch(a, b)) return true;
  if (b === "united kingdom" && [...KNOWN_UK_CITIES].some(city => wordsMatch(location, city))) return true;
  return false;
}
function list(value: unknown): string[] { return Array.isArray(value) ? value.map(norm).filter(Boolean) : []; }
function annualSalary(v: Vacancy): [number, number] | null {
  const lo = v.salary_min ?? v.salary_max, hi = v.salary_max ?? v.salary_min;
  if (typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) return null;
  let multiplier: number;
  switch (v.salary_period) {
    case "annual": multiplier = 1; break;
    case "monthly": multiplier = 12; break;
    case "weekly": multiplier = 52; break;
    case "hourly": if (!v.salary_hours_per_week || v.salary_hours_per_week <= 0) return null; multiplier = 52 * v.salary_hours_per_week; break;
    case "daily": if (!v.salary_days_per_week || v.salary_days_per_week <= 0) return null; multiplier = 52 * v.salary_days_per_week; break;
    default: return null;
  }
  return [lo * multiplier, hi * multiplier];
}
export function evaluatePreferences(v: Vacancy, p: Preferences, now: Date) {
  const constraints: Record<string, Constraint> = {};
  const locations = list(p.locations), modes = list(p.work_modes), excluded = list(p.excluded_industries), types = list(p.employment_types);
  const location = norm(v.location), mode = norm(v.work_mode);
  constraints.location = !locations.length ? { state: "not_configured", explanation: "No location preference configured." } : !location ? { state: "unknown", explanation: "The advertised location is missing." } : locations.some(w => locationMatch(location, w)) ? { state: "satisfied", explanation: "Advertised location matches your preference." } : { state: "unknown", explanation: "Location does not match a configured place; confirm its geographic scope before treating it as a conflict." };
  // Explicit named countries/cities establish conflict; ambiguous strings stay unknown.
  if (constraints.location.state === "unknown" && location && (/\b(germany|france|united states|canada|australia|berlin|paris|new york)\b/.test(location) || KNOWN_UK_CITIES.has(location))) constraints.location = { state: "conflict", explanation: "Advertised location is outside your selected locations." };
  const normalizedMode = /^(on site|onsite|office)$/.test(mode) ? "onsite" : mode;
  constraints.work_mode = !modes.length ? { state: "not_configured", explanation: "No work-mode preference configured." } : !mode ? { state: "unknown", explanation: "Work arrangement is not stated." } : modes.includes(normalizedMode) ? { state: "satisfied", explanation: "Work arrangement matches." } : /^(onsite|hybrid|remote)$/.test(normalizedMode) ? { state: "conflict", explanation: "Work arrangement is outside your preferences." } : { state: "unknown", explanation: "Work arrangement needs confirmation." };
  constraints.industry = !excluded.length ? { state: "not_configured", explanation: "No industry exclusions configured." } : !v.industry ? { state: "unknown", explanation: "Industry is not confirmed." } : excluded.some(w => wordsMatch(norm(v.industry), w)) ? { state: "conflict", explanation: "Industry is excluded in your preferences." } : { state: "satisfied", explanation: "No configured industry exclusion matches." };
  constraints.employment_type = !types.length ? { state: "not_configured", explanation: "No employment-type constraint configured." } : !v.employment_type ? { state: "unknown", explanation: "Employment type is not stated." } : types.some(t => wordsMatch(norm(v.employment_type), t)) ? { state: "satisfied", explanation: "Employment type matches." } : { state: "conflict", explanation: "Employment type is outside your preferences." };
  const posted = Date.parse(v.posted_at || ""), closes = Date.parse(v.closes_at || "");
  const age = Number.isFinite(posted) && posted <= now.getTime() ? (now.getTime() - posted) / 86400000 : null;
  const maxAge = Number(p.posting_age_policy?.max_days);
  constraints.posting_age = !Number.isFinite(maxAge) || maxAge <= 0 ? { state: "not_configured", explanation: "No posting-age limit configured." } : age === null ? { state: "unknown", explanation: "Posting date is unavailable or in the future." } : age > maxAge ? { state: "conflict", explanation: "Listing exceeds your posting-age limit." } : { state: "satisfied", explanation: "Listing is within your posting-age limit." };
  const salary = annualSalary(v), floor = p.salary?.minimum == null ? null : Number(p.salary.minimum), target = p.salary?.target == null ? null : Number(p.salary.target);
  const comparable = salary && norm(v.salary_currency) === norm(p.salary?.currency);
  constraints.salary = floor === null || !Number.isFinite(floor) ? { state: "not_configured", explanation: "No salary floor configured." } : !comparable || v.salary_source !== "advertised" ? { state: "unknown", explanation: "Advertised salary cannot be reliably compared with your annual floor; estimates do not establish a conflict." } : salary![1] < floor ? { state: "conflict", explanation: "The entire advertised salary range is below your floor." } : salary![0] >= floor ? { state: "satisfied", explanation: "The advertised range meets your floor." } : { state: "unknown", explanation: "The salary range crosses your floor." };
  const geography = [constraints.location, constraints.work_mode].filter(c => c.state !== "not_configured");
  const geographyScore = geography.some(c => c.state === "conflict") ? 0 : geography.some(c => c.state === "unknown") || !geography.length ? null : 100;
  // Estimates remain labelled but are not used to establish salary value or hard limits.
  const compensation = comparable && v.salary_source === "advertised" && target !== null && Number.isFinite(target) && target > 0 ? round1(Math.min(100, Math.max(0, 100 * ((salary![0] + salary![1]) / 2) / target))) : null;
  const freshness = age === null ? null : age <= 1 ? 100 : age <= 3 ? 96 : age <= 7 ? 90 : age <= 14 ? 76 : age <= 30 ? 50 : 24;
  const remaining = Number.isFinite(closes) ? (closes - now.getTime()) / 86400000 : null;
  const urgency = remaining === null ? null : remaining < 0 ? 0 : remaining <= 2 ? 100 : remaining <= 7 ? 88 : remaining <= 14 ? 66 : remaining <= 30 ? 42 : 25;
  const instruction = norm(v.application_instructions);
  const effort = /\b(easy apply|quick apply|one click)\b/.test(instruction) ? 90 : /\b(competency questions|written questions|application questions)\b/.test(instruction) ? 50 : /\b(cover letter|supporting statement)\b/.test(instruction) ? 62 : null;
  return { constraints, closed: remaining !== null && remaining < 0, components: { compensation, geography: geographyScore, freshness, effort, urgency } };
}
export type FitPrioritySignal = Pick<FitResult, "completeness" | "fit_score" | "eligibility">;

export function priorityAndRecommendation(fit: FitPrioritySignal, v: Vacancy, p: Preferences, now = new Date()) {
  const evaluated = evaluatePreferences(v, p, now);
  const values = { fit: fit.fit_score, ...evaluated.components };
  const weights = { fit: 55, compensation: 15, geography: 10, freshness: 10, effort: 5, urgency: 5 };
  const available = Object.entries(weights).filter(([k]) => values[k as keyof typeof values] !== null);
  const priority = fit.completeness !== "complete" ? null : round1(available.reduce((s, [k, w]) => s + values[k as keyof typeof values]! * w, 0) / available.reduce((s, [, w]) => s + w, 0));
  const configuredMinimum = Number(p.min_fit_score_10 ?? (Number(p.min_fit_threshold ?? 60) / 10)) * 10;
  const minimum = Number.isFinite(configuredMinimum) ? Math.max(0, Math.min(100, configuredMinimum)) : 60;
  let recommendation: string;
  if (fit.completeness !== "complete") recommendation = "Needs information";
  else if (fit.eligibility === "confirmed_conflict") recommendation = "Eligibility conflict";
  else if (evaluated.closed) recommendation = "Closed";
  else if (Object.values(evaluated.constraints).some(c => c.state === "conflict")) recommendation = "Outside your preferences";
  else if (fit.fit_score! < minimum) recommendation = "Below your fit threshold";
  else if (fit.fit_score! >= Math.max(minimum, 78) && fit.eligibility !== "needs_confirmation" && !Object.values(evaluated.constraints).some(c => c.state === "unknown")) recommendation = "Recommended";
  else recommendation = "Worth reviewing";
  return { priority_version: PRIORITY_VERSION, priority_score: priority, recommendation, ...evaluated };
}
