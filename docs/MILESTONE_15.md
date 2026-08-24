# Milestone 15: Real ATS acceptance and V1 launch qualification

Milestone 15 separates **browser-engine evidence** from **operational launch evidence**.

## Source-backed browser acceptance

The repository contains a provider-diverse acceptance corpus under `data/acceptance/`. Provider names and URLs are metadata for tests only. They are not inputs to the production observer, planner, or executor.

Current corpus:

- Greenhouse: current Scale AI form labels mirrored into a local fixture
- Lever: current Mytos form labels mirrored into a local fixture
- Workday: current Vanderlande application entry point plus downstream provider-pattern fixture
- Ashby: current Arthur application entry point plus downstream provider-pattern fixture
- SmartRecruiters: current Wise posting plus downstream provider-pattern fixture
- custom dynamic form proving material DOM re-observation

`npm run acceptance:verify` verifies the corpus and checks that provider names have not leaked into production planning logic. `npm run acceptance:browser-smoke` uses a real Chromium browser when Python Playwright and Chromium are available. It fills only synthetic fixture data and asserts that the fixture Submit hook is never clicked.

The browser fixture suite is useful engineering evidence, but it **does not count as a live ATS acceptance run**.

## Generic defects fixed by acceptance

The acceptance work found and corrected generic issues rather than adding provider-specific branches:

1. generic `Apply` / `I'm interested` controls are start-application controls, not final submission controls
2. a visible Submit button on a one-page form does not trigger Gate 2 while safe approved fields still remain
3. exact user-supplied Red answers approved at Gate 1 may be inserted, but never inferred
4. radio groups select only the option matching the approved answer
5. text cover-letter fields can use the exact approved cover-letter text
6. button labels use the button's own accessible text rather than surrounding container text
7. multi-step navigation uses visible/semantic locators rather than a mixed-DOM positional index

Every executed action still requires a fresh observation before another action.

## Live acceptance mode

A paired Mac helper can start a dedicated `acceptance_mode` form session. Acceptance mode is hard no-submit:

- the helper receives `--no-submit`
- the database blocks an acceptance session from entering `approved_for_submission`, `submitting`, or `submitted`
- a successful run is recorded only after the exact employer final-review state exists
- `ats_acceptance_runs.submit_clicked` is constrained to `false`
- after recording a successful acceptance run, the Application is restored to `content_approved`

A real live run therefore proves that the helper can reach final review without changing the Application into a submitted application.

## V1 launch gate

`get_v1_launch_status()` and **Settings → Launch qualification** keep launch status explicit.

V1 is not operational until all of these are true:

1. hosted production runtime is online in Supabase data mode
2. authorised Google sign-in has claimed the staged data and a Gmail refresh credential exists
3. the Mac browser helper is paired
4. a genuine live Greenhouse no-submit run reaches final review
5. a genuine live Lever no-submit run reaches final review
6. a genuine live Workday no-submit run reaches final review
7. a genuine live Ashby, SmartRecruiters, or SuccessFactors no-submit run reaches final review
8. a genuine live custom-employer application reaches final review

The source-backed fixture suite cannot satisfy these live provider checks.

## Current commissioning state

The Milestone 15 software can be complete while V1 remains **Not launched**. In the current development environment, public ATS pages cannot be driven by Chromium because outbound DNS is unavailable, the Cloudflare production Worker is not yet deployed, Google OAuth has not been commissioned against a production hostname, and the helper has not been installed on the user's actual Mac.
