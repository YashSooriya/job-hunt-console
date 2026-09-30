import assert from "node:assert/strict";
import test from "node:test";
import { diffSnapshots } from "./profile-snapshot.ts";

test("profile snapshot deltas ignore JSONB object key ordering", () => {
  assert.deepEqual(diffSnapshots(
    { "projects.example|": { title: "Example", details: { first: "one", second: "two" } } },
    { "projects.example|": { details: { second: "two", first: "one" }, title: "Example" } },
  ), []);
});
test("profile snapshot deltas still report a real scalar change", () => {
  assert.deepEqual(diffSnapshots(
    { "facts.salary_expectation": 40000 },
    { "facts.salary_expectation": "39999" },
  ), [{ path: "facts.salary_expectation", before: 40000, after: "39999" }]);
});
