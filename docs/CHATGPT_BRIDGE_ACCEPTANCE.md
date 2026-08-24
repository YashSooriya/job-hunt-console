# ChatGPT bridge acceptance runbook

This is the human-only live acceptance checklist. It must be performed with a harmless diagnostic request and a test account/workspace. Do not use a real applicant, job application, employer account, or external communication.

## Preconditions

- Production database migration `0057_chatgpt_browser_dispatch.sql` is applied.
- The `chatgpt-bridge` Edge Function is deployed with the Supabase service-role secret.
- The extension zip was built with the exact production `JOB_HUNT_ORIGIN`.
- A user with an active Job Hunt membership is signed in to the web app.
- The tester is signed in to ChatGPT Plus in Chrome and can create a Project.

## Diagnostic acceptance

1. Open Job Hunt Settings → ChatGPT website dispatch.
2. Create a pairing code and confirm that it shows an expiry time and the dedicated bridge URL.
3. Load the unpacked extension or install the signed test build. Pair it with the code.
4. Create a Project named exactly `Job Hunt` and a dedicated empty conversation. Do not paste candidate or employer data into it.
5. In the active ChatGPT tab, bind the conversation. Confirm the server status shows the device, exact binding, and Automatic Send off.
6. Enable Automatic Send in the extension popup. Confirm the server status changes to on.
7. Click **Send harmless diagnostic** in Job Hunt Settings.
8. Confirm the extension claims exactly one `bridge.diagnostic` request and the ChatGPT composer receives only the fixed dispatch instruction.
9. Confirm the request progresses through delivery and that the MCP server can claim and complete it without reading applicant data.
10. Disable Automatic Send and revoke the device. Confirm future dispatches stop and the status reports the revocation.

## Safe-stop acceptance

Repeat with one condition at a time and confirm no message is sent:

- sign out or show the ChatGPT login screen;
- open a different conversation or different Project;
- leave a permission/CAPTCHA/confirmation dialog visible;
- make the Send control ambiguous or change the UI locale;
- stop/reload the service worker during a diagnostic delivery.

Each case must result in `user_required` or a bounded failure/manual fallback. The extension must not click an unknown control, submit an application, send an email, or automatically resend after uncertain delivery.

## Release evidence

Record the date, Chrome version, ChatGPT UI locale, extension version, web deployment identifier, Edge Function deployment identifier, migration version, diagnostic dispatch id, and screenshots of the settings status. Redact pairing codes, device tokens, OAuth tokens, conversation content, and personal data.

This runbook does not claim that Chrome Web Store review or publication has occurred. Those require a separately authorized store account and review process.
