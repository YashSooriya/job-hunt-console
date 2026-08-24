# Milestone 12 — Production deployment

## Goal

Move Job Hunt Console from a production-ready repository to an actual Cloudflare Workers deployment while preserving the £0-additional-cost architecture.

## Production target

- Cloudflare Workers + OpenNext for the Next.js web application.
- `workers.dev` HTTPS hostname initially, so no paid domain is required.
- Existing Supabase Free project for PostgreSQL, Auth and Storage.
- Existing Supabase Edge Function for the browser-agent bridge.
- No OpenAI API key required.

## Deployment contract

The production deploy command is:

```sh
npm run production:deploy
```

It refuses deployment unless:

- `NEXT_PUBLIC_SUPABASE_URL` is set and HTTPS.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is set.
- `JOBHUNT_DATA_MODE=supabase` exactly.
- Google client ID/secret are either both present or both absent. Invite-only access is database-enforced and is not configured by a deployment-time email variable.

Google/Gmail OAuth credentials are allowed to remain absent until Milestone 13. That lets the Worker be deployed and health-checked before enabling sign-in.

## Hosted health contract

`GET /api/health` now checks both configuration and reachability of Supabase Auth. A healthy production deployment returns HTTP 200 only when:

- Supabase is configured;
- the Worker can reach Supabase;
- data mode is exactly `supabase`.

The endpoint exposes booleans only and never returns credentials.

## Free-hosting boundary

The first deployment should use the Worker-owned `workers.dev` URL. A custom domain is optional and not required for launch.

## Current execution-environment limitation

The ChatGPT sandbox used to build this milestone cannot currently complete `npm install`, so it cannot produce the OpenNext build artifact. The Cloudflare connector has also not exposed deployment actions in this runtime after authorisation. The repository is configured so the remaining action is one authenticated production deploy once either route is available.
