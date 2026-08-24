# Milestone 21: Recurring job discovery

M21 turns the M19 ChatGPT background-worker boundary into an auditable, per-user discovery loop.

## Delivered

- `job_search_sources` stores member-owned source enablement, type, health and configuration.
- `job_search_runs` stores manual, scheduled and ChatGPT-triggered run state, cadence-derived next-run time, bounded job limits and counters.
- `job_search_run_jobs` links discovered vacancies and later analyses back to the run without exposing another member's records.
- A current-user-only enqueue wrapper prevents callers from supplying an arbitrary user ID. ChatGPT uses a token-bound RPC with active-membership and scope checks.
- Search context is bounded to enabled sources, recent run history and a limited known-job dedupe set.
- Dashboard and Jobs UI show source controls, last/next run, state, counters and history.

## Worker contract

The supported user-created ChatGPT Task calls `ensure_search_run`, reads `get_search_context`, searches only enabled sources, avoids known dedupe keys, writes discoveries and analyses, optionally prepares eligible packages, then marks the work item complete with `jobs_checked`, `jobs_deduped` and `jobs_accepted` counters. A task never approves or submits an application.

## Safety

Search tables are RLS-protected. Run and run-job writes are trusted database operations; source updates are authenticated and owner-scoped. A user cannot pass `user_id` to the search routes or MCP tools. External crawling is still performed by the user's connected ChatGPT Task, not by an unbounded hidden server scheduler.

## Verification

```sh
npm run milestone:21
npx --no-install tsc -p apps/web/tsconfig.json --noEmit --incremental false
npm run build
npx --no-install opennextjs-cloudflare build
npx --no-install wrangler deploy --dry-run --keep-vars
```

The M21 schema is in `database/migrations/0043_m21_search_runs_and_context.sql`.
