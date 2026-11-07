import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const migration = await read("database/migrations/20261107163734_m05_explicit_apply_choice.sql");
const ingest = await read("apps/web/app/api/jobs/ingest/route.ts");
const createRoute = await read("apps/web/app/api/applications/create/route.ts");
const createButton = await read("apps/web/components/application-create-button.tsx");
const poolTable = await read("apps/web/components/job-pool-table.tsx");
const applicationPage = await read("apps/web/app/applications/[id]/page.tsx");
const documentRoute = await read("apps/web/app/api/applications/[id]/documents/generate/route.ts");
const sheet = await read("apps/web/lib/google-job-pool-sheet.ts");
const inspectionRoute = await read("apps/web/app/api/jobs/inspect/route.ts");

assert.match(migration, /add column if not exists chosen_to_apply_at timestamptz/i);
assert.match(migration, /where preparation_origin='manual' and chosen_to_apply_at is null/i);
assert.doesNotMatch(migration, /update public\.applications\s+set preparation_origin/i,
  "Legacy application origins must remain unchanged.");

const applyRpc = migration.match(/create or replace function public\.create_application_from_job\([\s\S]*?\$\$;/)?.[0] || "";
assert.match(applyRpc, /security invoker/i);
assert.match(applyRpc, /p_origin is distinct from 'manual'/i);
assert.match(applyRpc, /public\.jobs where id=p_job_id and user_id=v_user for update/i,
  "Same-job apply calls must serialize before checking or creating the application.");
assert.match(applyRpc, /chosen_to_apply_at=v_now/i);
assert.match(applyRpc, /legacy_application_adopted',true/i);
assert.match(applyRpc, /'prepare_cv','needs_user'/i);
assert.doesNotMatch(applyRpc, /insert into public\.(documents|document_generation_requests|form_agent_sessions)/i,
  "Choosing to apply must not create documents or start employer-form work.");

assert.match(ingest, /return NextResponse\.json\(\{ ok: true, id: result\.id, analysis: result\.analysis, source: "supabase" \}\)/);
assert.doesNotMatch(ingest, /createApplicationFromJob|autoPrepareError|applicationId/);
assert.match(createRoute, /explicit Choose to apply action/);
assert.match(createButton, /existingApplicationId && existingApplicationChosenAt/);
assert.match(createButton, /body: JSON\.stringify\(\{ jobId, origin: "manual" \}\)/);
assert.match(poolTable, /existingApplicationChosenAt=\{application\?\.chosenToApplyAt \|\| null\}/);
assert.match(poolTable, /Restore this vacancy before choosing to apply/);

assert.match(migration, /update public\.automation_tasks[\s\S]*state='needs_user'[\s\S]*a\.chosen_to_apply_at is null/i);
assert.match(migration, /create trigger application_tasks_require_application_choice/i);
assert.match(migration, /create or replace function private\.prepare_application_for_user[\s\S]*explicit_application_choice_required/i);
assert.match(migration, /create or replace function private\.start_form_agent_session_for_user[\s\S]*chosen_to_apply_at is null/i);
assert.match(migration, /update public\.form_agent_sessions[\s\S]*status='cancelled'[\s\S]*a\.chosen_to_apply_at is null/i);
assert.match(migration, /create trigger document_versions_require_application_choice/i);
assert.match(migration, /create trigger application_answers_require_application_choice/i);

assert.match(documentRoute, /chosen_to_apply_at/);
assert.match(applicationPage, /Boolean\(application\.chosenToApplyAt\)/);
assert.match(applicationPage, /separate explicit request/);
assert.match(sheet, /process\.env\.NODE_ENV === "development"[\s\S]*await sync/);
assert.match(sheet, /ctx\.waitUntil\(sync\.catch/);
assert.match(inspectionRoute, /const hasImportedJob = reconciled\.some\(\(inspection\) => inspection\.status === "completed" && Boolean\(inspection\.job_id\)\)/);
assert.match(sheet, /state\.current_publication_id && state\.last_sync_status === "ok"/);

console.log("M05 explicit apply-choice, legacy safety, document/form gates, and local Sheet catch-up contracts passed.");
