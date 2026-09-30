# Production runbook

## Hosting

Production web hosting target: Cloudflare Workers using the Cloudflare OpenNext adapter. The application continues to use the existing Supabase Free project for PostgreSQL/Auth/Storage and the existing Supabase Edge Function for the form-agent bridge.

All ChatGPT tasks use the Website Bridge and a user-visible ChatGPT conversation. No OpenAI API key or user-created ChatGPT plugin is required. Job URL inspection, search setup, manual searches, onboarding, and diagnostics all use the generic bridge dispatch flow.

## Required environment

Set these in the Cloudflare Worker build/runtime environment:

- `NEXT_PUBLIC_APP_NAME=JobHuntAI`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `JOBHUNT_DATA_MODE=supabase`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `JOB_POOL_SCHEDULER_SECRET` (Cloudflare Worker secret; set the same randomly generated value stored in Supabase Vault under `job-pool-scheduler-secret`)

The managed workbook does not require Google Picker configuration. Subsequent deployments preserve existing Cloudflare runtime variables.

## Google OAuth

In Google Cloud, configure one Web OAuth client. Add the Supabase Auth callback URL as an authorised redirect URI. In Supabase Auth, enable Google and use the same client ID and secret. Add the final Cloudflare `workers.dev` origin plus `/auth/callback` to the Supabase redirect allow-list.

The application requests Google identity, Gmail `gmail.readonly`, and narrow `drive.file` access; no send/modify/delete Gmail scopes are required. A user can grant or reconnect Google Sheets access from Settings. The app creates or recovers one `JobHuntAI` workbook for that account and keeps the `Job Pool`, `Job Pool Manifest`, `Applications`, and `Applications Manifest` tabs together. The OAuth callback distinguishes routine sign-in from Sheets setup, preserves a previously stored refresh grant when Google does not return a new one, and reports failures without discarding credentials. Google access for JobHuntAI is separate from ChatGPT's Google Drive connection.

Supabase is the source of truth. The workbook is a one-way mirror: the Job Pool and manifest are published from Supabase and verified against the exact database revision before ChatGPT searches; Applications are published from Supabase only after the current database-backed hash matches, so external edits are not silently overwritten. A previous application-tracker workbook is adopted as the canonical workbook when possible; other spreadsheet files and tabs are not deleted. Manual and scheduled searches are held if the current Sheet or database snapshot cannot be verified. Scheduled preflight also checks the live Drive file version. Generate a high-entropy `JOB_POOL_SCHEDULER_SECRET`, store it in Supabase Vault with the exact name `job-pool-scheduler-secret`, and set the same value as a Cloudflare Worker secret. Never put the value in source control or an ordinary environment file. Migration `20260929141153_job_pool_scheduler_vault_secret` (`0118_job_pool_scheduler_vault_secret.sql`) gives only `service_role` a fixed-path RPC to retrieve it for the custom-authenticated Edge Function; the secret is never returned by that function. The `job-pool-scheduler` function disables platform JWT verification only because it validates this header itself in constant time.

## Deploy

For the first free deployment, use the Worker-owned `workers.dev` hostname. A custom domain is optional.

The canonical deployment command is:

```sh
npm run production:deploy
```

This first validates the production environment, then the repository contracts, then builds/deploys through OpenNext/Wrangler. For a production deploy, set `JOBHUNT_DATA_MODE=supabase` exactly.

To check the environment separately:

```sh
npm run production:env:verify
```

After deployment, open `/api/health`. HTTP 200 means the hosted Worker has the required Supabase configuration, can reach Supabase Auth, and is running in `supabase` data mode.

Cloudflare runtime values and Google OAuth secrets must be configured before deployment/first login. Application access itself is controlled by invite-only memberships in Supabase, not a deployment-time email allow-list. Never commit `.env.local`.

## Browser companion

On the user's machine:

```sh
npm run browser:chrome
```

This launches a persistent dedicated JobHuntAI Chrome profile. Log into ATS/employer sites in that profile.

For acceptance tests, always use:

```sh
npm run browser:acceptance -- --session <id> --token <token> --supabase <url>
```

Acceptance mode stops at final employer review and cannot click Submit.
