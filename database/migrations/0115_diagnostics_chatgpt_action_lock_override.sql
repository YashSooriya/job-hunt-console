-- Diagnostics may explicitly allow multiple ChatGPT actions to overlap.
-- The default remains serialized, and every opted-in operation keeps its own
-- server-side claim until it is tracked or released. Website Bridge dispatch,
-- exact-turn response capture, and provenance are unchanged.

alter table public.job_search_controls
  add column if not exists chatgpt_action_lock_disabled boolean not null default false;

-- A diagnostics opt-in can create more than one operation for the same user.
-- Keep each claim and its dispatch group independently recoverable.
alter table private.chatgpt_user_operation_locks
  drop constraint if exists chatgpt_user_operation_locks_pkey;
alter table private.chatgpt_user_operation_locks
  add constraint chatgpt_user_operation_locks_pkey primary key (user_id, operation_id);

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
  v_lock_disabled boolean;
  v_requested_lock_disabled boolean;
  v_has_active_linked boolean := false;
  v_busy boolean := false;
  v_title text := left(coalesce(nullif(btrim(p_display_title), ''), 'ChatGPT task'), 160);
  v_active_states constant text[] := array[
    'queued','claimed_by_extension','opening_chatgpt','composer_ready','send_attempted',
    'sent','acknowledged_by_mcp','running'
  ];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_action not in ('begin','track','release','status','set_action_lock_disabled') then
    raise exception 'Unsupported ChatGPT operation action';
  end if;
  if p_action in ('begin','track','release') and p_operation_id is null then
    raise exception 'ChatGPT operation id is required';
  end if;
  if cardinality(coalesce(p_dispatch_ids,'{}'::uuid[])) > 50
     or exists(select 1 from unnest(coalesce(p_dispatch_ids,'{}'::uuid[])) as request_id where request_id is null) then
    raise exception 'Invalid ChatGPT operation dispatch list';
  end if;
  if p_action = 'track' and cardinality(coalesce(p_dispatch_ids,'{}'::uuid[])) = 0 then
    raise exception 'A ChatGPT operation cannot be tracked without dispatch request ids';
  end if;
  if p_action = 'set_action_lock_disabled'
     and (p_operation_id is not null or cardinality(coalesce(p_dispatch_ids,'{}'::uuid[])) <> 0
          or p_display_title is null or p_display_title not in ('true','false')) then
    raise exception 'The ChatGPT action lock setting must be true or false';
  end if;

  if p_action in ('begin','set_action_lock_disabled') then
    -- Begin and setting changes serialize together so switching the override
    -- off cannot race a new, untracked operation claim.
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  end if;

  select coalesce((
    select c.chatgpt_action_lock_disabled
      from public.job_search_controls c
     where c.user_id = v_user
  ), false) into v_lock_disabled;

  if p_action in ('begin','status','set_action_lock_disabled') then
    -- Remove only per-operation rows whose no-dispatch lease expired or whose
    -- complete tracked dispatch group is terminal.
    delete from private.chatgpt_user_operation_locks l
     where l.user_id = v_user
       and (
         (cardinality(l.dispatch_ids) = 0 and l.claim_expires_at is not null and l.claim_expires_at <= now())
         or (
           cardinality(l.dispatch_ids) > 0
           and not exists (
             select 1 from public.chatgpt_dispatch_requests d
              where d.user_id = v_user and d.id = any(l.dispatch_ids)
                and d.state = any(v_active_states)
           )
         )
       );
  end if;

  if p_action = 'release' then
    delete from private.chatgpt_user_operation_locks
     where user_id = v_user and operation_id = p_operation_id;
    return jsonb_build_object('ok', true, 'busy', false, 'lock_disabled', v_lock_disabled);
  end if;

  if p_action = 'track' then
    if exists(
      select 1
        from unnest(coalesce(p_dispatch_ids,'{}'::uuid[])) requested(id)
       where not exists(
         select 1 from public.chatgpt_dispatch_requests d
          where d.id = requested.id and d.user_id = v_user
       )
    ) then
      raise exception 'A ChatGPT dispatch does not belong to this operation owner';
    end if;
    select * into v_lock
      from private.chatgpt_user_operation_locks
     where user_id = v_user and operation_id = p_operation_id
     for update;
    if not found then raise exception 'The ChatGPT operation is no longer active'; end if;
    update private.chatgpt_user_operation_locks
       set dispatch_ids = (
             select coalesce(array_agg(distinct tracked_id), '{}'::uuid[])
               from unnest(v_lock.dispatch_ids || coalesce(p_dispatch_ids,'{}'::uuid[])) tracked(tracked_id)
           ),
           claim_expires_at = null,
           updated_at = now()
     where user_id = v_user and operation_id = p_operation_id
     returning * into v_lock;
    return jsonb_build_object('ok', true, 'busy', true, 'lock_disabled', v_lock_disabled,
      'operation_id', v_lock.operation_id, 'display_title', v_lock.display_title,
      'dispatch_ids', to_jsonb(v_lock.dispatch_ids));
  end if;

  if p_action = 'begin' then
    select * into v_lock
      from private.chatgpt_user_operation_locks
     where user_id = v_user and operation_id = p_operation_id
     for update;
    if found then
      return jsonb_build_object('ok', true, 'busy', true, 'lock_disabled', v_lock_disabled,
        'operation_id', v_lock.operation_id, 'display_title', v_lock.display_title,
        'dispatch_ids', to_jsonb(v_lock.dispatch_ids), 'idempotent', true);
    end if;

    if not v_lock_disabled then
      select * into v_lock
        from private.chatgpt_user_operation_locks
       where user_id = v_user
       order by claimed_at asc
       limit 1;
      if found then
        return jsonb_build_object('ok', false, 'busy', true, 'lock_disabled', false,
          'display_title', v_lock.display_title,
          'error', 'Another ChatGPT task is already in progress. Wait for its response before starting another ChatGPT action.');
      end if;

      select * into v_dispatch
        from public.chatgpt_dispatch_requests d
       where d.user_id = v_user and d.state = any(v_active_states)
       order by d.created_at asc
       limit 1;
      if found then
        return jsonb_build_object('ok', false, 'busy', true, 'lock_disabled', false,
          'dispatch_id', v_dispatch.id, 'display_title', v_dispatch.display_title,
          'error', 'A ChatGPT task is already in progress. Wait for its response before starting another ChatGPT action.');
      end if;
    end if;

    insert into private.chatgpt_user_operation_locks(user_id, operation_id, display_title, claim_expires_at)
    values(v_user, p_operation_id, v_title, now() + interval '10 minutes');
    return jsonb_build_object('ok', true, 'busy', true, 'lock_disabled', v_lock_disabled,
      'operation_id', p_operation_id, 'display_title', v_title);
  end if;

  if p_action = 'set_action_lock_disabled' then
    v_requested_lock_disabled := p_display_title = 'true';
    if not v_requested_lock_disabled and v_lock_disabled then
      select exists(
        select 1 from private.chatgpt_user_operation_locks l where l.user_id = v_user
      ) into v_busy;
      if not v_busy then
        select exists(
          select 1 from public.chatgpt_dispatch_requests d
           where d.user_id = v_user and d.state = any(v_active_states)
        ) into v_busy;
      end if;
      if v_busy then
        return jsonb_build_object('ok', false, 'busy', true, 'lock_disabled', true,
          'error', 'The site-wide ChatGPT lock cannot be restored while a ChatGPT action is active. Wait for active actions to finish, then try again.');
      end if;
    end if;

    insert into public.job_search_controls as existing(user_id, chatgpt_action_lock_disabled)
    values(v_user, v_requested_lock_disabled)
    on conflict (user_id) do update
      set chatgpt_action_lock_disabled = excluded.chatgpt_action_lock_disabled,
          updated_at = now();

    select exists(
      select 1 from private.chatgpt_user_operation_locks l where l.user_id = v_user
    ) into v_busy;
    if not v_busy then
      select exists(
        select 1 from public.chatgpt_dispatch_requests d
         where d.user_id = v_user and d.state = any(v_active_states)
      ) into v_busy;
    end if;
    return jsonb_build_object('ok', true, 'busy', v_busy,
      'lock_disabled', v_requested_lock_disabled);
  end if;

  -- Status is read-only apart from releasing claims that expired without a
  -- dispatch and clearing fully-terminal operation rows.
  select * into v_lock
    from private.chatgpt_user_operation_locks
   where user_id = v_user
   order by case when cardinality(dispatch_ids) > 0 then 0 else 1 end, claimed_at asc
   limit 1;
  if found then
    if cardinality(v_lock.dispatch_ids) > 0 then
      select * into v_dispatch
        from public.chatgpt_dispatch_requests d
       where d.user_id = v_user and d.id = any(v_lock.dispatch_ids)
         and d.state = any(v_active_states)
       order by d.created_at asc
       limit 1;
      v_has_active_linked := found;
    end if;
    return jsonb_build_object('ok', true, 'busy', true, 'lock_disabled', v_lock_disabled,
      'operation_id', v_lock.operation_id, 'display_title', v_lock.display_title,
      'dispatch_ids', to_jsonb(v_lock.dispatch_ids),
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
    return jsonb_build_object('ok', true, 'busy', true, 'lock_disabled', v_lock_disabled,
      'dispatch_id', v_dispatch.id, 'display_title', v_dispatch.display_title,
      'dispatch_state', v_dispatch.state, 'progress', v_dispatch.progress_json);
  end if;
  return jsonb_build_object('ok', true, 'busy', false, 'lock_disabled', v_lock_disabled);
end;
$$;

revoke all on function private.manage_chatgpt_user_operation_internal(uuid,text,text,uuid[]) from public, anon, service_role;
grant execute on function private.manage_chatgpt_user_operation_internal(uuid,text,text,uuid[]) to authenticated;

comment on column public.job_search_controls.chatgpt_action_lock_disabled is
  'Owner-scoped Diagnostics override allowing explicitly opted-in overlapping ChatGPT operations; disabled by default.';
comment on table private.chatgpt_user_operation_locks is
  'Private per-operation ChatGPT initiation claims. Rows are owner-scoped, inaccessible to clients, and tracked until their complete dispatch group reaches a terminal state.';
