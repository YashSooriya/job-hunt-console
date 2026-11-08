-- Read-only production qualification for the Point 12 Supabase boundary.
-- Run with ON_ERROR_STOP=1.  Any drift raises an exception.
-- The inventory is checked against database/security/security-definer-allowlist.json.

do $$
declare
  v_table text;
  v_pool_table text;
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
  v_public_authenticated_owner text[] := array[
    'save_job_search_preferences', 'finalize_job_search_run',
    'begin_job_pool_sheet_sync', 'finish_job_pool_sheet_sync',
    'create_job_analysis_batch', 'create_application_from_job',
    'create_cv_document_version', 'create_application_cover_letter_version',
    'save_application_content_package', 'finalize_application_document_item',
    'assemble_application_review_package', 'review_application_document',
    'review_application_salary', 'review_application_answer',
    'set_application_cover_letter_decision', 'approve_application_content',
    'return_application_to_revision', 'transition_application_state'
  ];
  v_public_authenticated_limited text[] := array[
    'manage_app_member'
  ];
  v_public_service_only text[] := array[
    'claim_due_job_pool_sheet_checks',
    'finish_job_pool_sheet_drive_check',
    'get_job_pool_scheduler_secret'
  ];
  v_private_v3_fit_worker_internal text[] := array[
    'job_fit_v3_worker_create_batch_internal', 'job_fit_v3_save_result_internal',
    'job_fit_v3_worker_transition_internal', 'job_fit_v3_worker_claim_internal',
    'job_fit_v3_worker_dispatch_internal', 'job_fit_v3_worker_status_internal',
    'job_fit_v3_worker_captures_internal', 'job_fit_v3_worker_release_internal'
  ];
  v_private_authenticated_current text[] := array[
    'current_user_active_member',
    'job_fit_v3_find_response_check_candidate_internal',
    'job_fit_v3_create_response_check_internal',
    'manage_chatgpt_user_operation_internal',
    'retry_captured_job_url_inspection_internal',
    'can_mutate_application_document_object'
  ];
begin
  -- The credential and membership tables are service-role-only and retain RLS.
  foreach v_table in array array[
    'bootstrap_import_batches', 'gmail_oauth_credentials', 'app_memberships',
    'app_invitations', 'chatgpt_oauth_authorization_codes',
    'chatgpt_oauth_access_tokens', 'chatgpt_user_operation_locks'
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

  -- The job-pool projection and run snapshot have owner-scoped RLS. Direct
  -- access is only what the authenticated UI and SECURITY INVOKER dispatch
  -- wrapper need; service_role uses no broad table grant for these tables.
  foreach v_pool_table in array array[
    'job_pool_sheet_sync', 'job_pool_sheet_publications', 'job_search_run_pool_snapshots'
  ] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=v_pool_table and c.relkind='r' and c.relrowsecurity
    ) then
      raise exception 'RLS is not enabled on public.%',v_pool_table;
    end if;
    if has_table_privilege('anon',format('public.%I',v_pool_table),'SELECT')
       or has_table_privilege('anon',format('public.%I',v_pool_table),'INSERT')
       or has_table_privilege('anon',format('public.%I',v_pool_table),'UPDATE')
       or has_table_privilege('anon',format('public.%I',v_pool_table),'DELETE')
       or has_table_privilege('service_role',format('public.%I',v_pool_table),'SELECT')
       or has_table_privilege('service_role',format('public.%I',v_pool_table),'INSERT')
       or has_table_privilege('service_role',format('public.%I',v_pool_table),'UPDATE')
       or has_table_privilege('service_role',format('public.%I',v_pool_table),'DELETE') then
      raise exception 'anon or service_role has direct access to public.%',v_pool_table;
    end if;
    if not has_table_privilege('authenticated',format('public.%I',v_pool_table),'SELECT')
       or has_table_privilege('authenticated',format('public.%I',v_pool_table),'UPDATE')
       or has_table_privilege('authenticated',format('public.%I',v_pool_table),'DELETE') then
      raise exception 'The authenticated SELECT boundary is invalid on public.%',v_pool_table;
    end if;
    if v_pool_table='job_search_run_pool_snapshots'
       and not has_table_privilege('authenticated',format('public.%I',v_pool_table),'INSERT') then
      raise exception 'The owner-scoped dispatch wrapper cannot insert its run snapshot';
    end if;
    if v_pool_table<>'job_search_run_pool_snapshots'
       and has_table_privilege('authenticated',format('public.%I',v_pool_table),'INSERT') then
      raise exception 'Authenticated users can directly insert into public.%',v_pool_table;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policies p
     where p.schemaname='public' and p.tablename='job_pool_sheet_sync'
       and p.policyname='job_pool_sheet_sync_owner_select'
       and p.roles=array['authenticated']::name[] and p.cmd='SELECT'
       and p.qual like '%auth.uid%'
  ) or not exists (
    select 1 from pg_policies p
     where p.schemaname='public' and p.tablename='job_pool_sheet_publications'
       and p.policyname='job_pool_sheet_publications_owner_select'
       and p.roles=array['authenticated']::name[] and p.cmd='SELECT'
       and p.qual like '%auth.uid%'
  ) or not exists (
    select 1 from pg_policies p
     where p.schemaname='public' and p.tablename='job_search_run_pool_snapshots'
       and p.policyname='job_search_run_pool_snapshots_owner_insert'
       and p.roles=array['authenticated']::name[] and p.cmd='INSERT'
       and p.with_check like '%auth.uid%'
  ) then
    raise exception 'A Job Pool Sheet owner policy is missing or broadened';
  end if;

  if not exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'job_search_controls'
       and c.column_name = 'chatgpt_action_lock_disabled'
       and c.is_nullable = 'NO' and c.column_default in ('false', 'false::boolean')
  ) then
    raise exception 'The Diagnostics action-lock override is missing its non-null default-off setting';
  end if;
  if has_column_privilege('authenticated', 'public.job_search_controls', 'chatgpt_action_lock_disabled', 'UPDATE') then
    raise exception 'Authenticated users can directly modify the Diagnostics action-lock override';
  end if;
  if not exists (
    select 1 from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
     where n.nspname = 'private' and r.relname = 'chatgpt_user_operation_locks'
       and c.contype = 'p'
       and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (user_id, operation_id)'
  ) then
    raise exception 'ChatGPT concurrent operation claims are not independently keyed';
  end if;

  -- These new public endpoints are deliberately invoker wrappers. They must
  -- remain callable only by authenticated users and must not widen service_role.
  if exists (
    select 1 from (values
      ('manage_chatgpt_user_operation'::text, 'p_operation_id uuid, p_action text, p_display_title text, p_dispatch_ids uuid[]'::text),
      ('retry_captured_job_url_inspection'::text, 'p_request_id uuid, p_dispatch_id uuid'::text)
    ) expected(function_name, identity_arguments)
    left join pg_proc p on p.proname = expected.function_name
      and pg_get_function_identity_arguments(p.oid) = expected.identity_arguments
    left join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    where p.oid is null
       or n.oid is null
       or p.prosecdef
       or has_function_privilege('anon', p.oid, 'EXECUTE')
       or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'A ChatGPT operation/recovery/import wrapper is missing its SECURITY INVOKER or narrow role boundary';
  end if;

  -- Captured URL-import persistence is a service-only SECURITY INVOKER
  -- wrapper. It delegates to one private SECURITY DEFINER helper whose
  -- authority is restricted to the authenticated device owner's exact
  -- completed v3 dispatch and linked inspection rows.
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'chatgpt_bridge_service_apply_job_url_inspection_v3'
       and pg_get_function_identity_arguments(p.oid) =
         'p_dispatch_id uuid, p_request_id uuid, p_response_hash text, p_result_status text, p_extraction jsonb, p_message text'
       and (
         p.prosecdef
         or has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or not has_function_privilege('service_role', p.oid, 'EXECUTE')
       )
  ) or not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'chatgpt_bridge_service_apply_job_url_inspection_v3'
       and pg_get_function_identity_arguments(p.oid) =
         'p_dispatch_id uuid, p_request_id uuid, p_response_hash text, p_result_status text, p_extraction jsonb, p_message text'
  ) then
    raise exception 'The captured job-import wrapper is missing its SECURITY INVOKER service-only boundary';
  end if;

  -- Memory-fit capture needs fields from the protected dispatch table. Keep
  -- its public writer SECURITY INVOKER; cross that table boundary only through
  -- a private fixed-path helper that verifies the authenticated owner, active
  -- membership, exact action, chunk identity, and Website Bridge instruction.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private'
       and p.proname='job_fit_memory_v4_get_dispatch_for_capture'
       and pg_get_function_identity_arguments(p.oid)='p_dispatch_id uuid, p_idempotency_key text, p_job_ids uuid[], p_instruction text'
       and p.prosecdef
       and not has_function_privilege('anon',p.oid,'EXECUTE')
       and has_function_privilege('authenticated',p.oid,'EXECUTE')
       and not has_function_privilege('service_role',p.oid,'EXECUTE')
  ) or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname='capture_job_fit_memory_v4_chunk'
       and pg_get_function_identity_arguments(p.oid)='p_chunk_id uuid, p_dispatch_id uuid'
       and not p.prosecdef
       and not has_function_privilege('anon',p.oid,'EXECUTE')
       and has_function_privilege('authenticated',p.oid,'EXECUTE')
       and not has_function_privilege('service_role',p.oid,'EXECUTE')
  ) or has_table_privilege('anon','public.chatgpt_dispatch_requests','SELECT')
    or has_table_privilege('authenticated','public.chatgpt_dispatch_requests','SELECT') then
    raise exception 'Memory-fit response capture is missing its private current-user lookup or SECURITY INVOKER/closed-table boundary';
  end if;

  -- The V4 minute worker is narrowly granted function execution, not direct
  -- table access. Foreground and scheduled recovery contend on the same batch
  -- lease and send only through the generic Website Bridge function.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=any(array[
         'job_fit_memory_v4_worker_claim','job_fit_memory_v4_worker_context',
         'job_fit_memory_v4_worker_capture','job_fit_memory_v4_worker_save',
         'job_fit_memory_v4_worker_dispatch','job_fit_memory_v4_worker_needs_user',
         'job_fit_memory_v4_worker_release'
       ]))<>7
    or exists(
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=any(array[
         'job_fit_memory_v4_worker_claim','job_fit_memory_v4_worker_context',
         'job_fit_memory_v4_worker_capture','job_fit_memory_v4_worker_save',
         'job_fit_memory_v4_worker_dispatch','job_fit_memory_v4_worker_needs_user',
         'job_fit_memory_v4_worker_release'
       ])
         and (p.prosecdef or has_function_privilege('anon',p.oid,'EXECUTE')
           or has_function_privilege('authenticated',p.oid,'EXECUTE')
           or not has_function_privilege('service_role',p.oid,'EXECUTE'))
    )
    or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='private' and p.prosecdef and p.proname=any(array[
         'job_fit_memory_v4_worker_claim_internal','job_fit_memory_v4_worker_context_internal',
         'job_fit_memory_v4_worker_capture_internal','job_fit_memory_v4_worker_save_internal',
         'job_fit_memory_v4_worker_dispatch_internal','job_fit_memory_v4_worker_needs_user_internal',
         'job_fit_memory_v4_worker_release_internal'
       ]))<>7
    or exists(
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='private' and p.prosecdef and p.proname=any(array[
         'job_fit_memory_v4_worker_claim_internal','job_fit_memory_v4_worker_context_internal',
         'job_fit_memory_v4_worker_capture_internal','job_fit_memory_v4_worker_save_internal',
         'job_fit_memory_v4_worker_dispatch_internal','job_fit_memory_v4_worker_needs_user_internal',
         'job_fit_memory_v4_worker_release_internal'
       ])
         and (has_function_privilege('anon',p.oid,'EXECUTE')
           or has_function_privilege('authenticated',p.oid,'EXECUTE')
           or not has_function_privilege('service_role',p.oid,'EXECUTE'))
    )
    or has_table_privilege('service_role','public.job_fit_memory_v4_batches','SELECT')
    or has_table_privilege('service_role','public.job_fit_memory_v4_batches','UPDATE')
    or has_table_privilege('service_role','public.job_fit_memory_v4_chunks','SELECT')
    or has_table_privilege('service_role','public.job_fit_memory_v4_items','UPDATE')
    or not exists(select 1 from pg_attribute a where a.attrelid='public.job_fit_memory_v4_batches'::regclass and a.attname='advance_lease_token' and not a.attisdropped)
    or not exists(select 1 from pg_constraint c where c.conrelid='public.job_fit_memory_v4_batches'::regclass and c.conname='job_fit_memory_v4_batch_advance_lease_pair')
    or not exists(select 1 from pg_constraint c where c.conrelid='public.job_fit_memory_v4_items'::regclass and c.conname='job_fit_memory_v4_items_state_check' and pg_get_constraintdef(c.oid) like '%needs_user%') then
    raise exception 'Memory-fit background worker must share exact-turn RLS boundaries, a foreground lease, and service-only SECURITY INVOKER wrapper grants without service-role table privileges';
  end if;

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
      ('public'::text, 62::integer, '654bbb53f458cf6a111f6c6bb543ceee'::text, 'cde6545072529a9569d81dcb61cd3671'::text),
      ('private'::text, 131::integer, 'bb8f10d13a8518cbca8aa43040a6117a'::text, 'a13f96b3c84f80f45e99b401631e4668'::text),
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

  -- Owner-scoped application, search, analysis, and Sheet wrappers derive
  -- auth.uid() and are intentionally unavailable to service_role.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname = any(v_public_authenticated_owner)
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'An owner-scoped public wrapper has an invalid role grant';
  end if;

  -- Member administration is an authenticated-only public boundary; in
  -- particular, it must never become a service-role or anonymous RPC.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname = any(v_public_authenticated_limited)
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'A member-administration public wrapper has an invalid role grant';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prosecdef and p.proname=any(v_public_service_only)
       and (
         has_function_privilege('anon',p.oid,'EXECUTE')
         or has_function_privilege('authenticated',p.oid,'EXECUTE')
         or not has_function_privilege('service_role',p.oid,'EXECUTE')
       )
  ) or exists (
    select 1 from unnest(v_public_service_only) expected(function_name)
     where not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef and p.proname=expected.function_name
     )
  ) then
    raise exception 'A Job Pool Sheet scheduler RPC has an invalid service-only boundary';
  end if;

  -- Durable fit-analysis batches expose owner-readable state to clients;
  -- claim/finish are service-role-only invoker wrappers.
  foreach v_table in array array['job_analysis_batches','job_analysis_tasks'] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=v_table and c.relkind='r' and c.relrowsecurity
    ) then
      raise exception 'RLS is not enabled on public.%',v_table;
    end if;
    if has_table_privilege('anon',format('public.%I',v_table),'SELECT')
       or has_table_privilege('anon',format('public.%I',v_table),'INSERT')
       or has_table_privilege('anon',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('anon',format('public.%I',v_table),'DELETE')
       or has_table_privilege('service_role',format('public.%I',v_table),'SELECT')
       or has_table_privilege('service_role',format('public.%I',v_table),'INSERT')
       or has_table_privilege('service_role',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('service_role',format('public.%I',v_table),'DELETE')
       or not has_table_privilege('authenticated',format('public.%I',v_table),'SELECT')
       or has_table_privilege('authenticated',format('public.%I',v_table),'INSERT')
       or has_table_privilege('authenticated',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('authenticated',format('public.%I',v_table),'DELETE') then
      raise exception 'The durable analysis table role grants are invalid on public.%',v_table;
    end if;
    if not exists (
      select 1 from pg_policies p where p.schemaname='public' and p.tablename=v_table
        and p.roles=array['authenticated']::name[] and p.cmd='SELECT'
        and p.qual like '%auth.uid%' and p.qual like '%current_user_active_member%'
    ) then
      raise exception 'The durable analysis table lacks an active owner-read policy on public.%',v_table;
    end if;
  end loop;

  if exists (
    select 1 from (values
      ('create_job_analysis_batch'::text,'p_request_id uuid, p_mode text, p_job_ids uuid[]'::text,'authenticated'::text),
      ('get_job_analysis_batch'::text,'p_batch_id uuid'::text,'authenticated'::text),
      ('get_retryable_job_analysis_count'::text,''::text,'authenticated'::text),
      ('claim_job_analysis_tasks'::text,'p_limit integer'::text,'service_role'::text),
      ('finish_job_analysis_task'::text,'p_task_id uuid, p_lease_token uuid, p_analysis jsonb, p_input_hash text, p_engine_version text, p_error text'::text,'service_role'::text)
    ) expected(function_name,identity_arguments,allowed_role)
    left join pg_proc p on p.proname=expected.function_name
      and pg_get_function_identity_arguments(p.oid)=expected.identity_arguments
      and p.pronamespace='public'::regnamespace
    left join pg_namespace n on n.oid=p.pronamespace and n.nspname='public'
    where p.oid is null or n.oid is null
      or (expected.function_name='create_job_analysis_batch' and not p.prosecdef)
      or (expected.function_name<>'create_job_analysis_batch' and p.prosecdef)
      or has_function_privilege('anon',p.oid,'EXECUTE')
      or (expected.allowed_role='authenticated' and (not has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('service_role',p.oid,'EXECUTE')))
      or (expected.allowed_role='service_role' and (has_function_privilege('authenticated',p.oid,'EXECUTE') or not has_function_privilege('service_role',p.oid,'EXECUTE')))
  ) then
    raise exception 'A durable analysis RPC has an invalid wrapper security mode or role grant';
  end if;

  -- V3 fit snapshots include verified professional data and exact response
  -- provenance. Only the owning active member may read or advance them;
  -- service_role receives no direct table access.
  foreach v_table in array array['job_fit_v3_batches','job_fit_v3_tasks'] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=v_table and c.relkind='r' and c.relrowsecurity
    ) then raise exception 'RLS is not enabled on public.%',v_table; end if;
    if has_table_privilege('anon',format('public.%I',v_table),'SELECT')
       or has_table_privilege('anon',format('public.%I',v_table),'INSERT')
       or has_table_privilege('anon',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('anon',format('public.%I',v_table),'DELETE')
       or has_table_privilege('service_role',format('public.%I',v_table),'SELECT')
       or has_table_privilege('service_role',format('public.%I',v_table),'INSERT')
       or has_table_privilege('service_role',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('service_role',format('public.%I',v_table),'DELETE')
       or not has_table_privilege('authenticated',format('public.%I',v_table),'SELECT')
       or has_table_privilege('authenticated',format('public.%I',v_table),'INSERT')
       or has_table_privilege('authenticated',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('authenticated',format('public.%I',v_table),'DELETE') then
      raise exception 'The V3 fit table role grants are invalid on public.%',v_table;
    end if;
    if not exists (
      select 1 from pg_policies p where p.schemaname='public' and p.tablename=v_table
       and p.roles=array['authenticated']::name[] and p.cmd='SELECT'
       and p.qual like '%auth.uid%' and p.qual like '%current_user_active_member%'
    ) then raise exception 'V3 fit rows lack an active-owner read policy on public.%',v_table; end if;
  end loop;

  foreach v_table in array array['job_fit_v3_inputs','job_fit_v3_captures','job_fit_v3_results','job_fit_v3_evidence_references'] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=v_table and c.relkind='r' and c.relrowsecurity
    ) then raise exception 'RLS is not enabled on public.%',v_table; end if;
    if has_table_privilege('anon',format('public.%I',v_table),'SELECT')
       or has_table_privilege('anon',format('public.%I',v_table),'INSERT')
       or has_table_privilege('anon',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('anon',format('public.%I',v_table),'DELETE')
       or has_table_privilege('service_role',format('public.%I',v_table),'SELECT')
       or has_table_privilege('service_role',format('public.%I',v_table),'INSERT')
       or has_table_privilege('service_role',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('service_role',format('public.%I',v_table),'DELETE')
       or not has_table_privilege('authenticated',format('public.%I',v_table),'SELECT')
       or has_table_privilege('authenticated',format('public.%I',v_table),'INSERT')
       or has_table_privilege('authenticated',format('public.%I',v_table),'UPDATE')
       or has_table_privilege('authenticated',format('public.%I',v_table),'DELETE') then
      raise exception 'The V3 fit immutable evidence role grants are invalid on public.%',v_table;
    end if;
    if not exists (
      select 1 from pg_policies p where p.schemaname='public' and p.tablename=v_table
       and p.policyname=case when v_table='job_fit_v3_evidence_references'
         then 'job_fit_v3_evidence_owner_select' else v_table||'_owner_select' end
       and p.roles=array['authenticated']::name[] and p.cmd='SELECT'
       and p.qual like '%auth.uid%' and p.qual like '%current_user_active_member%'
    ) then raise exception 'V3 fit evidence rows lack an active-owner read policy on public.%',v_table; end if;
  end loop;

  -- Worker RPCs remain narrow SECURITY INVOKER wrappers. service_role has no
  -- direct table privileges and receives only these exact execute grants.
  if exists (
    select 1 from (values
      ('job_fit_v3_worker_create_batch'::text,'p_user_id uuid, p_request_id uuid, p_mode text, p_job_ids uuid[], p_tasks jsonb'::text),
      ('job_fit_v3_worker_transition'::text,'p_user_id uuid, p_task_id uuid, p_expected_state text, p_expected_step_index integer, p_dispatch_id uuid, p_action text, p_error text, p_input_payload jsonb, p_steps jsonb, p_input_hash text, p_result_json jsonb, p_capture jsonb, p_lease_token uuid'::text),
      ('job_fit_v3_worker_save_result'::text,'p_user_id uuid, p_task_id uuid, p_lease_token uuid'::text),
      ('job_fit_v3_worker_claim'::text,'p_limit integer, p_user_id uuid'::text),
      ('job_fit_v3_worker_dispatch'::text,'p_user_id uuid, p_task_id uuid, p_lease_token uuid'::text),
      ('job_fit_v3_worker_status'::text,'p_user_id uuid, p_task_id uuid, p_dispatch_id uuid, p_lease_token uuid'::text),
      ('job_fit_v3_worker_captures'::text,'p_user_id uuid, p_task_id uuid, p_lease_token uuid'::text),
      ('job_fit_v3_worker_release'::text,'p_user_id uuid, p_task_id uuid, p_lease_token uuid'::text)
    ) expected(function_name,identity_arguments)
    left join pg_proc p on p.proname=expected.function_name
      and pg_get_function_identity_arguments(p.oid)=expected.identity_arguments
      and p.pronamespace='public'::regnamespace
    where p.oid is null or p.prosecdef
      or has_function_privilege('anon',p.oid,'EXECUTE')
      or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or not has_function_privilege('service_role',p.oid,'EXECUTE')
  ) then
    raise exception 'A V3 fit worker wrapper is missing its SECURITY INVOKER or service-only execute boundary';
  end if;

  if exists (
    select 1 from (values
      ('create_job_fit_v3_batch'::text,'p_request_id uuid, p_mode text, p_job_ids uuid[], p_tasks jsonb'::text),
      ('save_job_fit_v3_result'::text,'p_task_id uuid'::text)
    ) expected(function_name,identity_arguments)
    join pg_proc p on p.proname=expected.function_name
      and pg_get_function_identity_arguments(p.oid)=expected.identity_arguments
      and p.pronamespace='public'::regnamespace
    where has_function_privilege('anon',p.oid,'EXECUTE')
       or has_function_privilege('authenticated',p.oid,'EXECUTE')
       or has_function_privilege('service_role',p.oid,'EXECUTE')
  ) then raise exception 'A superseded direct V3 fit write RPC remains callable'; end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.prosecdef
       and p.proname=any(v_private_v3_fit_worker_internal)
       and (has_function_privilege('anon',p.oid,'EXECUTE')
         or has_function_privilege('authenticated',p.oid,'EXECUTE')
         or not has_function_privilege('service_role',p.oid,'EXECUTE'))
  ) or exists (
    select 1 from unnest(v_private_v3_fit_worker_internal) expected(function_name)
     where not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='private' and p.prosecdef and p.proname=expected.function_name
     )
  ) then
    raise exception 'A V3 fit implementation helper is missing its private service-only boundary';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.prosecdef
       and p.proname='job_fit_v3_save_result_internal'
       and (
         position('private.app_memberships' in pg_get_functiondef(p.oid))=0
         or position('request.jwt.claim.sub' in pg_get_functiondef(p.oid))=0
         or position('request.jwt.claim.role' in pg_get_functiondef(p.oid))=0
         or position('request.jwt.claims' in pg_get_functiondef(p.oid))=0
         or position('m.email' in pg_get_functiondef(p.oid))=0
       )
  ) then
    raise exception 'The fit-worker active membership JWT claims are not built from the verified membership record';
  end if;

  -- V4 deliberately retires fresh V3 profile-bearing batch creation. Do not
  -- require the old membership-claim plumbing in this fail-closed stub; verify
  -- that the retirement remains explicit while exact captured V3 turns can
  -- still be saved through the separate membership-checked result worker.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.prosecdef
       and p.proname='job_fit_v3_worker_create_batch_internal'
       and position('Profile-bearing V3 batch creation is retired. Use Memory-only job analysis.' in pg_get_functiondef(p.oid))>0
  ) then
    raise exception 'Fresh V3 profile-bearing batch creation must remain retired after the Memory-only cutover';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.prosecdef
       and p.proname in ('claim_job_analysis_tasks','finish_job_analysis_task')
       and (has_function_privilege('anon',p.oid,'EXECUTE')
         or has_function_privilege('authenticated',p.oid,'EXECUTE')
         or not has_function_privilege('service_role',p.oid,'EXECUTE'))
  ) or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='claim_job_analysis_tasks' and p.prosecdef
  ) or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='finish_job_analysis_task' and p.prosecdef
  ) then
    raise exception 'A durable analysis worker helper is missing its private service-only boundary';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.prosecdef and p.proname='claim_job_analysis_tasks'
       and position('private.app_memberships' in pg_get_functiondef(p.oid)) > 0
       and position('m.status=''active''' in pg_get_functiondef(p.oid)) > 0
  ) then
    raise exception 'The analysis worker must pause durable tasks while membership is revoked';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.prosecdef
       and p.proname in ('create_job_analysis_batch','bump_job_analysis_revision','bump_profile_analysis_revision',
         'bump_job_analysis_revision_from_company_update','bump_job_analysis_revision_from_snapshot_update',
         'bump_profile_analysis_revision_on_profile_update','enqueue_imported_job_analysis')
       and (has_function_privilege('anon',p.oid,'EXECUTE')
         or has_function_privilege('authenticated',p.oid,'EXECUTE')
         or has_function_privilege('service_role',p.oid,'EXECUTE'))
  ) then
    raise exception 'A durable analysis owner/trigger helper is directly executable by an API role';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname <> 'chatgpt_consume_rate_limit'
      and p.proname <> 'record_form_agent_acceptance_result'
      and p.proname <> all(v_public_authenticated)
      and p.proname <> all(v_public_authenticated_owner)
      and p.proname <> all(v_public_authenticated_limited)
      and p.proname <> all(v_public_service_only)
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

  -- This zero-argument private predicate is safe for client-role RLS use: it
  -- reports only whether the caller identified by auth.uid()/email is active.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and p.proname = any(v_private_authenticated_current)
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'The current-user membership predicate has an invalid grant';
  end if;

  -- The user-facing recovery wrapper is an invoker-only, authenticated-only
  -- endpoint. Its private SECURITY DEFINER helper derives auth.uid() and is
  -- separately inventoried as a current-user helper above.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='job_fit_v3_create_response_check'
       and pg_get_function_identity_arguments(p.oid)='p_task_id uuid, p_source_dispatch_id uuid'
       and not p.prosecdef and p.proconfig=array['search_path=""']::text[]
       and has_function_privilege('authenticated',p.oid,'EXECUTE')
       and not has_function_privilege('anon',p.oid,'EXECUTE')
       and not has_function_privilege('service_role',p.oid,'EXECUTE')
  ) then
    raise exception 'The V3 exact-turn recovery wrapper is missing its authenticated-only SECURITY INVOKER boundary';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='job_fit_v3_find_response_check_candidate'
       and pg_get_function_identity_arguments(p.oid)=''
       and not p.prosecdef and p.proconfig=array['search_path=""']::text[]
       and has_function_privilege('authenticated',p.oid,'EXECUTE')
       and not has_function_privilege('anon',p.oid,'EXECUTE')
       and not has_function_privilege('service_role',p.oid,'EXECUTE')
  ) then
    raise exception 'The V3 recovery-discovery wrapper is missing its authenticated-only SECURITY INVOKER boundary';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='job_fit_v3_tasks' and column_name='response_check_source_attempt_count'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='job_fit_v3_tasks' and column_name='response_check_last_requested_at'
  ) or not exists (
    select 1 from pg_constraint c
     where c.conrelid='public.job_fit_v3_tasks'::regclass
       and c.conname='job_fit_v3_tasks_response_check_attempt_count_check'
       and pg_get_constraintdef(c.oid) ~* 'response_check_attempt_count.*(between\s*0\s*and\s*4|>=\s*0.*<=\s*4)'
  ) then
    raise exception 'V3 exact-turn recovery is missing its persisted original-attempt/cooldown fields or four-check ceiling';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='job_fit_v3_enforce_exact_turn_identity'
       and not p.prosecdef
       and not has_function_privilege('anon',p.oid,'EXECUTE')
       and not has_function_privilege('authenticated',p.oid,'EXECUTE')
       and not has_function_privilege('service_role',p.oid,'EXECUTE')
  ) then
    raise exception 'The V3 stale-turn capture guard must remain a closed trigger-only helper';
  end if;

  -- Explicit private service-only exceptions.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and p.proname in (
        'chatgpt_bridge_apply_job_url_inspection_v3',
      'chatgpt_server_get_google_refresh_token_internal',
      'claim_bootstrap_import_internal',
      'job_fit_v3_worker_create_batch_internal',
      'job_fit_v3_save_result_internal',
      'job_fit_v3_worker_transition_internal',
      'job_fit_v3_worker_claim_internal',
      'job_fit_v3_worker_dispatch_internal',
      'job_fit_v3_worker_status_internal',
      'job_fit_v3_worker_captures_internal',
      'job_fit_v3_worker_release_internal',
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

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.prosecdef
       and p.proname in ('job_fit_v3_immutable_row','refresh_job_fit_v3_batch')
       and (has_function_privilege('anon',p.oid,'EXECUTE')
         or has_function_privilege('authenticated',p.oid,'EXECUTE')
         or has_function_privilege('service_role',p.oid,'EXECUTE'))
  ) then
    raise exception 'A private V3 append-only or batch helper is executable by an API role';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='mark_job_pool_sheet_dirty' and p.prosecdef
       and (
         has_function_privilege('anon',p.oid,'EXECUTE')
         or has_function_privilege('authenticated',p.oid,'EXECUTE')
         or has_function_privilege('service_role',p.oid,'EXECUTE')
       )
  ) then
    raise exception 'The Job Pool Sheet dirty trigger implementation must remain non-executable by API roles';
  end if;
end;
$$;

select json_build_object(
  'status', 'passed',
  'checked_at', now(),
  'private_tables', 7,
  'job_pool_sheet_tables', 3,
  'security_definer_schemas', json_build_array('public', 'private', 'chatgpt_internal'),
  'inventory_hashes', json_build_object(
    'public', '654bbb53f458cf6a111f6c6bb543ceee',
    'private', 'bb8f10d13a8518cbca8aa43040a6117a',
    'chatgpt_internal', '61e49e45ce13bd26a0cfd1de444e32d2',
    'public_role', 'cde6545072529a9569d81dcb61cd3671',
    'private_role', 'a13f96b3c84f80f45e99b401631e4668',
    'chatgpt_internal_role', 'd16699246747ca63713818d4209f6629'
  )
) as supabase_security_verification;
