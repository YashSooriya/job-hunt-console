# Job Hunt Console V1 Product Specification

Status: **Frozen for initial implementation; operational contract through Milestone 24**
Date: 2026-08-23

## 1. Product objective

Job Hunt Console reduces the user's job-application workload to decisions that genuinely require human judgement. It should prepare high-quality applications, preserve factual provenance, and track outcomes while enforcing explicit review before consequential external actions.

The normal daily experience should answer three questions:

1. What needs the user's attention?
2. Which jobs should be applied to next?
3. What has changed in existing applications?

The system is not intended to become another general job board or a generic chat interface.

## 2. V1 boundaries

### Included in V1

- persistent private dashboard
- job records and full listing snapshots
- job triage and scoring
- separate Fit Score and Priority Score
- automatic application preparation for qualifying jobs
- application strategy generation
- automatic base-CV-family selection
- evidence-backed tailored CV content
- cover-letter usefulness decision and generation
- salary recommendation
- screening-question preparation
- Green / Amber / Red answer trust classification
- human content-review gate
- immutable document versioning
- manual submission recording
- current Google Sheet tracker import and one-way mirror support
- Gmail read-only monitoring and application-status classification
- assessment and interview records
- application timeline and audit log
- contextual ChatGPT interactions in job/application/document views

### Explicitly deferred until after V1 core is stable

- sending email
- mobile-native application
- sophisticated analytics or ML-based outcome prediction
- multi-user support

The database and state model must nevertheless support later form automation without destructive schema changes.

## 3. Core domain distinction

A **Job** is a discovered vacancy. An **Application** exists only after the system or user decides to apply.

Jobs can be:

- `auto_prepare`
- `recommend`
- `maybe`
- `reject`

Applications are persistent workflow objects with documents, answers, approvals, communications, outcomes, and immutable submitted versions.

## 4. Job discovery and capture

When a vacancy enters the system, capture where available:

- employer and canonical company identity
- role title
- employer job/reference ID
- source URL
- application URL
- location
- remote/hybrid expectations
- salary text and normalised range
- currency
- posting date
- closing date
- employment type
- full job-description snapshot
- ATS/provider
- sponsorship/work-authorisation requirements
- security-clearance requirements
- discovery timestamp

A listing snapshot must be retained even if the external page later disappears.

Duplicate jobs should be detected using employer, title, reference ID, canonical URL, and listing similarity. Reposts remain linked rather than silently duplicated.

Milestone 3 implements a deterministic first-pass analysis path so job ingestion and triage remain usable without separately billed AI API calls. It extracts likely requirements from the preserved advert, matches them to verified evidence, and stores an analysis version. ChatGPT is the preferred higher-quality reasoning layer and may later enrich or supersede this first-pass analysis without changing the Job record or losing the original analysis provenance.

## 5. Eligibility gate

Before scoring, evaluate hard requirements that could make an application inappropriate.

Possible result:

- `eligible`
- `eligible_with_concerns`
- `unknown`
- `ineligible`

Hard conflicts are displayed separately from the Fit Score. A low Fit Score must not be used as a substitute for a known eligibility failure.

Unknown legally or professionally significant facts must never be guessed.

## 6. Fit Score

Fit Score answers: **How suitable is the candidate for this role?**

Initial weighting:

| Component | Weight |
|---|---:|
| Technical capability | 30% |
| Strength of evidence | 20% |
| Experience/seniority fit | 15% |
| Domain fit | 15% |
| Role-type fit | 10% |
| Qualifications/education | 10% |

Each component is 0-100. The final Fit Score is stored with component scores and explanatory evidence links.

A deterministic analyser or ChatGPT may propose component scores, but the structured scoring function owns the arithmetic.

## 7. Priority Score

Priority Score answers: **How urgently is this application worth spending effort on compared with other opportunities?**

Initial weighting:

| Component | Weight |
|---|---:|
| Fit | 35% |
| Estimated screening probability | 20% |
| Compensation/value | 15% |
| Geography | 10% |
| Posting freshness | 10% |
| Application effort | 5% |
| Closing-date urgency | 5% |

Priority is not a synonym for fit. A strong but old, underpaid, or high-effort vacancy may rank below a slightly weaker but recent and attractive role.

Posting-age preference for initial implementation:

- 0-7 days: strongly prioritised
- 8-14 days: clearly worthwhile when fit is good
- 15-30 days: selective, considering fit, salary, applicant volume, specialisation and employer-site status
- 30+ days: generally low priority unless unusually strong or niche

## 8. Automatic triage policy

Initial thresholds:

### Auto-prepare

- Fit Score >= 88
- Priority Score >= 80
- no hard eligibility conflict

The system creates an Application and prepares content. It does **not** interact with an external application form in V1.

### Recommend

- Fit Score >= 78
- Priority Score >= 65
- no hard eligibility conflict

### Maybe

Below normal recommendation thresholds, but a meaningful factor justifies keeping it available, such as unusually high salary, niche domain relevance, strategic employer value, or very low application effort.

### Reject

Use where there is poor fit, inappropriate seniority, known eligibility failure, poor value, or clearly weak expected screening probability.

All classifications must retain a reason.

The Motorsport CV may only be selected for explicitly motorsport/F1/racing-related vacancies. For an explicit motorsport vacancy, Motorsport is the default family unless a later user-approved analysis deliberately overrides it.

## 9. Application preparation pipeline

On Application creation:

1. freeze the current job snapshot
2. generate application strategy
3. choose one base CV family
4. identify relevant evidence records
5. generate structured tailored CV content
6. validate all modified claims against evidence
7. determine whether a cover letter has material value
8. generate cover letter if useful
9. research/suggest salary answer where needed
10. prepare screening answers that are visible from the job/application process
11. classify each answer Green, Amber, or Red
12. generate document and answer change audit
13. transition to `ready_for_review` when complete

Failures in one preparation task should not destroy successfully completed work.

## 10. CV family policy

The four base families are:

- `simulation_cae`
- `scientific_software`
- `quantitative_data`
- `motorsport`

Motorsport is used only for explicitly motorsport-related roles.

The model may select, reorder, condense, and rephrase verified evidence. It may not invent experience, tools, dates, responsibilities, metrics, or domain exposure.

CV generation uses:

```text
Evidence records
    -> structured CV content
    -> template renderer
    -> LaTeX
    -> PDF
```

LaTeX is a rendering concern. AI should not directly mutate layout commands during ordinary tailoring.

## 11. Evidence provenance

Every material CV bullet created or substantively modified by AI must reference one or more `evidence_item` IDs.

A CV version is invalid for approval when:

- a material claim has no evidence link
- evidence is marked rejected or unverified and the claim is presented as verified
- the claim contradicts a verified candidate fact

The UI should summarise:

- base CV family
- material changes
- evidence used
- unsupported claims count
- unresolved factual conflicts

Target unsupported claims count is always zero.

## 12. Cover-letter policy

Do not create a cover letter mechanically for every vacancy.

Classify usefulness as:

- `high`
- `medium`
- `low`
- `not_accepted`

Generate automatically for `high`. Generate for `medium` when the employer accepts one or when it provides a credible advantage. Skip `low` unless explicitly requested.

Cover-letter claims follow the same evidence-grounding policy as CV claims.

## 13. Screening-answer trust policy

### Green: `verified`

Known factual data from verified profile records. It can be inserted automatically.

### Amber: `proposed`

AI-generated judgement or role-specific prose, including salary recommendations and motivation/supporting answers. It can be prepared automatically but requires review.

### Red: `user_required`

Information the system must not infer, or a question where the verified profile does not contain an adequate answer. It remains unanswered until the user supplies the answer.

Sensitive voluntary monitoring/disclosure answers are application-scoped and are not promoted into reusable candidate facts automatically.

## 14. Mandatory approval gates

### Gate 1: Content approval

Before a future external form agent may begin, the user must approve the application content package.

The review screen must expose:

- role and strategy summary
- tailored CV and changes
- cover letter if present
- Green answers
- Amber answers
- Red unresolved answers
- salary answer
- unsupported claim count

Gate 1 cannot succeed while required Red answers remain unresolved.

### Gate 2: External form approval

Implemented in Milestone 10. After an external application form is populated, the user must review the actual employer form before submission.

The browser agent is website-agnostic. It must inspect the current live page rather than rely on provider-specific field maps, interpret the controls and questions it actually encounters, and map them to the approved application package. After any navigation, dynamic reveal, validation response, or material DOM/page change, it must re-observe the page before taking further actions. Unknown, ambiguous, sensitive, or user-only questions pause the workflow instead of being guessed.

There is no global automatic-submission mode. `Approve & submit with helper` is explicit, application-specific Gate 2 approval. The helper may click only the final control identified on the exact reviewed form session; if that control/page changes, it stops for re-review.

## 15. Application state machine

Primary states:

```text
discovered
triaged
shortlisted
preparing
ready_for_review
revision_requested
content_approved
form_in_progress
form_needs_user
final_review
approved_for_submission
submitted
awaiting_response
assessment
interview
offer
rejected
withdrawn
expired
```

Not every Job creates an Application. `discovered`, `triaged`, and `shortlisted` are supported on the application model for imported historical records and future workflow uniformity, but normally the Application begins at `preparing` or `ready_for_review` after a Job is promoted.

The database must reject invalid transitions. In particular:

- `ready_for_review -> submitted` is forbidden
- `content_approved -> submitted` is forbidden
- `final_review -> submitted` is forbidden unless `approved_for_submission` occurs first
- terminal states can be reopened only through an explicit audited administrative action

## 16. Document versioning

Documents include:

- CV
- cover letter
- supporting statement
- application-answer package
- job snapshot
- assessment/interview preparation

Document versions are append-only.

Once a version is marked `submitted`, it is immutable. New edits create a new version.

Each generated version stores:

- structured content
- rendered file path/object key
- LaTeX source when applicable
- model identifier
- prompt/template version
- creation timestamp
- change summary
- evidence links
- approval status
- submitted flag

## 17. Dashboard behaviour

Dashboard prioritises action over analytics.

Required sections:

### Needs You

Examples:

- application ready for review
- assessment approaching deadline
- unresolved Red question
- external login needed
- ambiguous Gmail status update

### New strong matches

Recent high-priority jobs that have not yet been actioned.

### Preparing

Applications currently being generated.

### Upcoming

Assessments, interviews, deadlines, and follow-ups.

### Pipeline summary

Compact counts only. Avoid decorative analytics in V1.

## 18. Jobs screen

Primary filters:

- Recommended
- Maybe
- Rejected
- Expired
- All

Each row should expose company, role, location, salary, age, Fit Score, Priority Score, and triage classification.

## 19. Applications screen

Primary filters/stages:

- Preparing
- Ready for review
- Approved
- Form completion
- Submitted
- Awaiting response
- Assessment
- Interview
- Closed

The main Application page contains:

- Overview
- Fit
- CV
- Cover Letter
- Questions
- Form
- Timeline

## 20. Contextual ChatGPT interaction

Do not use a generic floating chatbot as the primary interaction model.

ChatGPT actions inherit the object currently being viewed.

Examples:

- `Ask ChatGPT about this role`
- `Ask ChatGPT about this CV`
- `Ask ChatGPT about this answer`

The runtime context should automatically include the relevant job snapshot, application strategy, current artifact, candidate evidence, and prior revisions.

A global command box may exist for dashboard-level questions.

## 21. Tracker migration

The current Google Sheet named `Job Application Tracker` contains an `Applications` tab and a `Dashboard` tab.

Migration policy:

1. preserve original row values and source row number
2. normalise company, role, dates, status and stage
3. import into PostgreSQL
4. record migration timestamp
5. use PostgreSQL as authoritative after cutover
6. mirror relevant application state back to the Sheet

Direct spreadsheet editing should become secondary after cutover.

## 22. Gmail integration

V1 Gmail scope is read-only.

The system may:

- search messages
- read application-related messages
- classify confirmations, rejections, assessments, interviews, offers and recruiter correspondence
- associate messages with applications
- propose or apply status transitions depending on confidence

It may not send, delete, archive, or label messages in V1.

Low-confidence classifications must create a `Needs You` task instead of automatically changing application state.

Milestone 8 implements this as a deterministic, zero-additional-cost classifier and matcher. Automatic state mutation requires both a high-confidence event classification and a high-confidence Application match. Confirmation may automatically move `submitted` to `awaiting_response`; rejection may move an active post-submission Application to `rejected`; assessment and interview invitations may move the Application to those states and create/link the corresponding workflow record. Offers, recruiter messages, uncertain classifications, unmatched recruiting emails, and ambiguous Application matches always require explicit user review.

Google OAuth requests only `gmail.readonly`. The app never asks for Gmail send, modify, label, archive or delete scopes. Provider access tokens are used server-side and are not written to application tables. A Google refresh token, when issued during consent, is stored encrypted in Supabase Vault and is only retrieved through user-scoped server RPCs so short-lived access tokens can be refreshed. If the refresh credential is unavailable or revoked, Gmail sync becomes `needs_reconnect` rather than falling back to broader credentials.

Each ingested email retains the Gmail message ID and thread ID, classification provenance, match confidence, linked Application, whether a state change was applied, and an audit record. Reprocessing the same Gmail message is idempotent.

## 23. Assessment and interview workflow

Assessment records contain:

- provider
- type
- invitation timestamp
- deadline
- estimated duration if known
- status
- linked email
- preparation notes
- current preparation-version reference

Interview records contain:

- round/type
- scheduled time
- participants when known
- linked communications
- preparation package
- outcome
- current preparation-version reference

Milestone 9 adds versioned preparation workspaces. Every preparation version snapshots the application context used to generate it and is labelled `exact_submitted`, `approved_pre_submission`, or `best_available`. Historical applications must never be falsely presented as exact if their original submitted artefacts were not captured.

`application_submission_contexts` is the immutable canonical source for later-stage preparation once submission recording is implemented. It retains the exact submitted CV version, cover-letter version, screening answers, salary context, job snapshot, job analysis and strategy. A later CV edit therefore cannot change what an assessment/interview workspace says was submitted.

Assessment preparation is explicitly `practice_only`. It may provide:

- invitation/rule recap
- deadline urgency
- likely component hypotheses
- environment/readiness checklist
- synthetic practice plan
- ChatGPT Plus handoff for synthetic practice

It may not ingest, answer, interpret, or submit live assessment questions. Employer/provider instructions requiring independent completion always take precedence.

Interview preparation may provide:

- exact submitted-application recap
- role requirements and strongest supporting evidence
- weak areas/gaps to handle accurately
- likely interview questions
- questions to ask the employer
- salary discussion consistency
- ChatGPT Plus mock-interview handoff

The application retains the exact submitted CV, cover letter and answers for later preparation.

## 24. Failure handling

Automation tasks use:

- `pending`
- `running`
- `completed`
- `retrying`
- `needs_user`
- `failed`

Errors should be converted into user actions whenever possible.

Examples:

- salary uncertainty -> `Needs You: low-confidence salary range`
- ambiguous email -> no state change, create review task
- missing listing -> use stored job snapshot
- document compile failure -> retry without losing structured content

Tasks must be idempotent so retries do not create duplicate applications or document versions.

## 25. Audit trail

Consequential actions create append-only audit events.

Record at least:

- actor type and actor ID
- event type
- entity type and ID
- timestamp
- structured metadata
- model and prompt/template version for AI-generated decisions
- evidence IDs where relevant

Do not store hidden chain-of-thought.

## 26. Security requirements

- Google OAuth only for V1
- production access limited to active invite-only Job Hunt Console memberships
- server-side storage of provider/API secrets
- Supabase Row Level Security on user-owned tables
- no ATS passwords stored
- submitted files private by default
- Gmail read-only initially
- separate development and production environments
- audit sensitive/consequential writes

## 27. V1 acceptance criteria

V1 core is considered usable when all of the following work end-to-end:

1. an invited user signs in with the exact Google account attached to an active membership or pending invitation
2. historical tracker data is visible in the dashboard
3. a new Job can be added with a frozen job-description snapshot
4. the system produces structured fit and priority analyses
5. a qualifying Job can create an Application
6. one of four CV families is selected
7. a tailored CV is generated with evidence links for every material modified claim
8. a cover letter is generated only when policy says it is worthwhile
9. screening answers are separated into Green, Amber, and Red
10. the review page blocks approval when required Red items remain unresolved
11. approval creates an audited state transition
12. final submitted document versions can be recorded and become immutable
13. tracker mirror can update the matching Sheet row
14. Gmail can detect a known confirmation/rejection/assessment/interview message and associate it with the correct Application
15. current application state and upcoming assessment/interview actions appear on the Dashboard

## 28. Non-goals for initial implementation

The system does not guarantee employment outcomes, hide uncertainty, pretend a score is objective truth, or optimise application quantity at the expense of truthful representation.

Its purpose is to make a high-quality, evidence-backed job-search workflow substantially faster while preserving user control.

## 29. Milestone 5 CV engine implementation

The first production CV draft does not require paid model API usage. The deterministic engine uses the selected CV family and vacancy relevance signals to select, condense and reorder already verified CV material.

The resulting structured CV must pass an evidence audit before rendering. Every material profile or bullet claim must have at least one accepted evidence item and `unsupported_claims` must be empty. The database independently re-checks the evidence contract before creating a reviewable CV version.

Every preparation or revision creates a new immutable document version containing structured content, evidence provenance, change summary, LaTeX source and rendered PDF. Rendering is a separate concern from content tailoring.

## 30. Milestone 6 application-content implementation

The first-pass non-CV package remains usable without separately billed model API calls. `deterministic_v1` creates salary context, a cover-letter draft only where the existing cover-letter policy says it has value, and a standard screening-answer package.

Salary estimates must be visibly labelled as estimates when the employer has not advertised compensation. Salary recommendations are Amber until reviewed.

Screening answers use the existing trust policy as an executable contract: `verified` is Green, `proposed` is Amber, and `user_required` is Red. Green answers require a verified candidate fact. Red answers must remain blank and may not be inferred. Work-authorisation and security-clearance questions are Red unless explicitly stored as verified facts.

Material cover-letter prose must retain evidence provenance. A generated cover-letter version cannot persist if it has unsupported material claims, material paragraphs without evidence, unverified evidence, or an incomplete evidence-link manifest.

## 14. Ready for Review and Approval Gate 1

`ready_for_review` is reached only by assembling a complete review package. It is deliberately distinct from `content_approved`: Red/user-only answers may still be unresolved while the package is Ready for Review because resolving those answers is part of review.

The review package must pin the exact CV version and cover-letter version/decision used for approval. Regenerating a document creates a new immutable version and invalidates the earlier review selection until the new version is reviewed.

Approval Gate 1 requires:

- selected CV version accepted and unsupported claim count = 0
- selected cover letter accepted, or an explicit remove/not-required decision
- salary expectation explicitly approved
- all required answers completed
- all Amber generated answers explicitly approved
- all Red user-only answers explicitly supplied and approved
- zero unresolved review checks

The application may then move to `content_approved`. This action must produce an audit event and must not initiate employer-form submission.

## Milestone 14 local browser-helper commissioning

The browser helper is paired once per local device. A paired helper must use a long-lived device credential stored in the operating-system credential store and must not require the user to copy per-application form-session credentials during ordinary use. On macOS the device credential is stored in Keychain and the repository-based helper is started by a per-user LaunchAgent. Form-session credentials remain short-lived, scoped to one Application, and are delivered only to an authenticated paired helper. Background pauses are resumed from the hosted Job Hunt UI after the user resolves the issue in the dedicated Job Hunt Chrome profile. Gate 2 remains mandatory.

## Milestone 15 real ATS acceptance and launch qualification

Provider-specific names may appear in acceptance fixtures and launch-coverage metadata, but the production form observer, planner and executor remain website-agnostic. The helper must continue to re-observe after every action or material page change.

Source-backed replicas are development evidence and never satisfy the live launch gate. Live acceptance sessions are explicit hard no-submit sessions. PostgreSQL must prevent those sessions from entering `approved_for_submission`, `submitting`, or `submitted`, and persisted acceptance evidence must state `submit_clicked=false`.

V1 operational status requires a hosted production runtime, completed owner Google/Gmail cutover, a paired Mac helper, and genuine live final-review acceptance evidence across Greenhouse, Lever, Workday, one additional major ATS family, and a custom employer flow. Until those external commissioning checks pass, the product must display **Not launched** rather than inferring readiness from source tests.


## Milestone 16 invite-only multi-user tenancy

The hosted product is invite-only. Google authentication does not itself grant application access. An authenticated identity must have an active Job Hunt Console membership, and invitation acceptance must run before any applicant profile, Gmail credential or historical bootstrap is attached to that identity. Owner, admin and member privileges are enforced by PostgreSQL.

Every user's applications, CVs, evidence, salary answers, screening answers, Gmail state, assessments, interviews, browser devices, form sessions and document files remain isolated by authenticated-user ownership. The owner's staged historical bootstrap can be claimed only by its intended authenticated email.

## Milestone 17 per-user onboarding and applicant knowledge

A new invited member starts with an empty profile. Onboarding captures personal details, education, employment, skills/tools, projects/publications where applicable, source CVs, reusable screening answers, salary/location/work-mode preferences, work-authorisation facts, job-search preferences and CV-family choices. No owner-specific evidence, CV content, salary preference or screening answer is inherited.

Uploaded CV material is a source, not truth. Deterministic extraction may create proposed facts and evidence, but every extracted item remains `needs_review` until the user verifies or rejects it. Source provenance and source locators are retained. A model or parser may reorder or propose facts for review but must not silently promote extracted claims into reusable verified evidence.

Onboarding readiness is database-enforced and user-specific. The user cannot mark onboarding complete while required applicant areas are missing or extracted facts/evidence remain unresolved.


## Milestone 18 multi-user automation isolation

Gmail, browser-helper and employer-form automation must enforce the same user boundary as applicant data. Gmail refresh credentials are per-user and accessible only to an active membership. Provider message idempotency is scoped by user. Application matching and automatic state changes may affect only applications owned by the same authenticated user.

Browser-helper pairing codes and device credentials are user-specific. The bridge must validate active membership on pairing and every device poll. Device polling must select queued form sessions by both device and user. A form session issued to a paired helper must require the owning device credential in addition to its short-lived session credential.

Private implementation functions that accept an arbitrary user ID must never be executable directly by authenticated clients. Member-facing RPCs derive `auth.uid()` and enforce active membership before invoking private implementations.

Membership revocation immediately invalidates outstanding pairing codes, browser-helper credentials and active form-session credentials. Private applicant data and encrypted Gmail secrets are preserved unless separately deleted. Gate 1 and Gate 2 remain application-scoped and may never become global approvals.

## Milestone 19 ChatGPT background worker

Job Hunt Console remains the primary UI and durable system of record. ChatGPT connects through the authenticated MCP/OAuth boundary and may read only the connected user's context or write bounded, idempotent work/results for that user. The integration has no approval, evidence-promotion or employer-submission capability. Recurring execution uses the supported user-created ChatGPT Task path and is never represented as a hidden server cron.

## Milestone 20 guided activation

A new invited user can upload a PDF, DOCX, TXT, Markdown or RTF CV without pasting document text. The original source is private and parser output is Amber. The user reviews, edits or rejects every extracted fact/claim before it becomes reusable evidence. Direct questions such as work authorisation, sponsorship, salary, notice period and sensitive disclosures remain user supplied.

The activation flow captures the complete per-user search strategy and connects Gmail, ChatGPT and the browser helper. Database readiness includes the review state and connection state; the web checklist is informative, while `complete_candidate_onboarding()` is authoritative. The browser helper remains website-agnostic, re-observes after each action and pauses at human gates.

## Milestone 21 recurring job discovery

Recurring discovery is represented by per-user search sources, search runs and run-job links. A run is created with a bounded source list, a maximum job count and a cadence-derived next-run timestamp. The supported ChatGPT Task calls the authenticated MCP app to ensure a due run, reads bounded search context, searches the enabled external sources, persists jobs and analyses idempotently, and reports completion counters. Search results remain private to the member and are retained for deduplication even when triaged out. No hidden server cron or global search account is introduced.

## Milestone 22 automatic application preparation

When a discovered vacancy has an eligible `auto_prepare` analysis, exceeds the member's fit and priority threshold, has a frozen snapshot and references verified evidence, the connected ChatGPT worker may request automatic preparation. The database creates or reuses a member-owned Application, locks its vacancy/analysis context and queues the normal evidence-backed preparation tasks. The preparation request is idempotent and auditable. It remains `awaiting_content` or otherwise before Approval Gate 1; the system never treats automatic preparation as content approval, form approval or employer submission.

## Milestone 23 browser-helper reasoning loop

When the website-agnostic helper pauses at authentication, MFA, CAPTCHA, a sensitive field or another user-required condition, the service bridge records a bounded private browser-question work item. The connected ChatGPT worker may inspect that question and propose reasoning based on verified context. The proposal is advisory, user-reviewable and never applied to the page or used to resume the session. The user must resolve the employer page and explicitly resume; Gate 2 remains the only path to final submission.

## Milestone 24 reliability and operations

MCP activity is rate-limited per member and bucket, with separate bounded windows for reads, writes, search runs and browser reasoning. Pending work is returned in bounded pages. Expired leased work is reclaimed only for the owning member and is failed after a finite retry cap. The hosted Settings page reports operational counts through a current-user RPC. These controls improve reliability without introducing a hidden server scheduler or changing the human approval gates.
