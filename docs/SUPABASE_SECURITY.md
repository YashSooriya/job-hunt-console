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

It checks the six RLS tables, exact service-role policies, client table
privileges, every security-definer search path, the full function signature
inventory, public service-RPC grants, the token-bound rate-limit exception,
the ChatGPT internal dispatcher matrix, and private arbitrary-user helpers.
The checked-in inventory and role rationale are in
`database/security/security-definer-allowlist.json`.
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

The post-migration security-advisor snapshot has no table or search-path
warning.  It reports one intentional anonymous rate-limit notice, nineteen
intentional authenticated-wrapper notices, and the single unresolved
`auth_leaked_password_protection` notice while the organization remains on the
Free plan.
