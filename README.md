# JobHuntAI Console

Private, human-in-the-loop job application workspace.

The system is designed to find and triage roles, prepare evidence-backed application packages, require explicit review before consequential actions, and track outcomes without turning the workflow into a collection of disconnected chats.

## Current master development plan (M00–M12)

This is the active path toward a verified JobHuntAI V1 release, following the master roadmap and current product handover. Work proceeds one orchestrator-approved package at a time. Legacy milestone sections below describe repository history and are not acceptance status for this plan.

### Latest work-package status

- **M00 — ACCEPTED:** baseline, reproducible verification, and Windows GUI validation.
- **M01 — IMPLEMENTED_UNVERIFIED:** diagnostic safety, retry identity, status restoration, focused checks, and native Windows UI validation are complete. Live delivery acceptance is **BLOCKED** because the installed Website Bridge extension was reported as outdated. No live diagnostic was sent and no production data was changed.
- **M02–M12 — NOT_STARTED:** M02 waits for the orchestrator’s next approved work package.

### Roadmap

- **M00:** Governance, baseline, reproducible verification, and GUI readiness.
- **M01:** Website Bridge delivery and recovery.
- **M02:** Onboarding, verified profile, and Memory lifecycle.
- **M03:** Search settings, managed Job Pool mirror, and recurring execution.
- **M04:** Combined URL extraction, initial Memory-fit, and robust job analysis.
- **M05:** Job Pool UX and explicit “Choose to apply”.
- **M06:** CV families, eight paired themes, and visual document quality.
- **M07:** Explicit document generation, artifact recovery, and Google Drive.
- **M08:** Application review, screening answers, and approval integrity.
- **M09:** Employer ATS helper, exact final review, and no-submit acceptance.
- **M10:** Gmail, tracking, Dashboard, and later-stage preparation.
- **M11:** Reliability, multi-user isolation, security, and performance hardening.
- **M12:** Complete user-perspective acceptance, deployed-state verification, and release.

Critical path: M00 → M01; M01 enables M02–M04; M03 + M04 → M05 → M06; M01 + M05 + M06 → M07 → M08 → M09; M05 + M08 → M10; M02–M10 → M11 → M12.

### Acceptance and testing notes

UI acceptance requires real visible interaction and readback. Native Win32 mouse, keyboard, and scroll input is acceptable; browser-only, headless, or simulated events do not prove the GUI works. Live Bridge tests require visible Testing Mode and a harmless no-Memory-change instruction. The isolated local UI runner intentionally has no production Supabase credentials, so its configuration warning is expected; do not copy production secrets into the test profile.

M01 acceptance requires two consecutive harmless Testing Mode dispatches with exact-turn capture, the JobHuntAI app remaining in front, and recovery without resending the ChatGPT turn. Verify the deployed app revision, backend compatibility, and installed extension before claiming live acceptance. This README records status; it does not authorize unassigned work or external actions.

## Existing implementation inventory

The following list summarizes code present in the repository; it does not imply that the corresponding M00–M12 acceptance criteria have passed.

- frozen V1 product specification
- PostgreSQL/Supabase schema and guarded application state machine
- child-table owner RLS policies
- strict AI JSON contracts
- applicant knowledge-base bootstrap and extraction pipeline
- validated live tracker snapshot + normalisation
- repository data layer with local/Supabase modes
- Next.js application shell with real dashboard/application/assessment views
- evidence-backed Profile screen with searchable atomic evidence
- four CV-family document view
- deterministic evidence-backed CV tailoring engine
- immutable CV document versions with evidence-link provenance
- LaTeX/PDF CV rendering and private Supabase Storage
- CV review/version UI and private PDF download route
- Supabase SSR + Google OAuth scaffolding
- invite-only membership gate with owner, admin and member roles
- development data seeding script
- ownership-safe historical import staging and claim RPC
- 26-record historical tracker migration with data-quality audit
- automatic owner-history claim after the intended bootstrap owner signs in
- health endpoint
- environment/deployment skeleton
- repository verification script
- manual vacancy ingestion and preserved advert snapshots
- deterministic requirement extraction and evidence matching
- separate Fit and Priority scoring
- automatic CV-family recommendation with motorsport-only guard
- Auto-prepare / Recommend / Maybe / Reject triage
- job deduplication and versioned analysis persistence
- transactional Job → Application creation
- automatic application bootstrap for eligible Auto-prepare jobs
- frozen vacancy/analysis context per Application
- locked application strategy and CV-family selection
- ChatGPT interaction through a paired Chrome MV3 Website Bridge only
- guided activation flow with automatic PDF, DOCX, TXT, Markdown and RTF extraction
- private source-document diagnostics and amber extraction-proposal review/materialization
- complete per-user job-search strategy, CV-family and automation-preference capture
- activation-ready checklist for Gmail, ChatGPT and browser-helper connections
- idempotent preparation task queue
- Application preparation workspace
- Ready for Review centre with selected-version package pinning
- editable/approvable Amber and Red screening answers
- salary approval and cover-letter include/remove decision
- database-enforced Approval Gate 1
- post-Gate-1 content freeze
- Gmail read-only monitoring with deterministic event classification, Application matching, and encrypted refresh-token storage in Supabase Vault
- high-confidence confirmation/rejection/assessment/interview pipeline updates
- contextual Needs You review for ambiguous/unmatched recruiting mail
- versioned assessment and interview preparation workspaces
- immutable submitted-application context schema for later-stage recall
- practice-only assessment preparation guard at engine, RPC and table levels
- ChatGPT Plus handoff prompts for synthetic assessment practice and mock interviews
- website-agnostic adaptive form planner and local Playwright Core browser companion
- scoped Supabase Edge bridge for browser observations/plans
- database-enforced Approval Gate 2 and immutable exact submitted-context locking
- one-time paired macOS browser helper with Keychain-backed device credentials
- per-user LaunchAgent auto-start, loopback health status and persistent JobHuntAI Chrome profile
- automatic device pickup of approved employer-form sessions without per-application token copying
- separate Chrome MV3 ChatGPT Plus website bridge with no OpenAI API key requirement
- versioned opaque dispatch protocol for URL inspection, search, analysis, document drafts, email/tracker actions and diagnostics
- one-time hashed bridge pairing, exact JobHuntAI Project conversation binding, opt-in Automatic Send and revocation
- server-authoritative dispatch state machine, exact-turn response provenance, idempotency, leases, retry limits and RLS deny policies
- semantic ChatGPT UI adapter with fixtures, fail-closed modal/login/locale handling and manual fallback
- web-based Resume helper control for background MFA/CAPTCHA/user-required pauses
- invite-only multi-user tenancy with database-enforced membership acceptance and revocation
- administrator Members screen with member/admin invitations
- per-user applicant onboarding with education, employment, skills, projects and publications
- private CV source-document storage partitioned by authenticated user
- deterministic CV extraction proposals with source provenance and explicit factual review
- per-user CV families, reusable screening answers, salary/location/work-mode preferences and readiness gating
- active-membership-bound Gmail credential access and sync isolation
- Settings → Google Sheets keeps the active Job Pool and Applications together in one managed workbook; Supabase remains authoritative and hashes detect out-of-band edits before an Applications refresh
- ChatGPT job searches use the verified Job Pool tab and manifest from that same workbook; Google access for JobHuntAI is distinct from ChatGPT’s own Google Drive connection
- browser-helper device/session binding with service-only pairing and authentication RPCs
- private automation helper privilege closure so authenticated users cannot supply arbitrary user IDs
- immediate helper/session credential invalidation when a membership is revoked

Not connected yet:

- real external job-board crawling and employer-site adapters

The adaptive browser agent and paired-helper commissioning flow are implemented. Real commissioning still requires running the one-time pairing/install commands on the user's Mac and then exercising the helper against real external ATS pages in no-submit mode.

## First production deployment

For the first hosted Cloudflare deployment on macOS, use the guided script rather than configuring Wrangler by hand:

```bash
chmod +x deploy-first-time-mac.sh
./deploy-first-time-mac.sh
```

It installs dependencies, validates production configuration, builds OpenNext, checks the Workers Free compressed-size limit, opens Cloudflare authentication if required, deploys with runtime values, and verifies `/api/health`. See `DEPLOY_NOW.md`.

## Local test

```bash
npm run milestone:15
npm install
npm run dev
```

Open `http://localhost:3000`.

Without Supabase configuration the app runs in **Validated local snapshot** mode.

## Live Supabase test

For local Supabase-backed development, configure an authorized `.env.local` and sign in with an active membership. Without Supabase credentials, isolated local UI runs show the expected configuration warning. Do not copy production secrets into test profiles. Verify current deployed migrations, functions, and source revision from operational evidence rather than relying on historical README statements.

Set `JOBHUNT_DATA_MODE=supabase` to require live database reads.

See `docs/MILESTONE_10.md` for adaptive form-agent, local browser companion and Approval Gate 2 rules.

See `docs/CHATGPT_BRIDGE.md` for the ChatGPT Plus bridge protocol, pairing, permissions, threat model and deployment boundary. Build and verify the extension with `npm run chatgpt-bridge:verify`; its production zip must be built with `JOB_HUNT_ORIGIN` set to the exact hosted origin. Run the harmless live checklist in `docs/CHATGPT_BRIDGE_ACCEPTANCE.md` only with a test account and no applicant data.

## Repository layout

```text
apps/web/                 Next.js application
packages/contracts/       AI and domain contracts
packages/knowledge/       applicant evidence ingestion/bootstrap
packages/job-intelligence/ zero-cost deterministic job analysis
packages/application-preparation/ Application bootstrap planning
packages/cv-engine/       evidence-backed CV selection, audit and LaTeX rendering
packages/review-center/    deterministic Gate 1 checklist logic
packages/progression-prep/ assessment/interview preparation engine
packages/form-agent/       website-agnostic deterministic form planner
apps/browser-agent/        local Playwright Core dedicated-Chrome companion
supabase/functions/        separate browser-helper and ChatGPT bridge Edge Functions
apps/chatgpt-bridge-extension/ Chrome MV3 visible ChatGPT website bridge
database/migrations/      PostgreSQL schema and RLS
data/knowledge/           verified evidence and source snapshots
data/imports/             tracker migration snapshots
docs/                     product and implementation specifications
scripts/                  verification, normalisation and seed utilities
```

## Safety invariants

- adaptive form automation is website-agnostic and must re-read each page
- no direct transition from content review to submitted
- external submission requires the explicit `approved_for_submission` state
- submitted document content is immutable
- material generated CV claims require evidence provenance
- uncertain or sensitive answers are never promoted to reusable candidate facts automatically
- live assessment questions are never accepted as preparation inputs or answered/submitted by the app
- progression preparation versions are append-only and carry an explicit context-quality label
- form-agent tables have no direct authenticated write path; the local helper uses a scoped short-lived bridge token
- final employer-form submission cannot be recorded without an exact Final Review observation
- the generic application-state RPC cannot bypass form states or `submitted`

## Milestone 9

Milestone 9 adds the progression-preparation layer:

- combined assessment/interview action centre
- versioned preparation workspaces
- `exact_submitted` / `approved_pre_submission` / `best_available` context quality
- immutable `application_submission_contexts` foundation for Milestone 10
- assessment invitation/rule recap, deadline urgency, readiness checklist and synthetic practice plan
- interview submitted-application recap, strongest evidence, weak areas, likely questions and questions to ask
- ChatGPT Plus handoff prompts without separately billed API usage
- database-level practice-only and append-only enforcement

Run `npm run milestone:9` for the complete regression suite.


## Milestone 10

Milestone 10 adds the website-agnostic employer-form layer:

- local Playwright Core companion attached to a persistent dedicated JobHuntAI Chrome profile over CDP
- generic DOM/accessibility observation and strict page-plan contract
- one safe action per observation followed by mandatory re-observation
- approved Gate 1 package mapping for verified fields, salary and documents
- sensitive/user-only field redaction and pause behaviour
- CAPTCHA, MFA, authentication and uncertainty pauses
- scoped 8-hour form-agent session token and Supabase Edge bridge
- exact Final Review snapshot and database-enforced Approval Gate 2
- helper-submit and manual-submit paths that both lock the same immutable submitted context
- generic application-state transitions cannot jump to form states or `submitted`

Run `npm run milestone:10` for the complete standalone regression suite.


## Milestone 11

Milestone 11 productionises the console for Cloudflare Workers/OpenNext, keeps Supabase as the persistent backend, replaces Next 16 `proxy.ts` with Cloudflare-compatible Edge `middleware.ts`, and adds a hard no-submit ATS acceptance mode. See `docs/MILESTONE_11.md`, `docs/PRODUCTION_RUNBOOK.md`, and `docs/ATS_ACCEPTANCE.md`.


## Milestone 12 — Production deployment

The production target is Cloudflare Workers/OpenNext on a free `workers.dev` hostname with the existing Supabase Free backend. `npm run production:deploy` now validates the production environment before any deploy, and `/api/health` verifies the hosted Worker can actually reach Supabase. Google/Gmail OAuth activation remains Milestone 13.


## Milestone 13 — Google Auth + live-data cutover

Milestone 13 adds the commissioning checkpoint that verifies the intended owner login claims the staged 26-application history, 7 verified facts, 18 evidence items and assessment record, while confirming the Gmail read-only refresh credential is encrypted in Supabase Vault. The software path is complete; real OAuth commissioning still requires the production hostname.

## Milestone 14 — Local browser helper commissioning

Milestone 14 removes the normal per-application Terminal handoff. The Mac is paired once from **Settings → Browser helper**; the long-lived device credential is stored in macOS Keychain, a per-user LaunchAgent starts the helper at login, and approved form sessions are picked up automatically. The helper keeps the dedicated JobHuntAI Chrome profile local and continues to stop at Gate 2. Run `npm run helper:verify` for the commissioning contract checks. See `docs/MILESTONE_14.md`.


## Milestone 15 — Real ATS acceptance and V1 launch qualification

Milestone 15 adds source-backed provider-diverse Chromium acceptance, fixes generic start/submission/radio/locator behaviour discovered by those tests, and makes live launch qualification persistent. Acceptance sessions are hard no-submit at the database level and successful live runs restore the Application to Content Approved. **Settings → Launch qualification** stays Not launched until hosted production, Google/Gmail cutover, the paired Mac helper and the genuine live ATS matrix all pass. See `docs/MILESTONE_15.md` and `docs/ATS_ACCEPTANCE.md`.


## Milestone 18

Milestone 18 hardens the automation layer for real multi-user operation. Gmail credentials, browser helpers, form sessions and application approvals are tied to the authenticated member. Private automation helpers that accept a user ID are no longer directly callable by authenticated clients. Paired sessions require both the form-session credential and the owning device credential, and membership revocation immediately revokes helper credentials and active sessions while preserving the member's private data.

## Retired ChatGPT app integration (historical milestones 19–24)

The original M19–M24 implementation used a user-created ChatGPT app/plugin and OAuth/MCP routes. That integration has been retired: the routes and UI are removed, old setup bookmarks redirect to bridge settings, and existing plugin access tokens are revoked by migration `0108_bridge_bulk_job_url_imports.sql`. The historical SQL migrations remain in the repository and are not the current ChatGPT execution path. All current ChatGPT tasks are sent through the Website Bridge described below.

Run `npm run milestone:18` for the source regression suite. A genuine two-user acceptance run is still required before the milestone can be declared operationally complete.

## Milestone 20 — Guided activation

Milestone 20 makes a fresh invited member self-serve: upload a PDF, DOCX, TXT, Markdown or RTF CV, let the Worker extract it privately, review every Amber proposal, answer direct personal questions, configure the complete job-search strategy, and connect Gmail, ChatGPT and the browser helper from one activation workspace. The database refuses activation completion while proposals remain unreviewed or required setup is missing.

Run `npm run milestone:20` for the M19 regression suite plus M20 onboarding/extraction contracts. See `docs/MILESTONE_20.md`.

## Milestone 21 — Recurring job discovery

M21 adds an auditable per-user search-run layer. Each run has an explicit trigger, bounded source list, cadence-derived next-run time, counters and state. New jobs and analyses are linked back to the active run. Supported search setup and manual searches now travel as ordinary Website Bridge dispatches; no recurring ChatGPT Task or plugin connection is used.

Run `npm run milestone:21` for the complete M21 source contract suite. External crawling remains bounded to the connected ChatGPT Task and does not introduce hidden server scheduling.

## Milestone 22 — Automatic application preparation

M22 describes the historical token-bound ChatGPT preparation path. Current preparation remains owned by the JobHuntAI application workflow and its existing review gates; retired plugin dispatch is not available.

Run `npm run milestone:22` for the complete M22 source contract suite. Generated CV/content documents still require the normal review workflow and user approval.

## Milestone 23 — Browser-helper reasoning loop

M23 describes the historical ChatGPT plugin browser-helper reasoning loop. It is not a current ChatGPT communication route; the website extension/form helper remains separately scoped, and its approvals/gates are unchanged.

Run `npm run milestone:23` for the complete M23 source contract suite. Gate 2 and final employer submission remain unchanged.

## Milestone 24 — Reliability and operations

M24's token-bound MCP reliability loop is historical. The current Website Bridge has its own bounded delivery/recovery path; captured answers are retried for upload without resending their original ChatGPT messages. The two-user production isolation run remains a separate human acceptance action.

Run `npm run milestone:24` for the complete M24 source contract suite. See `docs/TWO_USER_ACCEPTANCE_RUNBOOK.md` for the exact remaining human checks.

## Milestone 28 — ChatGPT Plus website bridge

M28 adds the generic opaque dispatch queue and a separately scoped Chrome MV3 Website Bridge. All JobHuntAI buttons create idempotent server requests; the extension routes each workflow to its own verified `JobHuntAI` Project conversation and sends a plain-language, action-owned task exactly once. It captures only that user message's assistant turn and preserves v3 completion/provenance. ChatGPT runs in an inactive tab while the webapp stays selected. The extension retries captured-result uploads without resending the original prompt. It fails closed on login, CAPTCHA, permissions, wrong conversations, ambiguous controls and uncertain delivery. Device credentials are revocable, and document actions remain `needs_review` drafts before all existing human gates.

Run `npm run milestone:28` for the complete source contract suite. Production migration/function deployment and harmless live acceptance are deliberately separate release actions; see `docs/CHATGPT_BRIDGE_ACCEPTANCE.md`.
