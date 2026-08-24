# Milestone 16: Invite-only multi-user tenancy

Milestone 16 replaces the single authorised-email gate with database-enforced invite-only membership.

Roles are owner, admin and member. Invitations are bound to exact Google email addresses and expire after 30 days. A Google session is accepted into the application only after `accept_app_membership` succeeds. Gmail credential storage, candidate-profile creation and historical bootstrap claim occur after that membership check.

The owner historical bootstrap remains bound to its staged intended email. New members receive empty applicant data. Existing per-user RLS and storage ownership boundaries remain authoritative.

The Members administration screen is available only to owner/admin memberships. The owner cannot be revoked through normal administration.
