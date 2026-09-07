# ChatGPT bridge acceptance runbook

This is the human-only live acceptance checklist. It must be performed with a harmless diagnostic request and a test account/workspace. Do not use a real applicant, job application, employer account, or external communication.

## Preconditions

- Production database migrations through `0095_supabase_security_definer_inventory.sql` are applied.  The bridge migrations through `0093_chatgpt_bridge_lifecycle_first_observation.sql` must be followed by `0094_supabase_security_hardening.sql` and `0095_supabase_security_definer_inventory.sql`; the security verifier and advisor snapshot must pass before live acceptance.
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
8. Click **Send harmless diagnostic** in JobHuntAI Settings.
9. Confirm the extension claims exactly one `bridge.diagnostic` request and the diagnostic conversation receives the action handler’s plain-language diagnostic task. It must not receive an MCP claim/dispatch command, a request ID, or internal JobHuntAI protocol wording.
10. Confirm ChatGPT’s response is captured in the Settings panel and the dispatch reaches `completed` without using an MCP tool. The response capture is limited to the exact assistant turn after the one-time user message in that bound conversation.
11. In the diagnostics lifecycle panel, confirm the extension version and build id are shown and the timestamps appear in order: browser hint, extension receipt, server claim, tab/content/composer readiness, Send boundary, verified user turn, response detection, and response upload. Confirm that the panel contains no task text, pairing code, token, or conversation contents in its lifecycle data.
12. With the extension stopped or disconnected before claim, confirm the page says **Waiting for extension** or **Extension build is outdated**. With ChatGPT still generating after a verified Send, confirm it says **Message sent; waiting for ChatGPT**. After a response is captured but the upload is made to fail, confirm it says **Response captured; retrying upload** and does not offer a resend.
13. Force a pre-Send safe stop and confirm the server reports `retry_allowed`; the page may show **Retry safely**. Force the same test after `send_attempted_at` or `sent_at` is recorded and confirm no retry button appears.
14. Confirm a CV or job-search dispatch, if available in the test account, targets its corresponding workflow conversation rather than the diagnostic conversation and returns its response to the webapp.
15. If the bridge response is deliberately made unavailable, confirm the request stops safely and the optional MCP fallback is shown separately; it is not sent automatically.
16. Choose **Create fresh selected chat** for one workflow. Confirm it creates/binds a fresh Project chat automatically, only that slot changes, and Automatic Send remains exactly as it was; existing JobHuntAI dispatch records remain unchanged.
17. Disable Automatic Send and revoke the device. Confirm future dispatches stop and the status reports the revocation.

## v2 recovery and concurrency acceptance

1. Start two harmless diagnostic or workflow dispatches for two different bound conversations. Confirm navigation and Send happen one tab at a time, while both conversations can generate concurrently and both requests reach `completed`.
2. Start a third request while both generations are active. Confirm it remains queued and is claimed when capacity becomes available.
3. During a queued or composer-ready request, stop/reload the extension service worker. Confirm the persisted dispatch record resumes the same request without typing twice.
4. Stop/reload the extension worker immediately after the server authorizes Send but before the local phase is persisted. Confirm recovery first reconciles the server `send_attempted` state, uses the stored turn anchor, and never prepares or sends the instruction again.
5. Reload ChatGPT immediately after the Send click. Confirm the exact user turn is recovered and the server advances from `send_attempted` to `sent`; no duplicate user message appears.
6. Make the completion RPC fail temporarily after ChatGPT has answered. Confirm the extension retains a `result_pending` local record, retries the same response hash, and completes the server request without another ChatGPT message.
7. Trigger a ChatGPT rate-limit or already-generating condition before Send. Confirm the v2 request is deferred with bounded backoff and no user message is added.
8. Retry an expired request that never reached the Send boundary. Confirm its bounded expiry is renewed and the v2 worker can claim it. Confirm an expired or legacy request with ambiguous delivery is rejected for manual review.
9. For an ambiguous Memory delivery, choose the explicit completed-response check after the original request is stopped. Confirm the recovery ticket uses the original pre-send turn anchor and captures only the assistant response after that exact user turn; if the anchor is unavailable, the webapp presents manual review and does not queue a ticket.
10. Trigger the completed-response check twice for the same source request. Confirm both calls return the same response-check dispatch id and only one queued/active ticket exists.
11. Leave a sent diagnostic request untouched until its response deadline and allow the overall request expiry to pass. Confirm the next v2 poll reconciles it to `user_required` with `response_capture_timeout`, preserves the exact turn anchor, and exposes the manual/recovery action instead of leaving the request in `sent`.

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
