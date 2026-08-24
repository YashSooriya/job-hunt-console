# Milestone 8 - Gmail monitoring

## Scope

- request Google `gmail.readonly` plus narrow `drive.file` access for the optional managed tracker Sheet
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
- ChatGPT MCP classification of bounded pending email reviews
- per-user email-monitoring cadence and optional managed Google Sheets tracker

## Automatic actions

Only a deterministic or ChatGPT-classified status event with a sufficiently confident Application match may change state automatically:

- confirmation: `submitted -> awaiting_response`
- rejection: active post-submission state -> `rejected`
- assessment: `submitted|awaiting_response -> assessment`
- interview: `submitted|awaiting_response|assessment -> interview`

ChatGPT assigns the category automatically. Offers and recruiter messages remain human decision points; uncertain events and ambiguous/unmatched messages remain in `Needs You` with their category already recorded.

## Gmail safety

The OAuth request contains `https://www.googleapis.com/auth/gmail.readonly` and the narrow `https://www.googleapis.com/auth/drive.file` scope. No message is sent, modified, labelled, archived or deleted. In Settings → Automation, the user can create a tracker workbook or explicitly choose an existing workbook through Google Picker. The Sheet writer only uses that recorded workbook and exact managed tab; it does not fall back to another tab or edit unrelated workbooks. Provider access tokens are never stored in public Job Hunt tables. When Google returns a refresh token during consent, it is captured server-side and stored encrypted in Supabase Vault. The server uses it to refresh short-lived access tokens. If the refresh token is unavailable or revoked, sync becomes `needs_reconnect`.

The existing-workbook path follows Google's least-privilege `drive.file` plus Picker pattern: the user selects the file, Job Hunt validates the selection server-side, and a dedicated `Job Hunt Applications` tab is created by default when needed. See the [Google Drive API authorization guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [Google Picker web guide](https://developers.google.com/workspace/drive/picker/guides/web-picker).

The hosted sync is deliberately bounded to 15 messages per Worker invocation. Each message requires one Gmail read and one user-scoped Supabase processing RPC, so an unbounded backfill could exceed the Cloudflare subrequest budget. Re-running sync is idempotent and continues from the same bounded recent-message window.

## Acceptance tests

The fixture uses real recent recruiting-email examples and verifies:

- Rolls-Royce assessment classification + reference-ID match
- Prima rejection classification + role/company match
- Cadillac rejection classification + role/company match
- Mott MacDonald confirmation + job-ID match
- applicant-experience survey suppression
- unmatched confirmation becomes `Needs You`
- offer always remains user-reviewed
