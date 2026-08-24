# Milestone 6 - Application content package

## Delivered

Milestone 6 completes the non-CV preparation layer for an Application:

```text
Application
  -> salary context
  -> cover-letter usefulness decision
  -> evidence-backed cover-letter draft when useful
  -> standard screening-answer package
  -> Green / Amber / Red trust classification
  -> unresolved user-only fields surfaced
  -> preparation queue updated
```

## Zero-extra-cost default

The first-pass engine is `deterministic_v1`. It does not call a separately billed OpenAI API.

The deterministic outputs are preparation aids, not final approvals. ChatGPT Plus remains the preferred revision surface for more natural role-specific prose. Any revised cover letter is stored as a new document version.

## Salary context

Salary is always explicit about provenance:

- `advertised`: employer supplied a salary or range
- `estimated`: no salary was advertised, so the system creates a clearly labelled range from role family, location and visible seniority signals

The salary recommendation is always `proposed`/Amber until the user approves it.

## Screening answer trust policy

The database enum maps to the UI as:

- `verified` = Green
- `proposed` = Amber
- `user_required` = Red

Green answers must point to a verified `candidate_facts` record. Amber answers may be generated from the locked application context but require user review. Red answers remain blank and may not be inferred.

Legal/work-authorisation, security-clearance and other user-only fields are Red unless explicitly present as verified facts.

## Cover letters

A cover letter is generated only when the job analysis classifies its value as `high` or `medium`. Low-value or unsupported cover letters remain skipped.

Material cover-letter paragraphs carry verified evidence IDs. The persistent write path rejects:

- non-empty `unsupported_claims`
- material paragraphs with no evidence
- unverified/foreign evidence IDs
- incomplete `document_evidence_links` manifests

The rendered PDF is stored in the existing private `application-documents` bucket and previous versions are retained.

## Persistent contract

`public.save_application_content_package()` writes salary context, the milestone screening package and the optional cover-letter document version in one RLS-bound operation. It is `SECURITY INVOKER`.

The operation also updates the preparation queue:

- `research_salary` -> completed
- `prepare_cover_letter` -> completed when a letter is required/generated
- `prepare_screening_answers` -> completed or `needs_user` when required Red answers remain

`assemble_review_package` remains pending until Milestone 7.

## Not yet part of Milestone 6

- user editing/accepting individual Amber answers
- user entry for Red answers
- salary approval control
- cover-letter approval/regeneration controls
- Ready for Review assembly
- Approval Gate 1 transition

Those are the focus of Milestone 7.
