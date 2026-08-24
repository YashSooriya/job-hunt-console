# Milestone 18: Per-user Gmail, browser-helper and application-automation isolation

Milestone 18 makes the automation layer obey the same user boundary as Milestones 16 and 17.

Gmail refresh credentials remain encrypted and preserved per user, but store/read operations require an active membership. Gmail ingestion continues to deduplicate by `(user_id, provider_message_id)` and can only match/update applications owned by the authenticated user.

Browser-helper pairing, heartbeat and polling are membership-bound. The bridge consumes pairing codes through service-only RPCs, verifies the paired device belongs to an active member on every poll, and filters queued form sessions by both `browser_device_id` and `user_id`.

Paired form sessions are additionally bound to the device credential as well as the rotating session token. A copied session token cannot be used from another member's paired helper. Manual unpaired sessions remain possible only through the explicit fallback path.

Private `*_for_user` automation helpers are no longer directly executable by `authenticated`. Public RPCs are the only member-facing entry points: they derive `auth.uid()`, require active membership, and then call the private implementation under a fixed `search_path`.

Revoking a membership immediately revokes that user's browser devices and outstanding pairing codes, cancels active form sessions, and rotates session token hashes. Applicant data and the encrypted Gmail credential are preserved for audit/re-invitation, but automation access stops immediately.

Gate 1 and Gate 2 remain application-scoped. No M18 path adds global auto-submit approval or weakens the rule that final submission requires the exact reviewed employer form.

## Acceptance

Source and database acceptance require:

- no authenticated role may execute a private automation helper that accepts arbitrary `p_user`;
- Gmail credential access requires an active membership;
- helper pairing and device authentication are service-only and active-membership checked;
- device polling selects sessions by both device and user;
- paired form-agent requests carry both the session credential and device credential;
- membership revocation invalidates helper/session credentials while preserving private applicant data;
- a real two-user acceptance run must confirm each account sees only its own Gmail state, devices, applications, form sessions and approvals.
