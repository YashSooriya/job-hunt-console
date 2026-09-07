# Production runbook

## Hosting

Production web hosting target: Cloudflare Workers using the Cloudflare OpenNext adapter. The application continues to use the existing Supabase Free project for PostgreSQL/Auth/Storage and the existing Supabase Edge Function for the form-agent bridge.

The deployment supports two inspection modes. The connected ChatGPT/MCP mode does not require OpenAI API billing. If `OPENAI_API_KEY` is configured as a server-only Worker secret, the Jobs URL button starts an OpenAI Responses API inspection immediately; this is billed to the configured OpenAI API account and is not a chatgpt.com conversation.

## Required environment

Set these in the Cloudflare Worker build/runtime environment:

- `NEXT_PUBLIC_APP_NAME=JobHuntAI`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `JOBHUNT_DATA_MODE=supabase`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`
- `NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER`

Optional for immediate URL inspection:

- `OPENAI_API_KEY` (Cloudflare Worker secret; never expose it through `NEXT_PUBLIC_*`)
- `OPENAI_JOB_INSPECTION_MODEL` (optional Worker variable, defaults to `gpt-5.4`)

Without the OpenAI key, the button remains functional through the connected ChatGPT Task/MCP fallback, but it will wait for that Task rather than starting a call immediately.

## Google OAuth

In Google Cloud, configure one Web OAuth client. Add the Supabase Auth callback URL as an authorised redirect URI. In Supabase Auth, enable Google and use the same client ID and secret. Add the final Cloudflare `workers.dev` origin plus `/auth/callback` to the Supabase redirect allow-list.

The application requests Google identity plus Gmail `gmail.readonly` and narrow `drive.file` access; no send/modify/delete Gmail scopes are required. Enable the Google Picker API in the same Cloud project, restrict the public Picker API key to the hosted origin, and use the project number as the Picker App ID. The Settings → Automation page can then create a new tracker or connect an existing workbook selected by the user. Only the selected workbook and managed tab are written.

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
