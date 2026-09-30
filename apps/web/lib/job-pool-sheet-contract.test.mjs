import test from "node:test";
import assert from "node:assert/strict";
import {
  JOB_POOL_SHEET_HEADERS,
  boundedJobPoolReadRows,
  chunkJobPoolValues,
  hashJobPoolSheetValues,
  isCurrentJobPoolPublication,
  jobPoolSheetValues,
  normalizeJobPoolSheetValues,
  parseJobPoolAccessTestResponse,
  parseJobPoolSnapshotProof,
} from "./job-pool-sheet-contract.ts";

test("job-pool export has a stable, bounded, privacy-minimised field contract", () => {
  const values = jobPoolSheetValues([
    { id: "b", title: "Engineer", companies: [{ canonical_name: "Example" }], salary_min: "50000.00", notes: "private note" },
    { id: "a", title: "Analyst", companies: { canonical_name: "Other" }, salary_currency: "USD" },
  ]);
  assert.deepEqual(values[0], JOB_POOL_SHEET_HEADERS);
  assert.equal(values[1][0], "a");
  assert.equal(values[1][12], "USD");
  assert.equal(values[2][10], 50000);
  assert.equal(JSON.stringify(values).includes("private note"), false);
  assert.equal(values.every((row) => row.length === JOB_POOL_SHEET_HEADERS.length), true);
  assert.equal(hashJobPoolSheetValues(values), hashJobPoolSheetValues(jobPoolSheetValues([
    { id: "a", title: "Analyst", companies: { canonical_name: "Other" }, salary_currency: "USD" },
    { id: "b", title: "Engineer", companies: [{ canonical_name: "Example" }], salary_min: 50000 },
  ])));
});

test("Sheet readback padding preserves empty trailing cells before hashing", () => {
  const padded = normalizeJobPoolSheetValues([["Job ID", "Company"], ["1", "Example"]], 4);
  assert.deepEqual(padded, [["Job ID", "Company", "", ""], ["1", "Example", "", ""]]);
});

test("remote Sheet readback never requests rows beyond the existing grid or supported pool bound", () => {
  assert.equal(boundedJobPoolReadRows(1_000, 25_001), 1_000);
  assert.equal(boundedJobPoolReadRows(5_001, 25_001), 5_001);
  assert.equal(boundedJobPoolReadRows(50_000, 25_001), 25_001);
  assert.equal(boundedJobPoolReadRows(0, 25_001), 1_000);
  assert.equal(boundedJobPoolReadRows(Number.NaN, 25_001), 1_000);
});

test("large exports are split into deterministic, bounded row chunks", () => {
  const values = [["header"], ["a".repeat(150)], ["b".repeat(150)], ["c"]];
  const chunks = chunkJobPoolValues(values, 550);
  assert.deepEqual(chunks.map((chunk) => chunk.startRow), [0, 2]);
  assert.deepEqual(chunks.flatMap((chunk) => chunk.values), values);
  assert.throws(() => chunkJobPoolValues([["x".repeat(1000)]], 300), /safe Google Sheets request size/);
});

test("manual-search snapshot proof must bind to the exact revision and full row count", () => {
  const expected = { publicationId: "pub-1", revision: 7, rowCount: 1001, verificationToken: "token-1" };
  assert.deepEqual(parseJobPoolSnapshotProof({ publication_id: "pub-1", revision: 7, access_check_token: "token-1", rows_read: 1001 }, expected), expected);
  assert.throws(() => parseJobPoolSnapshotProof({ publication_id: "pub-1", revision: 7, access_check_token: "token-1", rows_read: 1000 }, expected), /1000 of 1001/);
  assert.throws(() => parseJobPoolSnapshotProof({ publication_id: "pub-1", revision: 7, access_check_token: "guessed", rows_read: 1001 }, expected), /Connect Google Drive/);
  assert.throws(() => parseJobPoolSnapshotProof({ publication_id: "pub-1", revision: 6, access_check_token: "token-1", rows_read: 1001 }, expected), /different job-pool Sheet snapshot/);
});

test("ChatGPT access test validates the unpredictable manifest token without accepting prose", () => {
  const expected = { publicationId: "pub-2", revision: 3, rowCount: 0, verificationToken: "fresh-random-token" };
  assert.deepEqual(parseJobPoolAccessTestResponse(JSON.stringify({
    access_test: "ok", publication_id: "pub-2", revision: 3, row_count: 0, access_check_token: "fresh-random-token",
  }), expected), { verified: true });
  assert.throws(() => parseJobPoolAccessTestResponse("I can access the file", expected), /did not return the access-test JSON/);
  assert.throws(() => parseJobPoolAccessTestResponse(JSON.stringify({
    access_test: "ok", publication_id: "pub-2", revision: 3, row_count: 0, access_check_token: "not-the-sheet-token",
  }), expected), /did not verify the current Job Pool Sheet manifest/);
});

test("the pool is current only with a fresh Drive-version proof matching the published file", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  const ready = {
    configured: true,
    lastSyncStatus: "ok",
    sourceRevision: 12,
    publishedRevision: 12,
    driveVerifiedAt: "2026-09-29T11:59:59.000Z",
    driveVerifiedVersion: "90071992547409930",
    driveFileVersion: "90071992547409930",
    driveCheckActive: false,
  };
  assert.equal(isCurrentJobPoolPublication(ready, now), true);
  assert.equal(isCurrentJobPoolPublication({ ...ready, driveVerifiedAt: "2026-09-29T11:57:59.000Z" }, now), false);
  assert.equal(isCurrentJobPoolPublication({ ...ready, driveVerifiedVersion: "old-version" }, now), false);
  assert.equal(isCurrentJobPoolPublication({ ...ready, driveCheckActive: true }, now), false);
  assert.equal(isCurrentJobPoolPublication({ ...ready, sourceRevision: 13 }, now), false);
  assert.equal(isCurrentJobPoolPublication({ ...ready, driveVerifiedAt: "2026-09-29T12:00:01.000Z" }, now), false);
});
