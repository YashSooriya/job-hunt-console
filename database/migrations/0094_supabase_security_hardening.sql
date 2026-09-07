-- Point 12: close the private-table and service-RPC privilege boundary.
--
-- The six tables below contain credentials, membership/invitation state, or
-- bootstrap data.  Client roles must not have table privileges; RLS is kept
-- enabled as defence in depth for any future grant or SECURITY INVOKER path.
-- The service role is the only client-facing role with an explicit policy.

grant usage on schema private to service_role;

revoke all on table
  private.bootstrap_import_batches,
  private.gmail_oauth_credentials,
  private.app_memberships,
  private.app_invitations,
  private.chatgpt_oauth_authorization_codes,
  private.chatgpt_oauth_access_tokens
from public, anon, authenticated;

grant select, insert, update, delete on table
  private.bootstrap_import_batches,
  private.gmail_oauth_credentials,
  private.app_memberships,
  private.app_invitations,
  private.chatgpt_oauth_authorization_codes,
  private.chatgpt_oauth_access_tokens
to service_role;

alter table private.bootstrap_import_batches enable row level security;
alter table private.gmail_oauth_credentials enable row level security;
alter table private.app_memberships enable row level security;
alter table private.app_invitations enable row level security;
alter table private.chatgpt_oauth_authorization_codes enable row level security;
alter table private.chatgpt_oauth_access_tokens enable row level security;

drop policy if exists service_role_only on private.bootstrap_import_batches;
create policy service_role_only on private.bootstrap_import_batches
  for all to service_role using (true) with check (true);

drop policy if exists service_role_only on private.gmail_oauth_credentials;
create policy service_role_only on private.gmail_oauth_credentials
  for all to service_role using (true) with check (true);

drop policy if exists service_role_only on private.app_memberships;
create policy service_role_only on private.app_memberships
  for all to service_role using (true) with check (true);

drop policy if exists service_role_only on private.app_invitations;
create policy service_role_only on private.app_invitations
  for all to service_role using (true) with check (true);

drop policy if exists service_role_only on private.chatgpt_oauth_authorization_codes;
create policy service_role_only on private.chatgpt_oauth_authorization_codes
  for all to service_role using (true) with check (true);

drop policy if exists service_role_only on private.chatgpt_oauth_access_tokens;
create policy service_role_only on private.chatgpt_oauth_access_tokens
  for all to service_role using (true) with check (true);

-- Every public SECURITY DEFINER RPC used by a trusted service is closed to
-- client roles.  Keep this audit pattern-based so all existing overloads are
-- covered in one pass.  The form-agent
-- acceptance recorder is the one service RPC whose name does not contain the
-- conventional `_service_` marker.
do $$
declare
  v_function record;
begin
  for v_function in
    select
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and (
        p.proname like 'chatgpt\_bridge\_service\_%' escape '\'
        or p.proname like 'browser\_agent\_service\_%' escape '\'
        or p.proname like 'form\_agent\_service\_%' escape '\'
        or p.proname = 'record_form_agent_acceptance_result'
      )
  loop
    execute format(
      'revoke execute on function %I.%I(%s) from public, anon, authenticated',
      v_function.schema_name,
      v_function.function_name,
      v_function.identity_arguments
    );
    execute format(
      'grant execute on function %I.%I(%s) to service_role',
      v_function.schema_name,
      v_function.function_name,
      v_function.identity_arguments
    );
  end loop;
end;
$$;

-- The anonymous grant on this one SECURITY DEFINER wrapper is intentional.
-- ChatGPT's OAuth MCP request reaches Postgres as `anon`; the wrapper hashes
-- and validates the raw OAuth token before calling its private implementation.
-- It is not a Website Bridge service RPC and is covered by the token boundary.
revoke execute on function public.chatgpt_consume_rate_limit(text, text, integer, integer)
  from public, authenticated;
grant execute on function public.chatgpt_consume_rate_limit(text, text, integer, integer)
  to anon, service_role;
