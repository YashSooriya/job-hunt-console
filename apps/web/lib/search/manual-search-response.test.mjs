import test from "node:test";
import assert from "node:assert/strict";
import { parseManualSearchResponse } from "./manual-search-response.ts";

const expected = {
  publicationId: "7c59bd5b-9237-46d1-8e5e-27c378ce0041",
  revision: 12,
  rowCount: 0,
  verificationToken: "334a0e3a-436e-4bb2-9a41-3d2f1a4588d0",
};

function body(proof = {}) {
  return JSON.stringify({
    run_id: "1421ed53-34b7-46cc-9cc3-8eb42da46522",
    job_pool_snapshot: {
      publication_id: expected.publicationId,
      revision: expected.revision,
      access_check_token: expected.verificationToken,
      rows_read: expected.rowCount,
      ...proof,
    },
    jobs_checked: 0,
    summary: "No verified new vacancies were found.",
    results: [],
  });
}

test("manual search result imports only when it proves the exact linked pool snapshot", () => {
  const parsed = parseManualSearchResponse(body(), "1421ed53-34b7-46cc-9cc3-8eb42da46522", expected);
  assert.equal(parsed.job_pool_snapshot?.publicationId, expected.publicationId);
  assert.equal(parsed.job_pool_snapshot?.rowCount, 0);
  assert.throws(() => parseManualSearchResponse(body({ access_check_token: "guessed" }), "1421ed53-34b7-46cc-9cc3-8eb42da46522", expected), /Connect Google Drive/);
  assert.throws(() => parseManualSearchResponse(body({ rows_read: 1 }), "1421ed53-34b7-46cc-9cc3-8eb42da46522", expected), /reading 1 of 0/);
  assert.throws(() => parseManualSearchResponse(JSON.stringify({
    run_id: "1421ed53-34b7-46cc-9cc3-8eb42da46522", jobs_checked: 0,
    summary: "no results", results: [],
  }), "1421ed53-34b7-46cc-9cc3-8eb42da46522", expected), /required job-pool Sheet verification/);
});

test("historical pre-mirror search responses keep their old envelope", () => {
  const parsed = parseManualSearchResponse(JSON.stringify({
    run_id: "1421ed53-34b7-46cc-9cc3-8eb42da46522", jobs_checked: 0,
    summary: "no results", results: [],
  }), "1421ed53-34b7-46cc-9cc3-8eb42da46522");
  assert.equal(parsed.job_pool_snapshot, undefined);
});
