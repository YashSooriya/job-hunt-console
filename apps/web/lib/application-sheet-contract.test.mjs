import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationManifestHash,
  applicationSheetHash,
  applicationSheetPublicationDecision,
  normalizeApplicationValues,
} from "./application-sheet-contract.ts";

const headers = Array.from({ length: 3 }, (_, index) => `column-${index + 1}`);
const oldValues = [headers, ["a", "b", "c"]];
const newValues = [headers, ["a", "b", "updated"]];
const manifest = (hash) => [["Field", "Value"], ["content_hash", hash], ["row_count", "1"]];
const decide = (existingValues, existingManifest, desiredHash, expectedHash = null) => applicationSheetPublicationDecision({
  existingValues, existingManifest, desiredHash, expectedHash, columnCount: headers.length,
});

test("an empty Applications tab can receive its first managed publication", () => {
  assert.equal(decide([], [], applicationSheetHash([headers])), "publish");
});

test("a publication matching both the database rows and manifest is already current", () => {
  const hash = applicationSheetHash(oldValues);
  assert.equal(decide(oldValues, manifest(hash), hash, hash), "already_current");
});

test("known database content may be replaced with a newer authoritative publication", () => {
  const previousHash = applicationSheetHash(oldValues);
  const nextHash = applicationSheetHash(newValues);
  assert.equal(decide(oldValues, manifest(previousHash), nextHash, previousHash), "publish");
});

test("external row edits are rejected even when the old manifest was left in place", () => {
  const previousHash = applicationSheetHash(oldValues);
  assert.equal(decide(newValues, manifest(previousHash), applicationSheetHash(headers), previousHash), "external_edit");
});

test("external edits to both data and manifest are rejected against the database baseline", () => {
  const previousHash = applicationSheetHash(oldValues);
  const editedHash = applicationSheetHash(newValues);
  assert.notEqual(applicationManifestHash(manifest(editedHash)), previousHash);
  assert.equal(decide(newValues, manifest(editedHash), applicationSheetHash(headers), previousHash), "external_edit");
});

test("pre-existing populated tabs without a database publication hash are never overwritten", () => {
  const unknownValues = [headers, ["user", "entered", "data"]];
  assert.equal(decide(unknownValues, [], applicationSheetHash(headers)), "unverified_existing_data");
});

test("a lost confirmation can be recovered without rewriting an exact completed publication", () => {
  const hash = applicationSheetHash(oldValues);
  assert.equal(decide(oldValues, manifest(hash), hash, "stale-database-hash"), "already_current");
});

test("Google API omitted trailing blank cells normalize to the same fixed-width row contract", () => {
  const sparse = [headers, ["a", "b"]];
  assert.deepEqual(normalizeApplicationValues(sparse, headers.length), [headers, ["a", "b", ""]]);
});
