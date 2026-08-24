# Google OAuth cutover checklist

Use this only once the hosted production URL exists.

## Google Cloud
Create/configure an OAuth 2.0 Web application client. The authorised Google redirect URI for the Supabase social provider is:

`https://sgarcjiqkvlhldmrlsqo.supabase.co/auth/v1/callback`

The OAuth consent configuration must permit the Gmail read-only scope requested by Job Hunt.

## Supabase Auth
Authentication → Providers → Google:
- enable Google
- set Google client ID
- set Google client secret

Authentication → URL Configuration:
- Site URL: the final HTTPS `workers.dev` Job Hunt URL
- Redirect URLs: include `<production-url>/auth/callback`
- keep localhost callback only for development if needed

## Cloudflare Worker secrets
Set:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `JOBHUNT_DATA_MODE=supabase`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Do not configure `OPENAI_API_KEY` for the zero-additional-cost path.

## First sign-in acceptance
The intended owner or tester must already have an active Job Hunt Console membership or invitation, and while the Google OAuth app remains in Testing they must also be listed as a Google OAuth test user.

1. Open the hosted `/login` page.
2. Continue with Google and approve Gmail read-only access.
3. Confirm redirect to `/commissioning`.
4. Confirm 7+ facts, 18+ evidence items, 26+ applications and 1+ assessment.
5. Confirm Historical bootstrap = Ready.
6. Confirm Gmail refresh credential = Ready.
7. Run one Gmail sync from the dashboard and confirm status `ok`.
