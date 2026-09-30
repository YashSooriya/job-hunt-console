/** Live calibration runner consumes these expectations; these are not fabricated model results. */
export const CALIBRATION_FIXTURES = [
  { id: "direct", scenario: "Verified project demonstrates the exact required tool, task and scope.", expected: "direct", band: [90, 100] },
  { id: "transfer", scenario: "Verified analogous numerical solver experience; advert requires a different closely related solver.", expected: "strong_transfer", band: [65, 85] },
  { id: "partial", scenario: "Verified small prototype; advert requires production-scale delivery.", expected: "partial", band: [40, 65] },
  { id: "unrelated", scenario: "Verified marketing background; advert requires finite-element solver development.", expected: "not_evidenced", band: [0, 25] },
  { id: "seniority", scenario: "Verified graduate work; advert explicitly requires leading a large engineering team.", expected: "not_evidenced", band: [0, 50] },
  { id: "qualification-equivalent", scenario: "Advert accepts doctorate OR equivalent research experience; verified equivalent research is supplied.", expected: "direct", band: [75, 100] },
  { id: "qualification-conflict", scenario: "Advert strictly requires an active professional registration; verified registration has expired.", expected: "conflict", band: [0, 50] },
  { id: "eligibility-unknown", scenario: "Advert requires legal UK work permission; background contains no authorisation fact.", expected: "not_assessable", band: null },
  { id: "profile-incomplete", scenario: "Only contact fields exist; no verified professional background.", expected: "blocked_before_dispatch", band: null },
  { id: "listing-incomplete", scenario: "Advert is inaccessible and has no complete saved description.", expected: "blocked_before_dispatch", band: null },
  { id: "domain-mismatch", scenario: "Verified structural mechanics expertise; essential requirement is tokamak plasma physics.", expected: "weak_transfer", band: [0, 50] },
  { id: "equivalent-wording", scenario: "Same verified evidence and requirement expressed with synonymous wording.", expected: "same_match_as_direct", band: [90, 100] },
] as const;
export function validateRepeatedCalibration(scores: number[]) {
  if (scores.length !== 3 || scores.some(s => !Number.isFinite(s) || s < 0 || s > 100)) throw new Error("Calibration requires three valid independent scores.");
  const spread = Math.max(...scores) - Math.min(...scores);
  if (spread > 5) throw new Error(`Repeated semantic assessment varied by ${spread} points; release is blocked.`);
  return { spread, passed: true };
}
