# Two-user production acceptance runbook

Status: **TWO-USER ACCEPTANCE PENDING**

This result is intentionally not fabricated. Do not fabricate a pass from source checks. It requires a second real Google account and a real local browser-helper device. The source, database and hosted smoke checks can pass without claiming cross-user acceptance.

## Setup

1. Owner signs in at `/members`, invites a second real test account, and records the invitation email.
2. If Google OAuth is External/Testing, add that Google account to the OAuth test-user list as well as Job Hunt Console.
3. The second user accepts the invite and signs in. Record both account identities without exchanging private applicant data.
4. Pair a browser helper separately for each account. Do not copy device tokens between accounts.

## Required checks

- **Membership and data isolation:** the second account starts with no owner applications, facts, evidence, Gmail state or helper state; each user sees only their own records; manually requesting another user's Application ID fails.
- **Gmail:** each account connects only its own Gmail; messages and refresh credentials do not cross accounts.
- **Browser helper:** each account pairs/revokes only its own device; device polling and active sessions remain user/device bound.
- **Applications and approvals:** each account sees only its own applications; Gate 1 and Gate 2 are application-specific; no test clicks the final employer Submit button.
- **Form sessions:** start a no-submit session for each account, verify mismatched session/device credentials fail, and verify polling does not return the other account's queued session.
- **Reasoning loop:** pause each helper at a user-required condition, confirm only that account's ChatGPT question context appears, accept/reject a proposal, and confirm acceptance does not resume the helper until the user clicks Resume.
- **Revocation:** revoke the second membership; protected routes stop working, its devices/codes/sessions are invalidated, and its applicant data remains preserved. Reinvite/reactivate and confirm access returns only to the preserved second-user data.

## Evidence to record

Record timestamps, account labels, application/session IDs, expected result and observed result for every check. Do not paste bearer tokens, refresh tokens, private CV text or Gmail message bodies into the acceptance report.

Until all checks are executed by a real second user, the correct final status is:

`TWO-USER ACCEPTANCE PENDING`
