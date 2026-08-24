# Milestone 4: Application creation and Auto-prepare

Milestone 4 joins the discovered-Job side of the product to the Application pipeline.

A Job remains a discovery object until preparation begins. Creating an Application now freezes the exact vacancy snapshot and job analysis used, locks the application strategy, selects the CV family and creates an idempotent preparation queue.

## Delivered

- `Prepare application` action from an analysed Job.
- Automatic Application creation for eligible Jobs classified `auto_prepare`.
- Transactional Supabase RPC `create_application_from_job` so the Application, frozen context, strategy and preparation tasks are created together.
- Per-job idempotency through the existing `applications(user_id, job_id)` uniqueness rule and per-task idempotency keys.
- Frozen `job_snapshot_id` and `job_analysis_id` on new Applications.
- Trigger preventing a later update from silently swapping the vacancy or analysis context used for the Application.
- Persisted `selected_cv_family` and `preparation_origin` (`manual` or `auto_prepare`).
- Application strategy copied from the chosen job analysis with evidence IDs preserved.
- Preparation task queue covering CV, conditional cover letter, screening answers, salary context and final review-package assembly.
- Deterministic bootstrap steps marked complete immediately: freeze context, lock strategy and select CV family.
- ChatGPT Plus handoff execution mode for content tasks, avoiding separately billed OpenAI API calls.
- New `/applications/[id]` preparation workspace showing strategy, frozen context, evidence and task progress.
- Applications dashboard separates the new preparation queue from historical submitted applications.
- Dashboard surfaces applications currently preparing.

## Auto-prepare safety gate

Automatic creation is allowed only when all of these are true:

```text
job triage = auto_prepare
eligibility = eligible
latest analysis has a CV-family recommendation
current vacancy snapshot exists
```

`recommend`, `maybe`, `reject`, unknown eligibility and ineligible jobs cannot enter the automatic path.

A user may manually create an Application for `recommend`, `maybe`, or eligible-with-concerns/unknown-eligibility roles if they deliberately choose to investigate them. `reject` and `ineligible` remain blocked until a later analysis changes that conclusion.

## Frozen context

On Application creation the database records:

```text
job_snapshot_id
job_analysis_id
selected_cv_family
preparation_origin
application_strategy
strategy evidence IDs
```

The vacancy and analysis IDs cannot later be changed in place. A later re-analysis may exist on the Job, but it does not silently rewrite the historical basis of an existing Application.

## Preparation queue

Every Application receives these logical steps:

1. `freeze_job_context` → completed
2. `lock_application_strategy` → completed
3. `select_cv_family` → completed
4. `prepare_cv` → pending
5. `prepare_cover_letter` → pending only when worthwhile, otherwise explicitly skipped/completed
6. `prepare_screening_answers` → pending
7. `research_salary` → pending only when salary is absent, otherwise completed from advertised context
8. `assemble_review_package` → pending

Content-generation tasks use:

```text
execution_mode = chatgpt_plus_handoff
```

This milestone does not call the separately billed OpenAI API.

## Approval invariant

The Application is created directly in:

```text
preparing
```

It does not create a form-completion task and does not create a submission task.

The existing state machine still requires:

```text
preparing
→ ready_for_review
→ content_approved
→ form_in_progress
→ final_review
→ approved_for_submission
→ submitted
```

No part of Milestone 4 can bypass Gate 1 or Gate 2.

## Persistence

Migration `0010_application_creation_and_auto_prepare.sql` adds the frozen Application context and transactional creation RPC. Migration `0011_application_creation_idempotency_fix.sql` hardens repeat creation calls into strict no-ops so re-ingesting a vacancy cannot silently append a newer strategy to an already frozen Application.

The RPC is `SECURITY INVOKER`, requires an authenticated Supabase user and therefore remains subject to the existing RLS policies. Anonymous execution is revoked.

## Local mode

Validated local mode mirrors the same preparation plan in:

```text
data/applications/preparing.json
```

This allows the complete Job → Application workflow to be tested without Supabase or any paid service.

## Automated verification

Run:

```bash
npm run milestone:4
```

The verifier checks:

- Application starts in `preparing`
- auto-prepare cannot be used for merely recommended Jobs
- rejected Jobs are blocked
- ineligible Jobs are blocked
- CV family and strategy are preserved
- high-value cover letters are queued
- low-value cover letters are explicitly skipped
- missing salary creates a research task
- advertised salary resolves the initial salary task
- no submission task exists anywhere in the preparation plan
- deterministic bootstrap tasks complete while content work remains pending

## Milestone boundary

Milestone 4 creates and queues the Application package, but it does not yet generate the tailored CV or cover letter artifacts.

The next milestone is the evidence-backed CV engine and document-version workflow.
