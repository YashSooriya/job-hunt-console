import test from "node:test";
import assert from "node:assert/strict";
import { buildJobSearchConfigurationPrompt, buildManualJobSearchPrompt } from "./job-search-prompt.ts";

const snapshot = {
  publicationId: "publication-1",
  revision: 42,
  rowCount: 1500,
  dataUrl: "https://docs.google.com/spreadsheets/d/sheet_id/edit#gid=101",
  dataSheetTitle: "Job Pool",
  manifestUrl: "https://docs.google.com/spreadsheets/d/sheet_id/edit#gid=102",
  manifestSheetTitle: "Job Pool Manifest",
};

test("manual search prompt uses only the linked snapshot and requires full-read proof", () => {
  const prompt = buildManualJobSearchPrompt({
    search_mode: "profile",
    search_cadence: "manual",
    search_schedule_enabled: false,
    locations: ["London"],
    work_modes: ["hybrid"],
    salary: { minimum: 50000, target: 65000, currency: "GBP" },
  }, "run-1", 6000, ["Employer career sites"], snapshot);
  assert.match(prompt, /Google Drive integration/);
  assert.match(prompt, new RegExp(snapshot.dataUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /1500 active data rows/);
  assert.match(prompt, /access_check_token.*deliberately not included/);
  assert.match(prompt, /"rows_read":1500/);
  assert.match(prompt, /Do not create, update, or alter any ChatGPT Task/);
  assert.match(prompt, /rely only on ChatGPT Memory/);
  assert.doesNotMatch(prompt, /verified professional background|verified profile evidence|professional profile/);
  assert.doesNotMatch(prompt, /Verified evidence only/);
  assert.doesNotMatch(prompt, /token-1|access_check_token":"[0-9a-f-]{36}/i);
  assert.ok(prompt.length <= 6000);
});

test("configuration prompt distinguishes the mirror from ChatGPT task scheduling", () => {
  const prompt = buildJobSearchConfigurationPrompt({
    search_mode: "keywords_and_profile",
    search_cadence: "weekdays",
    search_schedule_enabled: true,
    search_time_local: "09:15",
    search_timezone: "Europe/London",
    target_roles: ["Product Manager"],
    role_families: ["product"],
    target_seniority: "senior",
    locations: ["London"],
    work_modes: ["hybrid"],
  }, 6000, ["Employer career sites"], snapshot);
  assert.match(prompt, /one current, read-only Google Sheets mirror/);
  assert.match(prompt, /At each actual search/);
  assert.match(prompt, /each weekday at the saved local time/);
  assert.match(prompt, /does not ask you to create or change a ChatGPT Task/);
  assert.match(prompt, /sends no profile facts/);
  assert.doesNotMatch(prompt, /verified summary|verified professional background|verified profile evidence/);
  assert.ok(prompt.length <= 6000);
});
