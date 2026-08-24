# Milestone 24: Reliability, operations and acceptance

M24 hardens the background-worker and browser-helper surfaces for real use while keeping the human gates intact.

## Delivered

- Per-user database rate-limit windows for MCP reads, writes, search runs and browser reasoning.
- Bounded pending-work context and stale lease recovery with a five-attempt retry cap.
- Current-user operations status for queue, search, browser-pause and rate-window counts in Settings.
- User-created ChatGPT Task instructions now recover stale work before starting a bounded run.
- A precise two-user production acceptance runbook with an explicit pending status.

## Safety

Rate limits and recovery are owner-scoped. Private helpers that accept a user ID are not client-executable. Operations status excludes private payloads and credentials. Reliability recovery cannot approve, resume, submit or change another user's work.

## Verification

```sh
npm run milestone:24
npx --no-install tsc -p apps/web/tsconfig.json --noEmit --incremental false
```

The M24 schema is in `database/migrations/0047_m24_reliability_operations.sql`. Two-user acceptance remains pending until the human run in `docs/TWO_USER_ACCEPTANCE_RUNBOOK.md` is completed.
