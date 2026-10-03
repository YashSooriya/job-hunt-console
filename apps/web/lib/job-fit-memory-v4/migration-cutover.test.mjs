import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../../../database/migrations/20261001194253_job_fit_memory_v4_memory_only.sql", import.meta.url), "utf8");

test("the v4 cutover disables all fresh V3 profile-bearing dispatch paths", () => {
  assert.match(migration, /where t\.state='queued';[\s\S]{0,220}update public\.job_fit_v3_tasks/);
  assert.match(migration, /create or replace function private\.job_fit_v3_worker_create_batch_internal[\s\S]*?Profile-bearing V3 batch creation is retired/);
  assert.match(migration, /create or replace function private\.job_fit_v3_worker_dispatch_internal[\s\S]*?state='needs_user',error_message='Profile-bearing V3 prompts are retired/);
  assert.doesNotMatch(migration.slice(migration.indexOf("create or replace function private.job_fit_v3_worker_dispatch_internal"), migration.indexOf("-- Memory-based documents")), /create_chatgpt_dispatch_request_with_website_instruction/);
});

test("already-sent V3 turns remain claimable for exact capture/save recovery only", () => {
  const claim = migration.slice(migration.indexOf("create or replace function private.job_fit_v3_worker_claim_internal"), migration.indexOf("-- The scheduler can still finish/capture"));
  assert.match(claim, /join private\.app_memberships m on m\.user_id=t\.user_id and m\.status='active'[\s\S]*?where t\.state in \('waiting_for_bridge','saving'\)/);
  assert.doesNotMatch(claim, /where t\.state in \('queued','waiting_for_bridge','saving'\)\s+and \(t\.scheduler_lease_token/);
  assert.match(migration, /Profile-bearing V3 prompts are retired\. Run a fresh Memory-only analysis/);
});

test("database limits match the URL-only batch packer and allow honest incomplete Memory results", () => {
  assert.match(migration, /ordinal integer not null check \(ordinal between 1 and 100\)/);
  assert.match(migration, /instruction text not null check \(char_length\(instruction\) between 1 and 5800\)/);
  assert.match(migration, /v_chunk\.ordinal>100[\s\S]*?char_length\(v_chunk\.instruction\)>5800/);
  assert.match(migration, /alter column fit_score drop not null,[\s\S]*?alter column priority_score drop not null/);
});
