# Milestone 10: Adaptive application form agent

## Goal

Complete employer application forms in the user's authenticated browser without requiring a dedicated implementation for Workday, Greenhouse, Lever, SmartRecruiters, Ashby, or any other application platform.

The system should behave like a careful human operator: inspect the current page, understand what it asks for, map each field to the already-approved application package, fill what is safe, detect validation/dynamic changes, and re-read the page before continuing.

## Core architecture

```text
Approved application package
        +
Verified candidate profile
        +
Current browser observation
        |
        v
Adaptive page interpreter
        |
        v
Validated FormAgentPagePlan
        |
        v
Deterministic browser executor
        |
        v
Re-observe current page
        |
        +----> unresolved/ambiguous? -> Needs You
        |
        +----> more application pages -> repeat
        |
        +----> employer review page -> Final Review, STOP
```

## Website independence

The primary mechanism must not select a workflow based on the detected ATS/provider. The agent must be capable of handling an unseen application website using the page itself as the source of truth.

Provider detection may be recorded as metadata. Provider-specific heuristics may exist later as optional optimisations, but disabling every provider-specific heuristic must not make the core agent unusable.

## Observation hierarchy

1. DOM and accessibility tree
2. visible labels, descriptions, required markers, validation messages, and control relationships
3. current entered values and page state
4. visual/computer-use interpretation when structured browser data is insufficient

After navigation, validation changes, modal/dialog changes, or dynamic question revelation, the page must be observed again before further actions are planned.

## Supported field classes

- text and textarea
- number and salary
- select
- searchable combobox/autocomplete
- radio groups
- checkboxes
- date controls
- tags/skills controls
- file uploads
- repeated employment/education sections
- dynamically revealed questions
- multi-page forms
- CV-parsed forms requiring correction

## Trust and approval

The browser agent reuses the existing trust system:

- `verified`: may be filled automatically
- `proposed`: may be filled only when the exact answer/application package was already approved at Gate 1; new proposed answers pause for review
- `user_required`: never inferred, always pauses

Authentication, MFA and CAPTCHAs pause for the user.

## Submission boundary

The executor may navigate through ordinary `Continue`, `Next`, `Save`, or equivalent application steps when the page plan marks them safe.

When a final submission action or employer review page is detected:

1. stop browser execution
2. persist the final observed form state
3. move the application to `final_review`
4. show the user the completed external form plus a structured diff from the approved package
5. require explicit application-specific approval
6. only then allow `approved_for_submission -> submitted`

The model is not allowed to bypass this boundary based on button text or inferred intent.

## Contract

The page interpreter output must validate against:

`packages/contracts/schemas/form-agent-plan.schema.json`

The browser executor accepts validated plan actions only. Free-form model text is never executable browser control input.

## Test strategy

Milestone 10 must be tested against a mixed corpus of application sites rather than one provider. Acceptance testing should include:

- at least one Workday form
- at least one Greenhouse/Lever/Ashby-style form
- at least one employer-specific/custom application form
- a multi-page form with dynamically revealed questions
- a form with CV parsing that needs corrections
- a form containing an unexpected user-required declaration

A provider-specific failure must not be fixed solely by creating a hard-coded end-to-end adapter unless the generic observation/planning layer cannot reasonably represent the interaction.

## Exit criteria

Milestone 10 is complete when the agent can enter an unseen supported employer application website, populate the form from an approved application package, pause correctly on unknowns, recover from ordinary validation/dynamic form changes, and stop at final review without a provider-specific workflow definition.

## Implemented architecture

Milestone 10 uses a local Playwright Core companion connected to a user-controlled dedicated Job Hunt Chrome profile over CDP. It does not require a paid OpenAI API. The deterministic generic planner handles obvious verified/approved mappings and produces the same strict page-plan contract that a future ChatGPT-assisted plan can use.

A short-lived 256-bit session token links the local helper to one persistent Supabase form session. Only the token hash is stored. The public Edge Function bridge exposes only that scoped session and persists sanitized page observations, plans, action results, pauses and the final-review diff.

The helper executes one action per observation cycle. This intentionally trades a little speed for safety and adaptability: any select, toggle, text entry, upload, Continue/Next navigation, validation reaction or dynamic reveal is followed by a fresh page observation before planning again.

## Gate 2 implementation

Final submission is not a normal browser action. When the generic planner detects the final submission control, the helper stops and the Application moves to `final_review`. The web workspace shows Gate 2 status and the structured final diff. The user may either:

- **Approve & submit with helper**: the exact session becomes `approved_for_submission`; the waiting helper re-observes the live page and clicks only the reviewed submission control. If it no longer matches, submission is refused.
- **I submitted it myself**: the user confirms manual submission from the same Final Review session.

Both paths create the immutable `application_submission_contexts` record and lock the exact submitted CV/cover-letter versions. The generic state-transition RPC cannot bypass Gate 2 to reach form states or `submitted`.

## Local helper command

The application workspace creates a short-lived command of the form:

```text
npm run browser:agent -- --session <session-id> --token <scoped-token> --supabase <project-url>
```

Modern Chrome requires remote debugging to use a non-default user-data directory. Launch the persistent Job Hunt Chrome profile first with:

```text
npm run browser:chrome
```

This uses `~/.job-hunt/chrome-profile` by default and exposes the DevTools endpoint at `http://127.0.0.1:9222`. Employer/ATS logins persist in this dedicated profile, while Job Hunt stores no ATS passwords. Authentication/MFA/CAPTCHA remain under direct user control in that Chrome session.
