import fs from "node:fs";
import { analyseJob, calculateFitScore, calculatePriorityScore, createJobDedupeKey } from "../packages/job-intelligence/index.js";

const knowledge = JSON.parse(fs.readFileSync("data/knowledge/knowledge-base.generated.json", "utf8"));
const profile = {
  facts: (knowledge.profile?.facts || []).map((f) => ({ factKey: f.fact_key, value: f.value, status: f.status })),
  evidence: (knowledge.evidence || []).map((e) => ({
    evidenceKey: e.evidence_key,
    category: e.category,
    claim: e.claim,
    detail: e.detail,
    tags: e.tags || [],
    strength: e.strength,
    status: e.status,
  })),
  preferences: knowledge.preferences || {},
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(Math.abs(calculateFitScore({ technical_capability: 100, evidence_strength: 100, seniority_fit: 100, domain_fit: 100, role_type_fit: 100, qualifications: 100 }) - 100) < 0.01, "Fit weights do not sum to 100");
assert(Math.abs(calculatePriorityScore(100, { screening_probability: 100, compensation_value: 100, geography: 100, posting_freshness: 100, application_effort: 100, closing_urgency: 100 }) - 100) < 0.01, "Priority weights do not sum to 100");

const now = new Date("2026-08-23T12:00:00Z");
const simulation = analyseJob({
  company: "Engineering Co",
  title: "Simulation Engineer",
  description: "Required: Python finite element simulation experience. Required: engineering degree. Desirable: ANSYS and HPC experience. Develop and validate structural vibration models.",
  location: "Reading",
  salaryText: "£55k-£65k",
  postedAt: "2026-08-22",
}, profile, now);
assert(simulation.recommendedCvFamily === "simulation_cae", "Simulation role selected the wrong CV family");
assert(simulation.fitScore >= 75, "Known strong simulation evidence scored unexpectedly low");
assert(simulation.triage !== "reject", "Strong simulation role was rejected");
assert(simulation.evidenceIds.length > 0, "Simulation analysis has no evidence provenance");

const quant = analyseJob({
  company: "Fund",
  title: "Quantitative Developer",
  description: "Required: strong quantitative modelling, Python and statistics. Build financial trading models and production research tools. Preferred: C++ and finance experience.",
  location: "London",
  salaryText: "£80k-£100k",
  postedAt: "2026-08-23",
}, profile, now);
assert(quant.recommendedCvFamily === "quantitative_data", "Quantitative role selected the wrong CV family");
assert(quant.priorityScore > simulation.fitScore - 15, "High-value recent London quant role priority is implausibly low");

const motorsport = analyseJob({
  company: "Formula 1 Team",
  title: "Aerodynamics Simulation Engineer",
  description: "Required: CFD and aerodynamics experience for Formula 1 vehicle development. Use ANSYS Fluent and Python to analyse aero performance. Engineering degree required.",
  location: "Oxford",
  postedAt: "2026-08-23",
}, profile, now);
assert(motorsport.recommendedCvFamily === "motorsport", "Explicit motorsport role did not select Motorsport CV");

const genericSimulation = analyseJob({
  company: "Industrial Engineering",
  title: "Aerodynamics Engineer",
  description: "Develop CFD simulations and validate aerodynamic models for industrial fluid systems. Python desirable.",
  location: "Bristol",
  postedAt: "2026-08-23",
}, profile, now);
assert(genericSimulation.recommendedCvFamily !== "motorsport", "Non-motorsport role incorrectly selected Motorsport CV");

const staff = analyseJob({
  company: "CloudCo",
  title: "Staff Backend Engineer",
  description: "Required: 10+ years production Java and Kubernetes experience. Required: lead distributed cloud platform architecture. Required: AWS microservices at scale.",
  location: "London",
  salaryText: "£100k-£120k",
  postedAt: "2026-08-23",
}, profile, now);
assert(staff.fitScore < 65, "Unsupported senior backend role scored too highly");
assert(staff.triage === "reject", "Unsupported staff backend role should be rejected");

const clearance = analyseJob({
  company: "Defence Co",
  title: "Simulation Engineer",
  description: "SC clearance is required. Required: finite element simulation and Python experience.",
  location: "Bristol",
}, profile, now);
assert(clearance.eligibility === "unknown", "Unverified clearance requirement must stay unknown rather than being guessed");
assert(clearance.eligibilityNotes.length > 0, "Eligibility uncertainty is not surfaced");

assert(createJobDedupeKey({ company: "Acme", title: "Engineer", description: "x", externalJobId: "ABC123" }) === createJobDedupeKey({ company: "ACME", title: "Different title", description: "y", externalJobId: "abc123" }), "External job IDs are not deduplicated consistently");

console.log(JSON.stringify({
  simulation: { fit: simulation.fitScore, priority: simulation.priorityScore, triage: simulation.triage },
  quant: { fit: quant.fitScore, priority: quant.priorityScore, triage: quant.triage },
  motorsport: { cv: motorsport.recommendedCvFamily, triage: motorsport.triage },
  staffBackend: { fit: staff.fitScore, triage: staff.triage },
  clearance: { eligibility: clearance.eligibility },
}, null, 2));
console.log("Job intelligence verification passed.");
