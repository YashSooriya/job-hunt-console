# Milestone 20: Zero-friction guided activation

M20 turns the former profile form into a self-serve activation workspace for a newly invited member.

## Delivered

- Worker-compatible extraction for PDF, DOCX, TXT, Markdown and RTF uploads.
- Original source files remain in the private `candidate-source-documents` bucket under the authenticated user path.
- PDF/DOCX extraction runs server-side; the user is not asked to paste selectable document text.
- Extracted contact facts and CV claims enter `needs_review`/Amber with source and locator metadata.
- Extraction proposals are materialized as reusable evidence only after an explicit Verify action.
- Rejected proposals remain retained as rejected audit state.
- Direct personal questions remain explicit: work authorisation, sponsorship, salary, notice period and other sensitive facts are not inferred.
- Job-search strategy captures roles, role families, seniority, industries, locations, commute, work modes, salary strategy, posting-age policy, fit and auto-prepare thresholds, cadence and application automation preference.
- The activation checklist exposes Gmail, ChatGPT and browser-helper readiness in the primary web UI.
- PostgreSQL readiness prevents completion while required facts, preferences, source review or service connections are missing.

## Safety

Every applicant-owned query is scoped by the authenticated candidate profile. The new extraction-proposal table has RLS and an owner policy. A verified proposal becomes an evidence item; it does not silently become a candidate fact or a reusable answer. Human Gate 1 and Gate 2 remain unchanged.

## Verification

```sh
npm run milestone:20
npx --no-install tsc -p apps/web/tsconfig.json --noEmit --incremental false
npm run build
npx --no-install opennextjs-cloudflare build
npx --no-install wrangler deploy --dry-run --keep-vars
```

The M20 schema is in `database/migrations/0041_m20_guided_activation.sql` and `0042_m20_proposal_fk_index.sql`.
