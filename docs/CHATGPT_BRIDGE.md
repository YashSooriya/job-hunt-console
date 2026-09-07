# ChatGPT Plus website bridge

Milestone 28 adds a Chrome Manifest V3 bridge for users who have ChatGPT Plus but no OpenAI API key. The visible ChatGPT website is the primary execution path. The authenticated JobHuntAI MCP app is an explicit recovery path, not part of ordinary bridge messages. It does not call `api.openai.com`, read ChatGPT cookies, intercept network traffic, or reuse the employer-form helper credential.

## Boundary and data flow

```mermaid
flowchart LR
  UI[JobHuntAI web UI] -->|authenticated session| D[(chatgpt_dispatch_requests)]
  D -->|plain-language website instruction| P[JobHuntAI page content script]
  P -->|hint only| E[MV3 service worker]
  E -->|short-lived device credential| B[chatgpt-bridge Edge Function]
  B -->|service-role RPC| D
  E -->|workflow-specific exact URL| C[ChatGPT Project conversations]
  C -->|bounded visible response| E
  E -->|response result| D
  C -.->|user-authorised fallback only| M[JobHuntAI MCP server]
  M -.-> D
```

The page bridge never receives subject references or applicant content. A page action posts only a versioned hint containing `request_id`, `correlation_id`, and a nonce. The extension claims the request through the bridge function, delivers the server-provided plain-language task exactly once, and captures only the next completed assistant response in the bound conversation. The response is bounded and returned to the webapp; it is not a history export, cookie read, or network interception. MCP is used only when the user explicitly chooses the recovery instruction.

The browser-form helper at `supabase/functions/form-agent-bridge` remains a separate boundary. Its sessions, device tokens, permissions, and tables are not used by this bridge.

## Dispatch protocol

The wire schema is versioned independently of the UI adapter:

| Field | Meaning |
| --- | --- |
| `schema_version` | Server protocol version, currently `1.0.0`. |
| `action_type` / `action_version` | Allowlisted action and its contract version. |
| `origin` | `user_click`, `explicit_automation`, or `diagnostic`. |
| `subject_refs` | Small, shape-validated owned UUID references. Never raw applicant content. |
| `idempotency_key` | Unique per user; repeated requests return the original dispatch. |
| `state` | Server-owned delivery/workflow state. |
| `website_instruction` | Plain-language task sent by the primary Website Bridge. It contains no MCP or internal dispatch protocol instructions. |
| `manual_instruction` | Compatibility alias for `website_instruction` used by older extension versions. |
| `mcp_fallback_instruction` | Separate recovery instruction shown only when the user explicitly chooses MCP fallback. |
| `bridge_response` | Bounded assistant response captured from the target conversation. |
| `correlation_id` | Safe cross-system audit correlation identifier. |

Supported actions are `job.inspect_url`, `jobs.search.manual`, `jobs.analyse_selected`, `documents.cv.create`, `documents.cover_letter.create`, `emails.process_now`, `tracker.sync_now`, and `bridge.diagnostic`. Every action has a maximum batch size, required MCP tools, allowed effects, confirmation policy, expected outputs, timeout, and retry policy. Those descriptors govern authorization and the explicit MCP fallback; they do not define the ordinary Website Bridge wording. The relevant action handler supplies the plain-language `website_instruction`, which the bridge delivers without adding JobHuntAI, MCP, request IDs, or other internal protocol language. The database policy is authoritative at runtime.

Delivery states are:

```text
queued -> claimed_by_extension -> opening_chatgpt -> composer_ready -> send_attempted -> sent
                                                                  |
                                             acknowledged_by_mcp -> running -> completed

Any pre-send delivery state may become user_required, failed, expired, or cancelled.
```

`sent` means the extension’s semantic adapter verified the exact outgoing instruction. The bridge then waits for one completed assistant response and records it as `completed`. If that response cannot be captured, the request becomes `user_required`; the user may inspect the chat or explicitly use the separate MCP fallback. MCP completion states remain available for that fallback path.

### Durable delivery v2

Extension `0.2.3` uses the v2 delivery RPCs from migration `0083_chatgpt_bridge_delivery_v2.sql`, with retry and response-check hardening in `0084_chatgpt_bridge_safety_hardening.sql`, boundary reconciliation in `0085_chatgpt_bridge_boundary_reconciliation.sql`, adaptive backoff in `0086_chatgpt_adaptive_concurrency_backoff.sql`, protocol compatibility in `0087_chatgpt_bridge_protocol_v2_compatibility.sql`, capability upgrades in `0088_chatgpt_bridge_capability_upgrade.sql`, and rollout telemetry in `0089_chatgpt_bridge_rollout_telemetry.sql`. A claim receives a unique `delivery_attempt_id`, a two-minute pre-send deadline, and a bounded response deadline. The service limits a device to two active requests and prevents two claims for the same workflow conversation. Navigation, composer mutation, and Send remain serialized because they touch one ChatGPT UI surface; read-only response capture can run concurrently in the two bound workflow chats.

The content scripts carry a build identity as well as the semantic extension version. Each script installs a replaceable controller with an instance id, removes its runtime listeners and timers when replaced, and probes the existing controller before reusing it. The background worker accepts a tab as ready only when its ping reports the current build identity and conversation URL; an older or unresponsive listener is reloaded before delivery. This prevents an extension reload or SPA reinjection from leaving a stale listener beside the current one.

The one-time boundary is explicit: one database transaction authorizes Send and stores the rendered conversation turn anchor, the extension persists that state locally, and only then does the content adapter click the visible Send control. On restart, the extension reconciles the server state before doing any UI work. A lost runtime message or worker restart can inspect the exact outgoing turn and confirm it, but it never types or clicks again after the server fence has been consumed. After a verified send, the response lease is capped by the request deadline; lease heartbeats cannot extend it indefinitely. A visible pre-send rate limit is deferred using a parsed relative retry duration when available, otherwise five minutes, clamped to 30 seconds through 30 minutes; the device runs at one generation until that persisted backoff expires and then restores the two-generation limit. A manually started generation causes a 15-second defer without reducing capacity, and the fifth bounded busy claim becomes `user_required`. A rate limit after Send is treated as an attempted delivery, stops the request for manual review, and is never resent automatically. The popup reports the reduced-capacity window and active generation phases.

Captured responses are written to a local extension outbox before the completion RPC. Upload retries are idempotent by response hash, so a Supabase/network failure after ChatGPT answered cannot cause a second generation. The web UI uses one shared status poller per dispatch id with exponential retry for transient HTTP failures and wakes immediately on bridge acceptance/rejection events. The existing v1 RPCs remain available during rollout so older installed tabs can finish their leases, but an ambiguous legacy delivery is never eligible for automatic retry because it has no durable v2 send marker.

The exact pre-send turn anchor is also recorded in the v2 request before the visible Send click and remains authoritative after any post-send identity refinement. An explicit completed-response check links back to that original request (or reuses its own marker during activation recovery) and copies the anchor into the read-only ticket. If an older request has no durable anchor, the bridge stops the check safely instead of guessing which duplicate prompt a response belongs to. Every v2 poll also reconciles expired delivery and response deadlines, including requests whose overall expiry has already passed, so a sent request cannot remain stranded in `sent` indefinitely.

### Lifecycle diagnostics

Migrations `0090_chatgpt_bridge_lifecycle_diagnostics.sql`,
`0091_chatgpt_bridge_lifecycle_post_send.sql`, and
`0092_chatgpt_bridge_lifecycle_async_writes.sql`, and
`0093_chatgpt_bridge_lifecycle_first_observation.sql` store a separate,
allow-listed lifecycle object on each dispatch. It records the browser hint,
extension receipt, server claim, bound-tab and content-script readiness,
composer readiness, the one-time Send boundary, verified user turn, response
detection, and response upload. The object also carries a bounded recovery
phase. It is deliberately separate from `progress_json`, because delivery
state transitions replace progress at safety fences; it contains no task text,
ChatGPT response, pairing code, device token, lease token, or conversation
content. Repeated hints keep the first timestamp for each stage, so retries
cannot make the sequence appear to run backwards. Lifecycle writes are
serialized per request in the extension and are
detached from the UI operation, so a slow diagnostics request cannot add a
bridge cooldown or delay the one-time Send path.

The diagnostics status route projects only that safe object. It also reports the
paired extension version, build id, and online state. The diagnostics page
distinguishes an unavailable/outdated extension from a slow ChatGPT generation,
and distinguishes a captured response waiting for upload from a transport
failure. A retry button is rendered only when the server's authoritative
`retry_allowed` flag confirms that neither `send_attempted_at` nor `sent_at`
exists; once the Send boundary is crossed the page cannot offer a resend.
Lifecycle timestamps are validated and kept monotonic by the database RPC.

## Pairing and binding

1. In JobHuntAI Settings, create a one-time pairing code. It expires after ten minutes and is stored hashed.
2. Install the locally built extension and enter the Supabase Edge Function URL, code, and a display name.
3. The Edge Function generates a random device token, stores only its hash, and returns the raw token once to the extension. The token is stored in `chrome.storage.local`; it is never put in a page message or log.
4. Ensure ChatGPT is signed in and can create Projects. The primary Website Bridge does not require the MCP app to be selected or mentioned in the conversation. Configure MCP separately only if you want the explicit recovery path. The extension does not open ChatGPT's `+`/app picker or try to select an app during dispatch. It will reuse an exact `JobHuntAI` Project or create it through ChatGPT's visible Projects UI during setup.
5. Choose **Set up JobHuntAI + workflow chats**. The extension first reuses the server-recorded Project conversation bindings from an earlier bridge pairing, then creates one fixed-marker chat only for each genuinely missing workflow through the visible Project UI. The pause between newly created chats is user-configurable in seconds and defaults to 15 seconds. Progress is saved so a safe stop can be resumed without duplicate setup messages.
6. Enable **Automatic Send** only after setup. Enabling it is a separate server-side opt-in and is rejected unless at least one workflow slot is verified.
7. If a conversation becomes too long, select that workflow and choose **Create fresh selected chat**. The extension creates and binds the replacement automatically, disables Automatic Send, and changes only that slot; **Bind/rebind selected chat** remains the manual fallback.

When a newer extension version is paired with a fresh one-time code, the server copies the previous device's verified workflow slots to the new device and transfers still-queued requests. An active previous device's Automatic Send setting is carried over; a revoked previous device restores its chats with Automatic Send off. Existing ChatGPT Projects and chats should therefore be left in place during an extension upgrade. Chats that were never bound to a JobHuntAI bridge device cannot be identified safely by title alone and still require manual binding.

The extension stores one canonical conversation URL per workflow slot. The default slots are `Job inspection`, `Job search`, `Job analysis`, `CV drafting`, `Cover-letter drafting`, `Email processing`, `Tracker sync`, and `Bridge diagnostic`. It does not search conversations, switch accounts, or use a broad content-script selector to choose a conversation. Manual binding remains available for users who prefer to create chats themselves.

Rebinding a slot replaces only its URL, clears its usage timestamps, disables Automatic Send, and leaves the queued/running/completed JobHuntAI dispatch record untouched. A long ChatGPT conversation therefore does not need to be continued: the user can rotate that workflow to a fresh chat while JobHuntAI and the authenticated MCP workflow remain the system of record.

## Visible UI adapter and safe failure

The adapter uses semantic accessibility attributes and visible controls rather than brittle coordinates. It verifies the current URL, Project label, sign-in state, blocking dialogs, composer uniqueness, exact text after insertion, and one enabled Send control. Project setup additionally requires exactly one visible Projects navigation control, existing exact Project entry, or New/Create Project control; it never renames a different Project. It stops for user action when any of these checks is ambiguous, including:

- login, CAPTCHA, MFA, permission, confirmation, or “allow access” dialog;
- wrong account, wrong Project, wrong conversation, or changed URL;
- missing/ambiguous composer or Send control;
- an already-generating response;
- a changed locale or ChatGPT DOM that no longer exposes a safe semantic control;
- a missing or ambiguous assistant response after the one-time delivery message;
- a response that cannot be returned to the webapp before the bounded lease expires.

After a delivery response is lost, the extension records `delivery_uncertain` and never resends automatically. The popup’s explicit retry action first asks the bridge to requeue a verified pre-send request; it renews an expired request for one bounded action timeout, but it cannot requeue a request whose server record crossed the Send boundary. Legacy ambiguous deliveries require manual conversation review.

The MCP fallback is a separate fixed instruction returned by JobHuntAI. It tells ChatGPT to use the account/Project-level connection, claim the request by ID, follow the server workflow, and record completion/failure. It is displayed as an optional recovery action and explicitly forbids application submission, external communications, and external commitments. It is never the normal Website Bridge message. Future action handlers may change their plain-language tasks independently of this fallback protocol.

## MCP fallback workflow

The ChatGPT MCP server exposes generic dispatch tools:

- `claim_dispatch_request`
- `update_dispatch_progress`
- `complete_dispatch_request`
- `fail_dispatch_request`
- `request_dispatch_user_action`
- `save_document_draft`

If the user explicitly chooses MCP fallback, the model must claim the request first. The claim RPC checks the OAuth token hash, expiry, `work:write` scope, active membership, user ownership, request state, and expiry before releasing `subject_refs` and the server-approved workflow. Write tools enforce the same token-bound user and use idempotent database boundaries. A normal Website Bridge dispatch does not require this claim.

Document actions create `needs_review` versions only. CV triggers continue to reject unsupported claims and material bullets without verified evidence. No bridge action approves documents, submits an application, sends an email, or changes a Human Gate.

## Memory and previous knowledge

ChatGPT Memory is controlled by the user in ChatGPT Settings → Personalization. JobHuntAI does not inspect ChatGPT’s private memory and does not try to toggle it. The `candidate_chatgpt_memory` record stores only the user’s confirmation and preference to use previous knowledge; it is not a memory export. The Settings panel displays this distinction.

## Permissions and threat model

The generated manifest requests only `storage`, `tabs`, `alarms`, `scripting`, and `downloads` (the last permission is used only for the bounded professional-profile JSON artifact). Host access is the exact configured JobHuntAI origin plus `https://chatgpt.com/*` and `https://chat.openai.com/*`. It requests no `<all_urls>`, cookies, webRequest, debugger, history, or clipboard permission.

Threat mitigations include:

- pairing codes are one-time, short-lived, and hashed;
- device tokens are random, hashed server-side, revocable, and separate from the employer helper;
- dispatch leases are short-lived, bounded, target-device aware, and attempt limited;
- tables have RLS enabled with explicit deny policies; client table grants are absent;
- service-role functions are callable only by the Edge Function;
- MCP dispatch tools are token-bound and ownership-checked;
- subject references are allowlisted, size-limited, and ownership-checked;
- external job pages are treated as untrusted research content by the MCP workflow;
- only the next bounded assistant response is stored for the user-scoped dispatch; the extension also keeps a short-lived local delivery record and response outbox so a worker restart can retry the same completion; no conversation history, cookies, or credentials are collected;
- audit events record action type, correlation id, subject key names, device, and safe error codes, not prompt bodies or credentials.

## Local development

From the repository root:

```bash
JOB_HUNT_ORIGIN=http://localhost:3000 npm run chatgpt-bridge:build
npm --workspace @jobhunt/chatgpt-bridge-extension run typecheck
npm --workspace @jobhunt/chatgpt-bridge-extension run test
npm run chatgpt-bridge:verify
```

The unpacked extension is `apps/chatgpt-bridge-extension/dist`. Load that directory through Chrome → Extensions → Developer mode → Load unpacked. The distributable zip is generated alongside it. A build with no environment overrides targets the production JobHuntAI origin and bridge endpoint below; set `JOB_HUNT_ORIGIN` and `JOB_HUNT_BRIDGE_ENDPOINT` explicitly for local or alternate environments.

For the deployed JobHuntAI Console, build the production-targeted bundle with the exact application origin and bridge endpoint. The endpoint is injected into the popup and granted as the extension's narrowly scoped bridge host permission:

```bash
JOB_HUNT_ORIGIN=https://job-hunt-console.yashwanth-sooriya.workers.dev \
JOB_HUNT_BRIDGE_ENDPOINT=https://sgarcjiqkvlhldmrlsqo.supabase.co/functions/v1/chatgpt-bridge \
npm run chatgpt-bridge:build
```

The Edge Function is `supabase/functions/chatgpt-bridge`. Its only secret is the Supabase service-role key supplied by the Supabase runtime. The extension never receives that key.

## Reproducible release evidence

The extension version is declared once, in
`apps/chatgpt-bridge-extension/package.json`. The build injects that value
into the browser bundles, options page, and generated Manifest V3 file. It
also gives every browser bundle one build id derived from the source commit;
`JOB_HUNT_BUILD_ID` may be supplied when reproducing a recorded artifact.
The ZIP entry order and timestamps are fixed, so the same source commit and
build id produce the same SHA-256.

Migration `0081_chatgpt_bridge_delivery_timing.sql` is the canonical 0081
entry. The previously proposed rate-limit repair was intentionally renumbered
to `0082_chatgpt_rate_limit_dispatcher_grant_repair.sql`; the old duplicate
0081 filename must not be restored. The release verifier checks this mapping
and rejects duplicate numeric migration prefixes.

Release evidence is recorded in
`docs/releases/chatgpt-bridge-v<version>.json`. It names the clean source
commit that produced the artifact, extension version, build id, ZIP SHA-256, Cloudflare
deployment, Supabase Edge Function version, and applied migration head. To
rebuild and check the exact recorded ZIP:

```bash
JOB_HUNT_BUILD_ID=<build-id-from-release-evidence> npm run chatgpt-bridge:build
npm run chatgpt-bridge:release-verify -- --artifact
```

The ordinary bridge gate remains useful for a clean checkout as it rebuilds
the current commit, runs extension and web tests/type-checks, and checks the
static migration and rollout invariants:

```bash
npm ci
npm run chatgpt-bridge:verify
```

For a production release, apply the migration and deploy the function with an authenticated Supabase CLI session (the exact project ref is intentionally not committed):

```bash
npx supabase link --project-ref "$SUPABASE_PROJECT_REF"
npx supabase db push
npx supabase functions deploy chatgpt-bridge --no-verify-jwt
```

The Cloudflare Worker deployment still requires the repository’s production environment contract and existing runtime secrets. Run `npm run production:deploy` only after `SUPABASE_SERVICE_ROLE_KEY` and the required Google/Cloudflare credentials are available. The bridge migration/function must be live before enabling the new Settings panel for users.

## Operations

### Rollout telemetry and v1 retirement

After the v2 acceptance runbook has completed, run the repository verifier against a paired v2 device. The verifier authenticates with that device's short-lived bridge credential and calls the read-only `get_rollout_telemetry` operation. The response contains only counts, timestamps, bounded request/device ids, states, error-free timing values, response hashes/length metadata, and capability versions; it never contains a website instruction or captured response.

```bash
CHATGPT_BRIDGE_ENDPOINT=https://sgarcjiqkvlhldmrlsqo.supabase.co/functions/v1/chatgpt-bridge \
CHATGPT_BRIDGE_DEVICE_ID=<paired-device-id> \
CHATGPT_BRIDGE_DEVICE_TOKEN=<paired-device-token> \
node scripts/verify-chatgpt-bridge-rollout.mjs --live --require-v2-completions
```

The rollout is healthy only when `expired_active_leases`, `overrenewed_leases`, `orphaned_send_attempted`, `lost_result_uploads`, `completed_v2_missing_upload_metadata`, and `unsafe_bridge_events_in_window` are all zero. A non-zero `pending_result_uploads` is expected only while a response remains inside its bounded response deadline; investigate it if the count remains after the next poll or appears in `lost_result_uploads`. The verifier also reports active paired v1 devices. Keep the v1 RPCs and fallback path enabled while that count is non-zero; retire v1 only after every non-revoked paired device advertises the complete v2 capability set and the clean telemetry result has remained stable through the observation window. Revoke stale devices explicitly before treating them as upgraded.

Run the static gate in CI or before a deployment even when live credentials are unavailable:

```bash
npm run chatgpt-bridge:verify-rollout
```

The telemetry query and audit guard are service-role-only. They are not exposed through the Supabase Data API, and the audit guard rejects bridge event metadata containing instruction or response-text keys.

- Revoke a device in JobHuntAI Settings to disable Automatic Send, invalidate future calls, stop pre-delivery requests, remove every server-recorded workflow conversation binding, and reset the extension's local bridge state. The external ChatGPT Project and its conversations are intentionally not deleted; pairing and automatic setup must be run again.
- If a conversation is renamed, moved, or deleted, bind a new dedicated conversation. Binding and rotation preserve the Automatic Send setting; disable it first only when you want to pause delivery.
- If ChatGPT changes its semantic controls, update `src/content/ui-adapter.ts`, add a fixture, add a regression test, and rebuild the zip. Do not broaden selectors to “make it work.”
- To remove local credentials, revoke the device server-side and remove the extension from Chrome. To remove server records, use the existing account/data deletion workflow after revocation; the bridge tables cascade from the user.
- There is no claim of Chrome Web Store publication in this repository. Store listing, review, signing, and live human acceptance remain release tasks requiring the account owner.
