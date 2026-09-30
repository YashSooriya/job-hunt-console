# ChatGPT bridge acceptance runbook

This is the human-only live acceptance checklist. It must be performed with a harmless diagnostic request and a test account/workspace. Do not use a real applicant, job application, employer account, or external communication.

## Preconditions

- Production database migrations through `0115_diagnostics_chatgpt_action_lock_override.sql` are applied, including the v3 security boundary `0101`, Members administration `0113`, captured-import recovery `0114`, and the default-off Diagnostics action-lock override `0115`; the security verifier must pass before live acceptance.
- The `chatgpt-bridge` Edge Function is deployed with the Supabase service-role secret.
- The extension zip was built with the exact production `JOB_HUNT_ORIGIN`.
- A user with an active JobHuntAI membership is signed in to the web app.
- The tester is signed in to ChatGPT Plus in Chrome and can create a Project.

## Diagnostic acceptance

1. Open JobHuntAI Settings → ChatGPT website dispatch.
2. Create a pairing code and confirm that it shows an expiry time and the dedicated bridge URL.
3. Load the unpacked extension or install the signed test build. Pair it with the code.
4. Leave ChatGPT signed in and confirm the account can create a Project. Do not paste candidate or employer data into ChatGPT during setup.
5. In the extension, choose **Set up JobHuntAI + workflow chats**. Confirm it reuses or creates the exact Project, then creates/binds the workflow slots sequentially and preserves the current Automatic Send setting. If a safe stop occurs, reopen the popup and confirm setup resumes only for missing slots.
6. Confirm the JobHuntAI Settings panel lists multiple workflow conversations, not one universal binding. Confirm the diagnostic slot has its own URL.
7. Enable Automatic Send in the extension popup. Confirm the server status changes to on.
8. Enable the **Testing mode** toggle on the Diagnostics page. Confirm it is on before sending any test request; test messages must explicitly say not to save anything to memory.
9. Open `/diagnostics` and click **Send harmless diagnostic** once. While it is in progress, confirm other ChatGPT-send actions are disabled across the app. Once its response is complete, click **Send harmless diagnostic** again immediately; there must be no cooldown between completed sends.
10. Confirm both requests complete with their own responses, `/diagnostics` remains the selected Chrome tab, the ChatGPT helper tab stays inactive, and the extension remains paired. Each response must be captured from the exact assistant turn for its corresponding user message.
11. Confirm the diagnostic conversation receives the action handler’s plain-language task prefixed by the testing warning; it must not receive an internal request id or protocol wording.
12. In the diagnostics lifecycle panel, confirm the extension version and build id are shown and timestamps appear in order: browser hint, extension receipt, server claim, tab/content/composer readiness, Send boundary, verified user turn, response detection, and response upload. Confirm the panel contains no task text, pairing code, token, or conversation contents in lifecycle data.
13. Confirm the global spinner appears only after ChatGPT is generating/waiting for the response, and disappears as soon as the assistant response is captured—even if its upload is still pending.
14. With the extension stopped or disconnected before claim, confirm the page says **Waiting for extension** or **Extension build is outdated**. With ChatGPT generating after a verified Send, confirm it says **Message sent; waiting for ChatGPT**. After a response is captured but upload is made to fail, confirm it says **Response captured; retrying upload** and does not offer a resend.
15. Force a pre-Send safe stop and confirm the server reports `retry_allowed`; the page may show **Retry safely**. Force the same test after `send_attempted_at` or `sent_at` is recorded and confirm no retry button appears.
16. Confirm a CV or job-search dispatch, if available in the test account, targets its corresponding workflow conversation rather than the diagnostic conversation and returns its response to the webapp.
17. Choose **Create fresh selected chat** for one workflow. Confirm it creates/binds a fresh Project chat automatically, only that slot changes, and Automatic Send remains exactly as it was; existing JobHuntAI dispatch records remain unchanged.
18. Disable Automatic Send and revoke the device. Confirm future dispatches stop and the status reports the revocation.

## v2 recovery and concurrency acceptance

1. Start two harmless diagnostic or workflow dispatches for two different bound conversations. Confirm navigation and Send happen one tab at a time, while both conversations can generate concurrently and both requests reach `completed`.
2. Start a third request while both generations are active. Confirm it remains queued and is claimed when capacity becomes available.
3. During a queued or composer-ready request, stop/reload the extension service worker. Confirm the persisted dispatch record resumes the same request without typing twice.
4. Stop/reload the extension worker immediately after the server authorizes Send but before the local phase is persisted. Confirm recovery first reconciles the server `send_attempted` state, uses the stored turn anchor, and never prepares or sends the instruction again.
5. Reload ChatGPT immediately after the Send click. Confirm the exact user turn is recovered and the server advances from `send_attempted` to `sent`; no duplicate user message appears.
6. Make the completion RPC fail temporarily after ChatGPT has answered. Confirm the extension retains a `result_pending` local record, retries the same response hash, and completes the server request without another ChatGPT message.
6a. Make local cleanup fail after the server has accepted a captured result. Confirm both extension startup/popup refresh and the next poll use only `get_dispatch_v2`, even if ChatGPT UI or workflow setup gates normal queue polling; it clears the local warning only when the exact request is already `completed`, preserves the captured result otherwise, and never sends or uploads the ChatGPT message during reconciliation. Confirm malformed/missing delivery-attempt identity fails closed and retains the local capture.
7. Trigger a ChatGPT rate-limit or already-generating condition before Send. Confirm the v2 request is deferred with bounded backoff and no user message is added.
8. Retry an expired request that never reached the Send boundary. Confirm its bounded expiry is renewed and the v2 worker can claim it. Confirm an expired or legacy request with ambiguous delivery is rejected for manual review.
9. For an ambiguous Memory delivery, choose the explicit completed-response check after the original request is stopped. Confirm the recovery ticket uses the original pre-send turn anchor and captures only the assistant response after that exact user turn; if the anchor is unavailable, the webapp presents manual review and does not queue a ticket.
10. Trigger the completed-response check twice for the same source request. Confirm both calls return the same response-check dispatch id and only one queued/active ticket exists.
11. For an eligible V3 task on `/jobs`, force one `CHECK_DISPATCH_RESPONSE` transport-channel failure after content readiness. Confirm the extension re-establishes the reader and retries only `CHECK_DISPATCH_RESPONSE`, captures only the assistant/artifact response matching the frozen pre-send anchor, leaves `/jobs` selected with ChatGPT inactive, and never emits `START_DISPATCH` or clicks Send. The original user turn must appear exactly once.
12. Repeat with the response reader unavailable through all attempts. Confirm there are at most three read-only checks, no composer mutation or ChatGPT send occurs, the task becomes clearly actionable with `response_check_unavailable`, and the UI states that no message was sent or resent.
13. Leave a sent diagnostic request untouched until its response deadline and allow the overall request expiry to pass. Confirm the next v2 poll reconciles it to `user_required` with `response_capture_timeout`, preserves the exact turn anchor, and exposes the manual/recovery action instead of leaving the request in `sent`.
14. In a persistent Professional background conversation containing an older `professional-profile.json`, reset onboarding and submit a new CV/source set. Confirm the bridge waits for settled history, captures only the assistant turn after the new user message, waits for generation to finish, and imports the new JSON; an older artifact must never populate the fields.
15. Force the v3 completion RPC or its migration to be unavailable while a response is captured. Confirm the extension does not download the artifact, stops automatic retries after the bounded compatibility failure, and leaves the captured response marked for manual recovery. Restore the matching free-tier Edge Function and database migration; confirm the parked response is uploaded once without another ChatGPT message and the artifact is downloaded at most once.
16. Reset onboarding while a sent/result-pending Memory dispatch exists. Confirm the reset marks that request cancelled, the visible ChatGPT conversation remains unchanged, and the extension clears its local recovery record on its next poll.

Repeat the recovery checks with one condition at a time: two consecutive messages in one chat, two parallel messages in separate workflow chats, identical consecutive prompt text, ChatGPT answering before delivery acknowledgement, a forced service-worker stop at each send boundary, ChatGPT-tab reload or closure during generation, a temporary backend/network failure after answer capture, Chrome minimization or machine sleep, and a visible ChatGPT rate-limit response. Every request must finish in a terminal or explicitly actionable state by its fixed deadline; no condition may create an automatic duplicate Send or strand later eligible work.

## Rollout telemetry gate

After the harmless v2 acceptance requests complete, run `node scripts/verify-chatgpt-bridge-rollout.mjs --live --require-v2-completions` with the paired v2 device credentials. Record the JSON output with the release evidence. The gate must report zero expired active leases, over-renewed leases, orphaned `send_attempted` rows, lost result uploads, missing response-upload metadata, and unsafe bridge audit events. A non-zero pending-result count is acceptable only inside the response deadline and must clear on the next poll. Record the reported active v1-device count and keep v1 compatibility enabled until every non-revoked paired device advertises v2 and the clean result remains stable through the observation window.

## Automated point 8 gate

Run the repository gate after every bridge change:

```text
npm run chatgpt-bridge:verify
```

The gate builds the unpacked extension, runs its unit suite (including mixed ChatGPT turn markers, document ordering, nested-node deduplication, identical prompts, streaming and transient responses, artifacts, safe-stop ambiguity, persisted recovery boundaries, and serialized storage writes), runs extension and web typechecks, runs the extension verifier, runs the shared web poller tests, and runs the repository and rollout static verifiers. The web poller tests exercise valid JSON HTTP 500 responses, retry scheduling, shared subscribers, component unmount/remount, terminal result retention, authentication expiry, extension completion events, online/focus wakeups, and hidden-tab visibility handling.

Complete the database part against the linked Supabase project with the migration list, security and performance advisors, and a service-role call to `chatgpt_bridge_service_get_rollout_telemetry`. Record those outputs with the release evidence. Review advisor warnings against the documented service-role boundary; do not silently treat a warning as a pass.

## Safe-stop acceptance

Repeat with one condition at a time and confirm no message is sent:

- sign out or show the ChatGPT login screen;
- open a different conversation or different Project;
- leave a permission/CAPTCHA/confirmation dialog visible;
- make the Send control ambiguous or change the UI locale;
- stop/reload the service worker during a diagnostic delivery.

Each case must result in `user_required` or a bounded failure/manual fallback. The extension must not click an unknown control, submit an application, send an email, or automatically resend after uncertain delivery.

## Release evidence

Record the date, Chrome version, ChatGPT UI locale, extension version, web deployment identifier, Edge Function deployment identifier, migration version, diagnostic dispatch id, the rollout telemetry JSON, and screenshots of the settings status. Redact pairing codes, device tokens, OAuth tokens, conversation content, response text, and personal data.

This runbook does not claim that Chrome Web Store review or publication has occurred. Those require a separately authorized store account and review process.
