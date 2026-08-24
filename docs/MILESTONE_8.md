# Milestone 8 - Gmail monitoring

## Scope

- request Google `gmail.readonly` alongside the existing Google sign-in
- server-side Gmail list/read adapter
- deterministic recruiting-email classification
- deterministic Application matching with explicit confidence
- idempotent email persistence by Gmail message ID
- safe high-confidence pipeline updates
- assessment/interview source-email linking
- dashboard auto-sync and `Needs You` surfacing
- contextual manual email-review flow
- per-Application recruiting-email timeline
- encrypted Google refresh-token persistence in Supabase Vault for durable read-only sync

## Automatic actions

Only a deterministic status event with a sufficiently confident Application match may change state automatically:

- confirmation: `submitted -> awaiting_response`
- rejection: active post-submission state -> `rejected`
- assessment: `submitted|awaiting_response -> assessment`
- interview: `submitted|awaiting_response|assessment -> interview`

Offers, recruiter messages, uncertain events and ambiguous/unmatched messages require user review.

## Gmail safety

The OAuth request contains only `https://www.googleapis.com/auth/gmail.readonly`. No message is sent, modified, labelled, archived or deleted. Provider access tokens are never stored in public Job Hunt tables. When Google returns a refresh token during consent, it is captured server-side and stored encrypted in Supabase Vault. The server uses it to refresh short-lived access tokens. If the refresh token is unavailable or revoked, sync becomes `needs_reconnect`.

## Acceptance tests

The fixture uses real recent recruiting-email examples and verifies:

- Rolls-Royce assessment classification + reference-ID match
- Prima rejection classification + role/company match
- Cadillac rejection classification + role/company match
- Mott MacDonald confirmation + job-ID match
- applicant-experience survey suppression
- unmatched confirmation becomes `Needs You`
- offer always remains user-reviewed
