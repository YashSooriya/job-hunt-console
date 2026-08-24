# Milestone 13 — Google Auth + Live Data Cutover

Status: implementation complete; external OAuth commissioning pending production URL.

## Purpose
Milestone 13 converts the staged, pre-authentication owner dataset into the authenticated owner account when the staged intended email signs in and proves the cutover visibly.

## First-login flow
1. User selects Continue with Google.
2. Supabase Google OAuth uses PKCE and requests Gmail read-only offline access.
3. `/auth/callback` exchanges the code, verifies the allow-listed email, and stores any Google provider refresh token in Supabase Vault.
4. `claim_bootstrap_import()` atomically claims the staged historical dataset.
5. A successful first claim redirects to `/commissioning`.
6. `/commissioning` reports only counts/status, never staged payload contents or OAuth secrets.

## Expected bootstrap
The current staged batch is expected to produce at least:
- 7 candidate facts
- 18 evidence items
- 26 historical applications
- 1 assessment

## Commissioning gates
- live candidate profile exists
- no pending bootstrap batch remains
- at least one batch is claimed by the authenticated user
- knowledge counts meet the seed baseline
- application history count meets the tracker baseline
- Gmail refresh credential exists in encrypted Vault storage

## External configuration still required
After Milestone 12 produces the production `workers.dev` URL:
- Google Cloud OAuth web client must authorize the Supabase callback URL.
- Supabase Auth Google provider must receive the Google client ID/secret.
- Supabase Auth Site URL and Redirect URL allow-list must include the hosted Job Hunt URL and `/auth/callback`.
- Cloudflare Worker secrets must include the same Google client ID/secret. Job Hunt Console access is controlled by database memberships, while the historical bootstrap remains bound to its staged intended owner email.

No paid OpenAI API is required.
