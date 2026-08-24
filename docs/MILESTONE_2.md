# Milestone 2: Historical applications and ownership-safe migration

Milestone 2 moves the existing job-search history from a local snapshot into a migration-ready live Supabase path without weakening authentication or RLS.

## Delivered

- Normalised historical tracker containing 26 application records.
- Preserved source spreadsheet row numbers and original tracker values for reconciliation.
- Added tracker quality reporting and a blocking/non-blocking verification step.
- Added a private Supabase staging table that is not part of the public Data API surface.
- Staged the original owner applicant knowledge and historical application data against the intended owner Google email.
- Added an authenticated `claim_bootstrap_import()` RPC.
- Wired the Google OAuth callback to claim the pending batch only when the authenticated member email matches the staged intended owner email.
- Made the claim idempotent through the existing `(user_id, source_tracker_row)` application uniqueness rule.
- Creates assessment records for historical applications already at assessment stage.
- Records successful ownership claim in the audit log.
- Updated Dashboard and Applications views for historical migration status and data-quality review.

## Live staged dataset

The pending live Supabase bootstrap batch contains:

- 7 verified candidate facts
- 7 evidence/source records
- 18 atomic evidence items
- 26 historical application records
- 1 historical/current assessment record to be created on claim

The batch remains in the `private` schema until a successful Google OAuth sign-in by the intended account. It is not anonymously readable.

## Data-quality findings

Migration verification has zero blocking errors. Three source-data notes are intentionally retained for review rather than guessed or silently altered:

1. Structural Analysis Engineer, tracker row 11: employer is not identified.
2. Tower Research Capital, tracker row 21: role is not identified in the confirmation.
3. G-Research, tracker row 10: the original Notes cell contained a spreadsheet formula error; the snapshot preserves that as an explicit migration note.

## Claim flow

```text
Private staged batch
        |
        | Google OAuth succeeds
        v
Authorised email verified
        |
        v
claim_bootstrap_import()
        |
        +--> candidate profile + preferences
        +--> facts + evidence sources + evidence items
        +--> companies + jobs + applications
        +--> assessment rows where applicable
        +--> audit event
        v
Batch marked claimed
```

The claim runs with the authenticated user's database role. Normal RLS policies therefore remain in force while the data is inserted.

## Verification

Run:

```bash
npm run milestone:2
```

This performs:

1. tracker normalisation
2. historical migration validation
3. repository contract verification

Expected current result:

```text
26 applications
1 assessment
16 under review
5 rejected
3 non-blocking data-quality notes
0 blocking migration errors
Repository contract verification passed
```

## Remaining external auth step

Google OAuth provider credentials still need to be enabled in the Supabase Auth dashboard. Once that is configured, the first successful authorised sign-in will claim the staged live batch automatically. The historical dataset does not need to be re-imported manually.

## Milestone boundary

Milestone 2 does not yet implement new-job discovery or AI job scoring. Those belong to the next job-intelligence milestone.
