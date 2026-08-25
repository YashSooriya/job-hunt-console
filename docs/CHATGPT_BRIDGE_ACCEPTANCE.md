# ChatGPT bridge acceptance runbook

This is the human-only live acceptance checklist. It must be performed with a harmless diagnostic request and a test account/workspace. Do not use a real applicant, job application, employer account, or external communication.

## Preconditions

- Production database migrations `0057_chatgpt_browser_dispatch.sql` and `0058_chatgpt_bridge_conversation_slots.sql` are applied.
- The `chatgpt-bridge` Edge Function is deployed with the Supabase service-role secret.
- The extension zip was built with the exact production `JOB_HUNT_ORIGIN`.
- A user with an active Job Hunt membership is signed in to the web app.
- The tester is signed in to ChatGPT Plus in Chrome and can create a Project.

## Diagnostic acceptance

1. Open Job Hunt Settings → ChatGPT website dispatch.
2. Create a pairing code and confirm that it shows an expiry time and the dedicated bridge URL.
3. Load the unpacked extension or install the signed test build. Pair it with the code.
4. Create a Project named exactly `Job Hunt` and open its Project home. Do not paste candidate or employer data into it.
5. In the extension, choose **Set up missing workflow chats**. Confirm it creates/binds the workflow slots sequentially and leaves Automatic Send off. If a safe stop occurs, reopen the popup and confirm setup resumes only for missing slots.
6. Confirm the Job Hunt Settings panel lists multiple workflow conversations, not one universal binding. Confirm the diagnostic slot has its own URL.
7. Enable Automatic Send in the extension popup. Confirm the server status changes to on.
8. Click **Send harmless diagnostic** in Job Hunt Settings.
9. Confirm the extension claims exactly one `bridge.diagnostic` request and the diagnostic conversation receives only the fixed dispatch instruction.
10. Confirm a CV or job-search dispatch, if available in the test account, targets its corresponding workflow conversation rather than the diagnostic conversation.
11. Bind/rebind one workflow to a fresh Project chat. Confirm only that slot changes and Automatic Send turns off; existing Job Hunt dispatch records remain unchanged.
12. Disable Automatic Send and revoke the device. Confirm future dispatches stop and the status reports the revocation.

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
