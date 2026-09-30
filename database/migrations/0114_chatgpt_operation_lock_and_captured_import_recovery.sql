-- Keep one ChatGPT-initiating user action active at a time across pages and
-- browser tabs. The lock tracks an operation's complete dispatch group, so
-- ordered professional-background messages remain one legitimate operation.
-- This is application coordination only: the Bridge delivery/provenance
-- contract and its SECURITY INVOKER service wrappers are unchanged.

create table private.chatgpt_user_operation_locks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  operation_id uuid not null,
  display_title text not null,
  dispatch_ids uuid[] not null default '{}'::uuid[],
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claim_expires_at timestamptz
);

alter table private.chatgpt_user_operation_locks enable row level security;
revoke all on table private.chatgpt_user_operation_locks from public, anon, authenticated;
grant select, insert, update, delete on table private.chatgpt_user_operation_locks to service_role;
create policy service_role_only on private.chatgpt_user_operation_locks
  for all to service_role using (true) with check (true);

create or replace function private.manage_chatgpt_user_operation_internal(
  p_operation_id uuid,
  p_action text,
  p_display_title text default null,
  p_dispatch_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_lock private.chatgpt_user_operation_locks;
  v_dispatch public.chatgpt_dispatch_requests;
  v_has_active_linked boolean := false;
  v_title text := left(coalesce(nullif(btrim(p_display_title), ''), 'ChatGPT task'), 160);
  v_active_states constant text[] := array[
    'queued','claimed_by_extension','opening_chatgpt','composer_ready','send_attempted',
    'sent','acknowledged_by_mcp','running'
  ];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_action not in ('begin','track','release','status') then raise exception 'Unsupported ChatGPT operation action'; end if;
  if p_action in ('begin','track','release') and p_operation_id is null then raise exception 'ChatGPT operation id is required'; end if;
  if cardinality(coalesce(p_dispatch_ids,'{}'::uuid[])) > 50
     or exists(select 1 from unnest(coalesce(p_dispatch_ids,'{}'::uuid[])) as request_id where request_id is null) then
    raise exception 'Invalid ChatGPT operation dispatch list';
  end if;

  if p_action = 'begin' then
    -- Serialise claims for one owner. A second tab or concurrent POST can
    -- never create a second operation between the active check and insert.
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  end if;

  select * into v_lock
    from private.chatgpt_user_operation_locks
   where user_id = v_user
   for update;

  if found and cardinality(v_lock.dispatch_ids) > 0 then
    select exists(
      select 1 from public.chatgpt_dispatch_requests d
       where d.user_id = v_user and d.id = any(v_lock.dispatch_ids)
         and d.state = any(v_active_states)
    ) into v_has_active_linked;
    if not v_has_active_linked then
      delete from private.chatgpt_user_operation_locks where user_id = v_user;
      v_lock := null;
    end if;
  elsif found and v_lock.claim_expires_at <= now() then
    -- A route crashed after claiming but before it could create a dispatch.
    -- The lease is only for that no-dispatch window; tracked dispatches
    -- remain locked until the Bridge reaches a terminal state.
    delete from private.chatgpt_user_operation_locks where user_id = v_user;
    v_lock := null;
  end if;

  if p_action = 'release' then
    delete from private.chatgpt_user_operation_locks
     where user_id = v_user and operation_id = p_operation_id;
    return jsonb_build_object('ok', true, 'busy', false);
  end if;

  if p_action = 'track' then
    if v_lock.user_id is distinct from v_user or v_lock.operation_id is distinct from p_operation_id then
      raise exception 'The ChatGPT operation is no longer active';
    end if;
    if exists(
      select 1
        from unnest(coalesce(p_dispatch_ids,'{}'::uuid[])) requested(id)
       where not exists(select 1 from public.chatgpt_dispatch_requests d where d.id = requested.id and d.user_id = v_user)
    ) then
      raise exception 'A ChatGPT dispatch does not belong to this operation owner';
    end if;
    update private.chatgpt_user_operation_locks
       set dispatch_ids = (
             select coalesce(array_agg(distinct tracked_id), '{}'::uuid[])
               from unnest(dispatch_ids || coalesce(p_dispatch_ids,'{}'::uuid[])) tracked(tracked_id)
           ),
           claim_expires_at = null,
           updated_at = now()
     where user_id = v_user and operation_id = p_operation_id
     returning * into v_lock;
    return jsonb_build_object('ok', true, 'busy', true, 'operation_id', v_lock.operation_id,
      'display_title', v_lock.display_title, 'dispatch_ids', to_jsonb(v_lock.dispatch_ids));
  end if;

  if p_action = 'begin' then
    if v_lock.user_id = v_user then
      if v_lock.operation_id = p_operation_id then
        return jsonb_build_object('ok', true, 'busy', true, 'operation_id', v_lock.operation_id,
          'display_title', v_lock.display_title, 'dispatch_ids', to_jsonb(v_lock.dispatch_ids), 'idempotent', true);
      end if;
      return jsonb_build_object('ok', false, 'busy', true, 'display_title', v_lock.display_title,
        'error', 'Another ChatGPT task is already in progress. Wait for its response before starting another ChatGPT action.');
    end if;

    select * into v_dispatch
      from public.chatgpt_dispatch_requests d
     where d.user_id = v_user and d.state = any(v_active_states)
     order by d.created_at asc
     limit 1;
    if found then
      return jsonb_build_object('ok', false, 'busy', true, 'dispatch_id', v_dispatch.id,
        'display_title', v_dispatch.display_title,
        'error', 'A ChatGPT task is already in progress. Wait for its response before starting another ChatGPT action.');
    end if;

    insert into private.chatgpt_user_operation_locks(user_id, operation_id, display_title, claim_expires_at)
    values(v_user, p_operation_id, v_title, now() + interval '10 minutes');
    return jsonb_build_object('ok', true, 'busy', true, 'operation_id', p_operation_id, 'display_title', v_title);
  end if;

  -- Status is read-only apart from expiring a claim which never attached a
  -- dispatch, or clearing a fully-terminal operation. An unrelated active
  -- dispatch (for example a scheduled run) still keeps the UI locked.
  if v_lock.user_id = v_user then
    select * into v_dispatch
      from public.chatgpt_dispatch_requests d
     where d.user_id = v_user and d.id = any(v_lock.dispatch_ids)
       and d.state = any(v_active_states)
     order by d.created_at asc
     limit 1;
    v_has_active_linked := found;
    return jsonb_build_object('ok', true, 'busy', true, 'operation_id', v_lock.operation_id,
      'display_title', v_lock.display_title, 'dispatch_ids', to_jsonb(v_lock.dispatch_ids),
      'dispatch_id', case when v_has_active_linked then v_dispatch.id end,
      'dispatch_state', case when v_has_active_linked then v_dispatch.state end,
      'progress', case when v_has_active_linked then v_dispatch.progress_json end);
  end if;
  select * into v_dispatch
    from public.chatgpt_dispatch_requests d
   where d.user_id = v_user and d.state = any(v_active_states)
   order by d.created_at asc
   limit 1;
  if found then
    return jsonb_build_object('ok', true, 'busy', true, 'dispatch_id', v_dispatch.id,
      'display_title', v_dispatch.display_title, 'dispatch_state', v_dispatch.state,
      'progress', v_dispatch.progress_json);
  end if;
  return jsonb_build_object('ok', true, 'busy', false);
end;
$$;

revoke all on function private.manage_chatgpt_user_operation_internal(uuid,text,text,uuid[]) from public, anon, service_role;
grant execute on function private.manage_chatgpt_user_operation_internal(uuid,text,text,uuid[]) to authenticated;

-- The public endpoint stays SECURITY INVOKER and the private helper derives
-- ownership exclusively from auth.uid(). No direct table access is granted.
create or replace function public.manage_chatgpt_user_operation(
  p_operation_id uuid,
  p_action text,
  p_display_title text default null,
  p_dispatch_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.manage_chatgpt_user_operation_internal($1,$2,$3,$4);
$$;
revoke all on function public.manage_chatgpt_user_operation(uuid,text,text,uuid[]) from public, anon, service_role;
grant execute on function public.manage_chatgpt_user_operation(uuid,text,text,uuid[]) to authenticated;

-- A prior importer marked a captured, v3-proven response as user_required
-- when a rendered citation token made strict JSON parsing fail. Allow only
-- that exact failure class to return to processing; the caller must still
-- parse the stored exact-turn response and use the existing completion RPC.
create or replace function private.retry_captured_job_url_inspection_internal(
  p_request_id uuid,
  p_dispatch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.job_url_inspection_requests;
  v_dispatch public.chatgpt_dispatch_requests;
  v_user uuid := (select auth.uid());
  v_parse_error_prefix constant text := 'ChatGPT''s listing response was not one valid JSON object.';
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_request_id is null or p_dispatch_id is null then raise exception 'Inspection and dispatch ids are required'; end if;

  select * into v_request
    from public.job_url_inspection_requests
   where id = p_request_id and user_id = v_user
   for update;
  if not found then raise exception 'Inspection request not found'; end if;
  if v_request.dispatch_request_id is distinct from p_dispatch_id then
    raise exception 'The captured response is not linked to this inspection request';
  end if;

  select * into v_dispatch
    from public.chatgpt_dispatch_requests
   where id = p_dispatch_id and user_id = v_user;
  if not found
     or v_dispatch.action_type <> 'job.inspect_url'
     or v_dispatch.state <> 'completed'
     or v_dispatch.bridge_response is null
     or v_dispatch.response_provenance is null
     or v_dispatch.output_refs->>'response_provenance_recorded' is distinct from 'true' then
    raise exception 'A completed v3-proven ChatGPT response is required for recovery';
  end if;

  if v_request.status = 'completed' then
    return jsonb_build_object('request_id', v_request.id, 'status', v_request.status, 'job_id', v_request.job_id, 'idempotent', true);
  end if;
  if v_request.status in ('queued','processing') then
    return jsonb_build_object('request_id', v_request.id, 'status', v_request.status, 'idempotent', true);
  end if;
  if v_request.status not in ('failed','user_required')
     or left(coalesce(v_request.error_json->>'message',''), length(v_parse_error_prefix)) <> v_parse_error_prefix then
    raise exception 'Only a listing request stopped by the known JSON parse failure can be recovered from a captured response';
  end if;

  update public.job_url_inspection_requests
     set status = 'processing', error_json = null, updated_at = now()
   where id = v_request.id and user_id = v_user
   returning * into v_request;
  return jsonb_build_object('request_id', v_request.id, 'status', v_request.status, 'recovered_captured_result', true);
end;
$$;
revoke all on function private.retry_captured_job_url_inspection_internal(uuid,uuid) from public, anon, service_role;
grant execute on function private.retry_captured_job_url_inspection_internal(uuid,uuid) to authenticated;

create or replace function public.retry_captured_job_url_inspection(p_request_id uuid, p_dispatch_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.retry_captured_job_url_inspection_internal($1,$2);
$$;
revoke all on function public.retry_captured_job_url_inspection(uuid,uuid) from public, anon, service_role;
grant execute on function public.retry_captured_job_url_inspection(uuid,uuid) to authenticated;

comment on table private.chatgpt_user_operation_locks is
  'Private cross-page ChatGPT initiation lock, owned by the authenticated user and released after every associated dispatch reaches a terminal state.';
