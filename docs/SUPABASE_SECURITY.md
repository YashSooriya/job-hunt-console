# Supabase security boundary

Point 12 hardens the production Supabase project without changing the
Website Bridge protocol.

The database migration is applied to project `sgarcjiqkvlhldmrlsqo` as remote
migration `20260907194623_supabase_security_hardening`.

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

The thirteen authenticated warnings for the user-facing ChatGPT wrappers are
also intentional: `cancel_chatgpt_dispatch_request`,
`create_chatgpt_bridge_pairing_code`, the three dispatch-create wrappers,
`create_chatgpt_response_check_dispatch`, `get_chatgpt_bridge_status`,
`get_chatgpt_dispatch_lifecycle`, `get_chatgpt_dispatch_request`,
`record_chatgpt_dispatch_lifecycle`,
`resume_professional_background_activation`,
`retry_chatgpt_dispatch_request`, and `revoke_chatgpt_bridge_device`.  These
are the authenticated API boundary for the signed-in Job Hunt Console.  Each
wrapper checks `auth.uid()` and the current user's membership or request
ownership before using its private, security-definer implementation.  They are
not internal service RPCs, so revoking `authenticated` from them would break
the product's user-facing dispatch flow.  The service-RPC audit above remains
separate and has no anonymous or authenticated execution grants.

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

The live verification query must show `relrowsecurity = true`, zero table
privileges for `anon` and `authenticated`, `service_role` execute privileges
for every trusted service RPC, and no client-role execute privilege on those
RPCs.  Re-run the Supabase security advisors after each DDL change.  The
intentional remaining function notices are the anonymous rate-limit wrapper
and the authenticated user-facing wrappers described above.  The
`auth_leaked_password_protection` notice is not accepted: it must disappear
once the project is on a Supabase plan that exposes the setting and it is
enabled.
