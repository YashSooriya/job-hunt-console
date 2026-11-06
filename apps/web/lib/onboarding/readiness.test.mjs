import assert from "node:assert/strict";
import test from "node:test";
import { fallbackReadiness } from "./readiness.ts";

const complete = {
  onboarding: { status: "in_progress" },
  facts: [{ fact_key: "work_authorisation", verification_status: "verified" }],
  evidence: [],
  extractionProposals: [],
  education: [],
  employment: [{ verification_status: "verified" }],
  skills: [],
  projects: [],
  publications: [],
  cvFamilies: [],
  sourceDocuments: [],
  preferences: {},
};

test("profile readiness ignores search preferences and external connections", () => {
  const readiness = fallbackReadiness({ ...complete, preferences: { connected_gmail: false } });
  assert.equal(readiness.profile_complete, true);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.external_connections_required, false);
  assert.equal(readiness.preferences_complete, true);
});

test("unreviewed imported facts and structured records prevent readiness", () => {
  for (const key of ["facts", "education", "employment", "skills", "projects", "publications", "extractionProposals"]) {
    const readiness = fallbackReadiness({
      ...complete,
      [key]: [{ ...(key === "facts" ? { fact_key: "work_authorisation" } : {}), verification_status: "needs_review" }],
    });
    assert.equal(readiness.ready, false, key + " must remain pending until explicit review");
    assert.equal(readiness.pending_review, 1, key + " pending review count");
  }
});

test("profile stays incomplete without user-confirmed work authorisation", () => {
  const readiness = fallbackReadiness({
    ...complete,
    facts: [{ fact_key: "work_authorisation", verification_status: "needs_review" }],
  });
  assert.equal(readiness.profile_complete, false);
  assert.equal(readiness.ready, false);
});
