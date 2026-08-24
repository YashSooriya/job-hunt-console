# Milestone 7: Ready for Review and Approval Gate 1

Milestone 7 turns prepared application content into a decision surface rather than allowing preparation to flow directly into form completion.

## Ready for Review

`ready_for_review` means the complete package exists and is ready for user decisions. It does not imply that every Red/user-only question has already been answered.

The review package records the exact selected CV version, cover-letter version/decision, assembly timestamp and eventual Gate 1 approval timestamp.

A package may enter Ready for Review when:

- a rendered CV version exists with zero unsupported claims
- the cover-letter preparation decision is complete
- when a letter is required, a rendered version exists
- salary context exists
- the screening-answer package exists, even if Red answers still require user input
- the `assemble_review_package` task can complete

## Review controls

The application workspace supports:

- accept or reject the selected CV version
- regenerate CV/letter as a new version without overwriting prior versions
- accept the selected cover letter
- explicitly remove a cover letter from the package
- edit and approve the salary expectation
- review/edit and approve Amber answers
- supply and approve Red answers
- leave Green answers sourced from verified facts unchanged

A regenerated document automatically becomes the current review candidate and invalidates prior package approval.

## Gate 1 invariants

`content_approved` is allowed only when all of these conditions are true:

1. the review package is assembled
2. the selected CV version is `approved`
3. the selected cover letter is `approved`, or the letter is explicitly `remove`/`not_required`
4. salary expectation has an approval timestamp
5. every required answer is non-blank
6. every Amber/`proposed` answer has an approval timestamp
7. every Red/`user_required` answer is explicitly supplied and approved by the user
8. the review-package task is complete

The generic state-transition RPC may not enter either `ready_for_review` or `content_approved`. Those states are reserved for the validating review RPCs.

Gate 1 approval does not submit an application. The next state is form completion.
