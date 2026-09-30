# Supabase security boundary

Point 12 hardens the production Supabase project without changing the
Website Bridge protocol.

The database migrations are applied to project `sgarcjiqkvlhldmrlsqo` as remote
migrations `20260907194623_supabase_security_hardening` and
`20260907202018_supabase_security_definer_inventory`.
The checked-in follow-up is `database/migrations/0095_supabase_security_definer_inventory.sql`.

## Private tables

Migration `0094_supabase_security_hardening.sql` enables RLS on these six
tables and adds a `service_role`-only `FOR ALL` policy to each:

- `private.bootstrap_import_batches`
- `private.gmail_oauth_credentials`
- `private.app_memberships`
- `private.app_invitations`
- `private.chatgpt_oauth_authorization_codes`
- `private.chatgpt_oauth_access_tokens`

`public`, `anon`, and `authenticated` have no table privileges.  Existing
authenticated user flows continue through their narrow, ownership-checking
security-definer wrappers; they do not receive direct table access.

The follow-up migration also pins the four ownership predicates to an empty
`search_path` and removes their inherited `PUBLIC` execution.  Private helpers
that accept an arbitrary `p_user` or use a `_for_user` implementation suffix
are closed to client roles.  Their public wrappers now run as fixed-path
security-definer boundaries after deriving `auth.uid()`.  This keeps the
authenticated API intact while preventing direct private-helper execution.

## Service RPCs

The migration audits every public function named with the service-RPC
conventions (`chatgpt_bridge_service_*`, `browser_agent_service_*`, and
`form_agent_service_*`) plus `record_form_agent_acceptance_result`.  Each is
explicitly executable by `service_role` only.  The user-facing authenticated
wrappers remain authenticated because they enforce the current-user ownership
checks before calling the private implementation.

`public.chatgpt_consume_rate_limit(...)` intentionally remains executable by
`anon` and `service_role`.  The public MCP endpoint arrives with the anon DB
role and supplies a raw OAuth token; the security-definer wrapper hashes and
validates that token before touching per-user state.  Supabase's advisor
warning for this function is therefore an accepted, documented exception.

The nineteen authenticated warnings for user-facing wrappers are also
intentional: the thirteen ChatGPT dispatch wrappers listed above, plus
`get_automation_settings`, `start_job_url_inspection`,
`set_job_url_inspection_response`, `mark_job_url_inspection_failed`,
`complete_job_url_inspection`, and `revoke_app_member`.  These are the
authenticated API boundary for the signed-in Job Hunt Console.  Each wrapper
uses a fixed empty `search_path`, derives the current user (or enforces the
administrator actor check), and calls a private implementation that is no
longer client-executable.  They are not internal service RPCs, so revoking
`authenticated` from them would break the product's user-facing flow.  The
service-RPC audit above remains separate and has no anonymous or authenticated
execution grants.

Migration `20260928163223_job_search_scheduler_and_run_finalization` adds two
authenticated, current-user-checked search wrappers:
`save_job_search_preferences` and `finalize_job_search_run`. Supabase's advisor
reports these as additional intentional function warnings, bringing the total
at that point to one anonymous and twenty-one authenticated warnings. These
job-search schedule and run-finalization wrappers are separately enumerated.
Their grant matrix is narrower than the older wrappers: `service_role` is
deliberately not granted execute, and the live SQL verifier checks that
boundary explicitly.

Migration `20260928203946_member_administration_and_account_deletion` adds the
authenticated `manage_app_member` wrapper. It enforces the owner/admin action
matrix in the database and intentionally grants neither `anon` nor
`service_role` execution. The owner-only Edge Function performs permanent
deletion with a user JWT for the authorization checks and a server-only
service-role client for Storage cleanup and `auth.admin.deleteUser()`. It
removes objects from the two app-owned private buckets before deleting the
Auth user and removes the associated Gmail Vault secret. If a step fails, the
account remains revoked and the delete action can be retried.

The same migration makes revocation immediate even while an issued JWT has not
expired: current-user RLS predicates gate the user-owned REST rows and both
private Storage buckets on active membership plus the token email claim. It
also pauses scheduled job searches on revoke and keeps them paused on restore.
The RLS-only private membership predicate is zero-argument, returns only the
calling user's active status, and is callable by `authenticated` but not
`anon` or `service_role`. These changes added one accepted authenticated advisor
notice, bringing the expected total at that point to one anonymous and twenty-two
authenticated warnings. The new member-administration grant matrix is checked
separately from the legacy authenticated wrappers.

Migration `20260928220906_chatgpt_operation_lock_and_captured_import_recovery`
adds `private.chatgpt_user_operation_locks` with RLS enabled, no `anon` or
`authenticated` table privileges, and explicit `service_role`-only DML. Its
authenticated callers go through the public `SECURITY INVOKER`
`manage_chatgpt_user_operation` and
`retry_captured_job_url_inspection` wrappers; neither public wrapper grants
execution to `anon` or `service_role`. The current-user private helpers derive
their identity only from `auth.uid()`. The lock uses a per-user transaction
advisory lock for atomic claims and remains active through every dispatch in
an ordered group. Captured-result recovery reopens only a failed listing import
with the known JSON-parse error and a linked, completed v3 dispatch with stored
response provenance; it then reuses the existing completion RPC and never
resends the original ChatGPT message. This is additive and leaves migration
`0101_chatgpt_bridge_v3_security_boundary` unchanged.

Migration `20260928235427_diagnostics_chatgpt_action_lock_override`
(`0115_diagnostics_chatgpt_action_lock_override.sql`) adds a default-off,
owner-scoped Diagnostics switch for overlapping ChatGPT actions. The existing
authenticated `SECURITY INVOKER` operation wrapper remains the only client
entry point; its private helper serializes setting changes with new claims,
tracks each operation independently, and refuses to restore the normal lock
while any operation is still active. The setting grants no direct client
update permission on `job_search_controls`, and the live verifier checks its
default, grants, and the per-operation lock key.

Migration `20260929105033_job_pool_google_sheet_mirror` adds a revisioned,
owner-scoped, read-only-by-convention Google Sheets projection of the active job
pool. Supabase remains authoritative and the separate application-tracker
workbook is not read or written. RLS protects the sync state, immutable
publications, and exact search-run snapshots; `service_role` has no direct table
privileges. Authenticated sync RPCs derive `auth.uid()` and commit only a
lease-bound, read-back-verified publication. A fixed-path database trigger
increments each user's source revision when exported job or canonical company
data changes.

Manual searches synchronize and verify the exact Sheet contents before bridge
dispatch; captured search imports must prove the immutable publication id,
revision, manifest token, and complete active-row count. Scheduled searches
require a fresh, lease-bound Google Drive file-version check. A changed file,
stale database revision, unavailable Google credential, or failed preflight
holds the search until a verified sync or reconnection. A one-minute Cloudflare
Cron calls the custom-authenticated Supabase `job-pool-scheduler` Edge Function.
The scheduler functions are service-role-only, while Cloudflare holds only the
separate shared scheduler secret (never the Supabase service-role key). The
follow-up migration `20260929141153_job_pool_scheduler_vault_secret`
(`0118_job_pool_scheduler_vault_secret.sql`) provides a fixed-path,
service-role-only accessor for a value stored in Supabase Vault; the Edge Function
uses the value only to authenticate the Cloudflare request and never returns it.
Migration `0117_job_pool_google_sheet_mirror` adds two intentional authenticated
advisor notices for the owner-only sync wrappers, bringing the accepted total
at that point to one anonymous and twenty-four authenticated warnings. Its
historical evidence is recorded in
`docs/evidence/supabase-security-2026-09-29.json`.

Migration `20260930130839_job_fit_v3_trusted_worker_integrity` adds
append-only frozen-input, exact-turn capture, result, and evidence-reference
ledgers for V3 fit assessments. Active owners can read only their own rows;
clients and `service_role` have no direct write privileges on V3 task or ledger
tables. Scheduler RPCs are `SECURITY INVOKER` wrappers granted only to
`service_role`; private worker functions are service-only or closed to every
API role. The only automatic fit recovery is one database-confirmed V2 retry
while that exact generic Bridge dispatch is provably still before Send. The
migration preserves capture cleanup on account/dispatch deletion, while
rejecting direct edits to immutable rows. It leaves migration
`0101_chatgpt_bridge_v3_security_boundary`, the Bridge completion/provenance
contract, and every job-pool row unchanged.

The forward migration
`20260930133954_20260930133553_job_fit_v3_worker_membership_claims`
repairs the trusted worker's user-scoped calls into the existing authenticated
batch-creation and result-persistence RPCs. Those RPCs require both the user ID
and the active membership email; a service JWT does not carry that user's email.
The service-only worker wrappers now derive the email from the active private
membership row and set a transaction-local claim context before invoking those
same RPCs. No database role switch, table grant, public wrapper grant, or
Bridge protocol change was added. Current live evidence is recorded in
`docs/evidence/supabase-security-2026-09-30.json`.

Forward-only migration `0132_job_fit_v3_exact_turn_recovery` adds a single
owner-checked, authenticated `SECURITY INVOKER` recovery endpoint. It creates
only the existing generic `jobs.analyse_selected` Bridge dispatch with
`response_check_only=true`, reuses the frozen pre-Send turn anchor, and caps
recovery in its original version at one check. It never rewrites the original
dispatch or sends its instruction again. A closed trigger guard rejects
captures whose assistant or artifact identity was already present before Send.
The private user-scoped helper is separately inventoried; service-role table
permissions and the `0101_chatgpt_bridge_v3_security_boundary` wrappers remain
unchanged.
Follow-up `20260930163617_job_fit_v3_capture_guard_hardening`
(`0133_job_fit_v3_capture_guard_hardening.sql`) bounds malformed optional
artifact-key arrays without weakening or disabling that guard.

Forward-only migration `0134_job_fit_v3_rate_limited_exact_turn_recovery`
extends that same exact-turn reader to at most four checks per saved dispatch,
with a database-enforced 15-second cooldown and row-lock serialization. It
persists the original dispatch attempt and last-check time so a failed reader
can be retried after the cooldown without confusing its ticket with the
original user message. Every ticket uses the generic Bridge response-check
path and the original immutable turn anchor; none can invoke Send. Its public
RPC remains authenticated-only and `SECURITY INVOKER`, while no `service_role`
table permission or protected Bridge boundary is widened.

The current advisor snapshot contains one intentional anonymous rate-limit
warning and twenty-five intentional authenticated user-facing wrapper
warnings. The additional legacy `create_job_analysis_batch` warning is
owner-checked and is separately enumerated in the advisor allowlist. The only
unresolved advisor finding is the project-level leaked-password protection
setting, which remains unavailable on this project's current plan. Current
live evidence is recorded in `docs/evidence/supabase-security-2026-09-30.json`.

## Auth password protection

Leaked-password protection must be enabled in the Supabase Dashboard under
**Authentication → Providers → Email → Password protection**.  Supabase
checks new and changed passwords against the Have I Been Pwned password corpus.
The setting is an Auth project setting rather than a database migration, so
its live state is recorded separately from the database migration.  The live
project is currently on Supabase's Free plan; the dashboard disables saving
this Pro-only setting.  Enabling it therefore requires upgrading the
organization to Pro (currently shown as $25/month) and then turning on the
switch.  No billing change was made automatically.

## Verification

Run the local contract verifier:

```sh
npm run supabase:security:verify
```

The repository also contains the read-only live SQL verifier at
`database/security/verify_supabase_security.sql`.  Run it through `psql` with
`ON_ERROR_STOP=1` (or the Supabase SQL editor) against the intended project:

```sh
SUPABASE_DB_URL='postgresql://…' npm run supabase:security:verify:live
```

It checks the seven private RLS tables plus the three owner-scoped Job Pool
Sheet tables, their exact table-role grants, every security-definer search path,
the full function signature inventory, public service-RPC grants, the
token-bound rate-limit exception, the ChatGPT internal dispatcher matrix, and
private arbitrary-user helpers.
The checked-in inventory and role rationale are in
`database/security/security-definer-allowlist.json`; its private-schema
inventory includes the ten V3 append-only and worker implementation helpers.
The accepted and required-absent advisor notices are recorded in
`database/security/security-advisor-allowlist.json`; any new warning requires
review rather than being silently treated as a pass.

The live verification query must show `relrowsecurity = true`, zero table
privileges for `anon` and `authenticated`, `service_role` execute privileges
for every trusted service RPC, and no client-role execute privilege on those
RPCs.  Re-run the Supabase security advisors after each DDL change.  The
intentional remaining function notices are the anonymous rate-limit wrapper
and the authenticated user-facing wrappers described above.  The
`auth_leaked_password_protection` notice is not accepted: it must disappear
once the project is on a Supabase plan that exposes the setting and it is
enabled.

The original post-hardening snapshot remains preserved at
`docs/evidence/supabase-security-2026-09-07.json`. The latest snapshot reports one
intentional anonymous rate-limit notice, twenty-five intentional authenticated
wrapper notices, and the unresolved `auth_leaked_password_protection` notice.
