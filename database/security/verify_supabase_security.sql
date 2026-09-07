-- Read-only production qualification for the Point 12 Supabase boundary.
-- Run with ON_ERROR_STOP=1.  Any drift raises an exception.
-- The inventory is checked against database/security/security-definer-allowlist.json.

do $$
declare
  v_table text;
  v_schema record;
  v_inventory record;
  v_chatgpt_internal_token text[] := array[
    'claim_dispatch_request', 'complete_dispatch_request',
    'fail_dispatch_request', 'request_dispatch_user_action',
    'save_document_draft', 'update_dispatch_progress'
  ];
  v_chatgpt_internal_closed text[] := array[
    'classify_email', 'configure_tracker_sheet', 'consume_rate_limit',
    'ensure_search_run', 'exchange_authorization_code',
    'fail_job_url_inspection', 'get_application_preparation_status',
    'get_application_tracker', 'get_automation_settings',
    'get_browser_question_context', 'get_detailed_candidate_profile',
    'get_pending_email_classifications', 'get_pending_job_url_inspections',
    'get_pending_work_context', 'get_search_context', 'mcp_call',
    'prepare_application', 'propose_browser_reasoning',
    'record_tracker_sheet_sync', 'recover_stale_work', 'refresh_access_token',
    'revoke_token', 'save_job_url_inspection'
  ];
  v_public_authenticated text[] := array[
    'cancel_chatgpt_dispatch_request', 'complete_job_url_inspection',
    'create_chatgpt_bridge_pairing_code', 'create_chatgpt_dispatch_request',
    'create_chatgpt_dispatch_request_with_dependencies',
    'create_chatgpt_dispatch_request_with_website_instruction',
    'create_chatgpt_response_check_dispatch', 'get_automation_settings',
    'get_chatgpt_bridge_status', 'get_chatgpt_dispatch_lifecycle',
    'get_chatgpt_dispatch_request', 'mark_job_url_inspection_failed',
    'record_chatgpt_dispatch_lifecycle',
    'resume_professional_background_activation', 'revoke_app_member',
    'revoke_chatgpt_bridge_device', 'retry_chatgpt_dispatch_request',
    'set_job_url_inspection_response', 'start_job_url_inspection'
  ];
begin
  -- The credential and membership tables are service-role-only and retain RLS.
  foreach v_table in array array[
    'bootstrap_import_batches', 'gmail_oauth_credentials', 'app_memberships',
    'app_invitations', 'chatgpt_oauth_authorization_codes',
    'chatgpt_oauth_access_tokens'
  ] loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relname = v_table
        and c.relkind = 'r' and c.relrowsecurity
    ) then
      raise exception 'RLS is not enabled on private.%', v_table;
    end if;
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'private' and p.tablename = v_table
        and p.policyname = 'service_role_only'
        and p.roles = array['service_role']::name[]
        and p.cmd = 'ALL' and p.qual = 'true' and p.with_check = 'true'
    ) then
      raise exception 'The service_role_only policy is missing or changed on private.%', v_table;
    end if;
    if has_table_privilege('anon', format('private.%I', v_table), 'SELECT')
       or has_table_privilege('anon', format('private.%I', v_table), 'INSERT')
       or has_table_privilege('anon', format('private.%I', v_table), 'UPDATE')
       or has_table_privilege('anon', format('private.%I', v_table), 'DELETE')
       or has_table_privilege('authenticated', format('private.%I', v_table), 'SELECT')
       or has_table_privilege('authenticated', format('private.%I', v_table), 'INSERT')
       or has_table_privilege('authenticated', format('private.%I', v_table), 'UPDATE')
       or has_table_privilege('authenticated', format('private.%I', v_table), 'DELETE') then
      raise exception 'A client role has a direct privilege on private.%', v_table;
    end if;
    if not (
      has_table_privilege('service_role', format('private.%I', v_table), 'SELECT')
      and has_table_privilege('service_role', format('private.%I', v_table), 'INSERT')
      and has_table_privilege('service_role', format('private.%I', v_table), 'UPDATE')
      and has_table_privilege('service_role', format('private.%I', v_table), 'DELETE')
    ) then
      raise exception 'service_role lacks DML privileges on private.%', v_table;
    end if;
  end loop;

  -- Every SECURITY DEFINER function in the audited schemas is pinned and has
  -- no inherited PUBLIC EXECUTE privilege.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private', 'chatgpt_internal')
      and p.prosecdef
      and p.proconfig is distinct from array['search_path=""']::text[]
  ) then
    raise exception 'A security-definer function has a mutable search_path';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private', 'chatgpt_internal')
      and p.prosecdef and has_function_privilege('public', p.oid, 'EXECUTE')
  ) then
    raise exception 'A security-definer function still inherits PUBLIC EXECUTE';
  end if;

  -- Exact signature inventory.  Any added, removed, renamed, or changed
  -- overload requires a deliberate allowlist review.
  for v_inventory in
    select * from (values
      ('public'::text, 53::integer, '3d89cf3d89fc57d974272c92af3e866d'::text, '19b6ea78b00833e5e8377a485b9a8153'::text),
      ('private'::text, 95::integer, 'c43f26ee13bf69fcbfe3bafa6143087a'::text, '3f504dcd5f05105acc0d381ebdc12aa0'::text),
      ('chatgpt_internal'::text, 30::integer, '61e49e45ce13bd26a0cfd1de444e32d2'::text, 'd16699246747ca63713818d4209f6629'::text)
    ) as expected(schema_name, function_count, inventory_hash, role_inventory_hash)
  loop
    select count(*)::integer as function_count,
           md5(string_agg(
             format('%s.%s(%s)', n.nspname, p.proname,
                    pg_get_function_identity_arguments(p.oid)),
             '|' order by p.proname, pg_get_function_identity_arguments(p.oid)
           )) as inventory_hash,
           md5(string_agg(
             format('%s.%s(%s)|anon=%s|authenticated=%s|service_role=%s',
                    n.nspname, p.proname,
                    pg_get_function_identity_arguments(p.oid),
                    has_function_privilege('anon', p.oid, 'EXECUTE'),
                    has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                    has_function_privilege('service_role', p.oid, 'EXECUTE')),
             '|' order by p.proname, pg_get_function_identity_arguments(p.oid)
           )) as role_inventory_hash
      into v_schema
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = v_inventory.schema_name and p.prosecdef;
    if v_schema.function_count <> v_inventory.function_count
       or v_schema.inventory_hash <> v_inventory.inventory_hash
       or v_schema.role_inventory_hash <> v_inventory.role_inventory_hash then
      raise exception 'SECURITY DEFINER inventory drift in % (count %, identity hash %, role hash %)',
        v_inventory.schema_name, v_schema.function_count, v_schema.inventory_hash, v_schema.role_inventory_hash;
    end if;
  end loop;

  -- Trusted Website Bridge and helper service RPCs are service-role-only.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and (
        p.proname like 'chatgpt\_bridge\_service\_%' escape '\'
        or p.proname like 'browser\_agent\_service\_%' escape '\'
        or p.proname like 'form\_agent\_service\_%' escape '\'
        or p.proname = 'record_form_agent_acceptance_result'
      )
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'A public service RPC has an invalid client-role grant';
  end if;

  -- The MCP rate-limit wrapper is the sole anonymous exception.  It hashes
  -- and validates the raw OAuth token before touching user-scoped state.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname = 'chatgpt_consume_rate_limit'
      and pg_get_function_identity_arguments(p.oid) =
        'p_access_token text, p_bucket text, p_limit integer, p_window_seconds integer'
      and (
        not has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'The token-bound rate-limit exception has drifted';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname = any(v_public_authenticated)
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'An authenticated public wrapper has an invalid role grant';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname <> 'chatgpt_consume_rate_limit'
      and p.proname <> 'record_form_agent_acceptance_result'
      and p.proname <> all(v_public_authenticated)
      and p.proname !~ '^(chatgpt_bridge_service_|browser_agent_service_|form_agent_service_)'
  ) then
    raise exception 'An unlisted public security-definer function is executable';
  end if;

  -- Dedicated ChatGPT dispatchers have a narrow role matrix.  Other internal
  -- definitions stay closed and are reachable only through these dispatchers.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'chatgpt_internal' and p.prosecdef
      and p.proname = any(v_chatgpt_internal_token)
      and (
        not has_function_privilege('anon', p.oid, 'EXECUTE')
        or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'A ChatGPT internal token dispatcher has an invalid grant';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'chatgpt_internal' and p.prosecdef
      and p.proname = 'server_get_google_refresh_token'
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'The ChatGPT internal credential dispatcher has an invalid grant';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'chatgpt_internal' and p.prosecdef
      and p.proname = any(v_chatgpt_internal_closed)
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'A closed ChatGPT internal function has a client or service grant';
  end if;

  -- A private helper that accepts an arbitrary user id, or any *_for_user
  -- implementation, is never directly callable by a client role.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and (
        pg_get_function_arguments(p.oid) ~* '(^|, )p_user(_id)? '
        or p.proname like '%\_for\_user' escape '\'
      )
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'A private arbitrary-user/security helper is directly executable by a client role';
  end if;

  -- Explicit private service-only exceptions.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and p.proname in (
        'chatgpt_server_get_google_refresh_token_internal',
        'claim_bootstrap_import_internal',
        'revoke_app_member_internal'
      )
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'A private service-only implementation has an invalid grant';
  end if;
end;
$$;

select json_build_object(
  'status', 'passed',
  'checked_at', now(),
  'private_tables', 6,
  'security_definer_schemas', json_build_array('public', 'private', 'chatgpt_internal'),
  'inventory_hashes', json_build_object(
    'public', '3d89cf3d89fc57d974272c92af3e866d',
    'private', 'c43f26ee13bf69fcbfe3bafa6143087a',
    'chatgpt_internal', '61e49e45ce13bd26a0cfd1de444e32d2',
    'public_role', '19b6ea78b00833e5e8377a485b9a8153',
    'private_role', '3f504dcd5f05105acc0d381ebdc12aa0',
    'chatgpt_internal_role', 'd16699246747ca63713818d4209f6629'
  )
) as supabase_security_verification;
