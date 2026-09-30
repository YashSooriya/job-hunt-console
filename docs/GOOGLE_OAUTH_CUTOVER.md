# Google OAuth cutover checklist

Use this only once the hosted production URL exists.

## Google Cloud
Create/configure an OAuth 2.0 Web application client. The authorised Google redirect URI for the Supabase social provider is:

`https://sgarcjiqkvlhldmrlsqo.supabase.co/auth/v1/callback`

The OAuth consent configuration must permit Gmail read-only plus the narrow `drive.file` scope requested by JobHuntAI. Google Picker is not used and requires no API key or project-number configuration. JobHuntAI creates or recovers one workbook for the authenticated account; an older configured application-tracker workbook is adopted where available. Other Drive files are not searched broadly or modified.

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
The intended user must already have an active JobHuntAI membership or invitation, and while the Google OAuth app remains in Testing they must also be listed as a Google OAuth test user.

1. Open the hosted `/login` page and continue with Google.
2. When prompted, approve Gmail read-only and `drive.file` access.
3. Complete the guided onboarding or return to the page the user requested.
4. Open Settings → Google Sheets. If the status is already connected, do not repeat consent; use the existing grant. Otherwise choose Connect Google Sheets once and finish the Google flow.
5. Confirm the app returns to Settings and creates or recovers a single `JobHuntAI` spreadsheet without another consent loop.
6. Confirm the workbook has `Job Pool`, `Job Pool Manifest`, `Applications`, and `Applications Manifest` tabs, and the Settings card offers an Open spreadsheet link.
7. Confirm its job and application rows reflect Supabase. Existing unrelated Drive files and tabs must remain untouched; if an Applications tab cannot be verified against its recorded database hash, sync must stop without overwriting it.
8. ChatGPT may read the workbook only after the user separately connects Google Drive from ChatGPT; this is not required for sign-in or for the website itself to create and sync the workbook.
