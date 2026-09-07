# Deploy JobHuntAI Console now

This repository is already configured for the existing Supabase backend and Cloudflare Workers/OpenNext.

On the Mac that you want to use for commissioning:

```bash
chmod +x deploy-first-time-mac.sh
./deploy-first-time-mac.sh
```

The script will:

1. verify Node.js 22+ and npm,
2. ask which Google/Gmail address is allowed to sign in,
3. install dependencies,
4. run the production environment/readiness checks,
5. build the OpenNext Worker,
6. perform a Cloudflare dry-run and stop if the compressed Worker would exceed the Workers Free 3 MiB limit,
7. open Cloudflare authentication if Wrangler is not already authorised,
8. deploy the Worker with its runtime values,
9. extract the `workers.dev` URL,
10. verify `/api/health` against the live Supabase project.

No Google client secret or Cloudflare token is embedded in this repository. Temporary deployment secrets are written to a temporary file and removed on exit.

After this succeeds, the site is online but protected pages will show the Google login screen until the production Google OAuth client and Supabase Google provider are commissioned.

## Website Bridge rollout

The web Worker deployment does not apply Supabase migrations or update the bridge Edge Function. Deploy the bridge separately, in this order, from an authenticated Supabase CLI session:

```bash
npx supabase link --project-ref "$SUPABASE_PROJECT_REF"
npx supabase db push
npx supabase functions deploy chatgpt-bridge --no-verify-jwt
```

The migration set must include `0083_chatgpt_bridge_delivery_v2.sql`, `0084_chatgpt_bridge_safety_hardening.sql`, and `0085_chatgpt_bridge_boundary_reconciliation.sql`. The function uses its own device-token authentication, which is why JWT verification remains disabled for this function. After deployment, run the harmless diagnostic checklist in `docs/CHATGPT_BRIDGE_ACCEPTANCE.md` with a test account before enabling Automatic Send for users.

If the script stops with an error, copy the complete Terminal output into the JobHuntAI ChatGPT Project. Do not buy a paid Cloudflare plan as a workaround for a build/size error.
