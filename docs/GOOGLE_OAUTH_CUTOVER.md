# Google OAuth cutover checklist

Use this only once the hosted production URL exists.

## Google Cloud
Create/configure an OAuth 2.0 Web application client. The authorised Google redirect URI for the Supabase social provider is:

`https://sgarcjiqkvlhldmrlsqo.supabase.co/auth/v1/callback`

The OAuth consent configuration must permit Gmail read-only plus the narrow `drive.file` scope requested by Job Hunt. Also enable the Google Picker API for the same Cloud project. Create an API key restricted to the production web origin and set the Cloud project number (Picker App ID) and API key as the public environment variables below. Google's [Drive authorization guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) recommends pairing `drive.file` with Picker when the user should choose the files an app can access.

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
- `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`
- `NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER`

Do not configure `OPENAI_API_KEY` for the zero-additional-cost path.

## First sign-in acceptance
The intended owner or tester must already have an active Job Hunt Console membership or invitation, and while the Google OAuth app remains in Testing they must also be listed as a Google OAuth test user.

1. Open the hosted `/login` page.
2. Continue with Google and approve Gmail read-only and `drive.file` access.
3. Confirm redirect to `/commissioning`.
4. Confirm 7+ facts, 18+ evidence items, 26+ applications and 1+ assessment.
5. Confirm Historical bootstrap = Ready.
6. Confirm Gmail refresh credential = Ready.
7. Run one Gmail sync from the dashboard and confirm status `ok`.
8. Open Settings → Automation, choose an existing Google Sheet in Picker, and confirm that Job Hunt creates/updates only the selected managed tab.
