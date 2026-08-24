# Milestone 23: Browser-helper reasoning loop

M23 gives paused employer-form sessions a safe reasoning handoff without turning ChatGPT into an unattended form operator.

## Delivered

- `needs_user` transitions create per-user `browser_question` work items.
- `browser_agent_reasoning` stores bounded ChatGPT proposals and user decisions with session/observation provenance.
- ChatGPT can read paused-session context and save a proposal, but the response explicitly reports `resumed=false` and `applied=false`.
- Application status exposes proposals with Accept/Reject controls; accepting a proposal still requires a separate Resume helper action.
- The Edge bridge and local helper carry advisory proposals for display while deterministic observation/plan validation remains authoritative.

## Safety

No proposal can mutate a form field, transition a session to active, approve Gate 2 or submit an employer form. Sensitive and authentication pauses remain user-owned. Proposals are bounded, member-scoped and audit logged.

## Verification

```sh
npm run milestone:23
npx --no-install tsc -p apps/web/tsconfig.json --noEmit --incremental false
```

The M23 schema is in `database/migrations/0046_m23_browser_reasoning_loop.sql`.
