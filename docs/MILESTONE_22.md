# Milestone 22: Automatic application preparation

M22 turns an eligible discovery result into a durable preparation request without weakening the human approval gates.

## Delivered

- Owner-readable `application_preparation_requests` records source, frozen analysis, package payload, threshold decision, state and idempotency.
- Token-bound MCP preparation validates active membership, work scope, automation preference, eligibility, fit/priority threshold, frozen snapshot, CV family and verified evidence.
- Existing Applications are reused safely; new ones preserve the Job → snapshot → analysis context and queue the established idempotent preparation tasks.
- ChatGPT can read preparation status for an owned Application, and the Applications page shows recent automatic requests.

## Safety

Automatic preparation is not approval. The request remains before Gate 1, employer-form sessions are untouched, Gate 2 is unchanged and no employer submission tool exists. The private helper accepts a user ID only inside the trusted database boundary; the public MCP wrapper derives ownership from a hashed OAuth token.

## Verification

```sh
npm run milestone:22
npx --no-install tsc -p apps/web/tsconfig.json --noEmit --incremental false
```

The M22 schema is in `database/migrations/0044_m22_automatic_application_preparation.sql` and the covering index is in `0045_m22_preparation_fk_index.sql`.
