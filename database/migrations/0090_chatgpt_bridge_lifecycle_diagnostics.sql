-- M37: content-free, durable Website Bridge lifecycle diagnostics.
--
-- Lifecycle data lives outside progress_json because v1 and v2 state
-- transitions intentionally replace progress_json at several safety fences.
-- Keeping this small allow-listed object on the dispatch row means a
-- completed request still contains the complete timing sequence without ever
-- copying an instruction, response, token, or conversation export.

alter table public.chatgpt_dispatch_requests
  add column if not exists lifecycle_json jsonb not null default '{}'::jsonb;

create index if not exists chatgpt_dispatch_requests_lifecycle_idx
  on public.chatgpt_dispatch_requests(user_id, updated_at desc)
  where lifecycle_json <> '{}'::jsonb;

create or replace function private.chatgpt_bridge_merge_lifecycle(
  p_existing jsonb,
  p_update jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed text[] := array[
    'browser_hint_emitted_at',
    'extension_hint_received_at',
    'server_claimed_at',
    'bound_tab_selected_at',
    'content_script_ready_at',
    'composer_ready_at',
    'send_boundary_recorded_at',
    'user_turn_verified_at',
    'response_detected_at',
    'response_uploaded_at',
    'recovery_phase'
  ];
  v_timestamp_keys text[] := array[
    'browser_hint_emitted_at',
    'extension_hint_received_at',
    'server_claimed_at',
    'bound_tab_selected_at',
    'content_script_ready_at',
    'composer_ready_at',
    'send_boundary_recorded_at',
    'user_turn_verified_at',
    'response_detected_at',
    'response_uploaded_at'
  ];
  v_merged jsonb := '{}'::jsonb;
  v_key text;
  v_value text;
  v_current timestamptz;
  v_previous timestamptz := null;
begin
  if jsonb_typeof(coalesce(p_existing, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_update, '{}'::jsonb)) <> 'object' then
    raise exception 'Bridge lifecycle must be an object';
  end if;
  if length(coalesce(p_update, '{}'::jsonb)::text) > 4000 then
    raise exception 'Bridge lifecycle is too large';
  end if;

  for v_key in select key from jsonb_object_keys(coalesce(p_update, '{}'::jsonb)) key loop
    if not (v_key = any(v_allowed)) then
      raise exception 'Bridge lifecycle contains an unsupported field';
    end if;
  end loop;

  -- Copy only the allow-listed fields from the current value. This also
  -- scrubs any malformed or accidentally expanded value left by an older
  -- deployment before merging the new update.
  for v_key in select unnest(v_allowed) loop
    if coalesce(p_existing, '{}'::jsonb) ? v_key
       and jsonb_typeof(coalesce(p_existing, '{}'::jsonb)->v_key) <> 'null' then
      v_merged := jsonb_set(v_merged, array[v_key], coalesce(p_existing, '{}'::jsonb)->v_key, true);
    end if;
  end loop;
  for v_key in select key from jsonb_object_keys(coalesce(p_update, '{}'::jsonb)) key loop
    if jsonb_typeof(p_update->v_key) <> 'null' then
      v_merged := jsonb_set(v_merged, array[v_key], p_update->v_key, true);
    end if;
  end loop;

  for v_key in select unnest(v_timestamp_keys) loop
    if v_merged ? v_key then
      v_value := v_merged->>v_key;
      if length(coalesce(v_value, '')) < 1 or length(v_value) > 64 then
        raise exception 'Bridge lifecycle timestamp is invalid';
      end if;
      begin
        v_current := v_value::timestamptz;
      exception when others then
        raise exception 'Bridge lifecycle timestamp is invalid';
      end;
      if v_previous is not null and v_current < v_previous then
        raise exception 'Bridge lifecycle timestamps must be monotonic';
      end if;
      v_previous := v_current;
    end if;
  end loop;

  if v_merged ? 'recovery_phase' then
    v_value := v_merged->>'recovery_phase';
    if length(coalesce(v_value, '')) < 1 or length(v_value) > 80
       or v_value !~ '^[A-Za-z][A-Za-z0-9_:-]*$' then
      raise exception 'Bridge recovery phase is invalid';
    end if;
  end if;
  return v_merged;
end;
$$;

revoke all on function private.chatgpt_bridge_merge_lifecycle(jsonb,jsonb) from public, anon, authenticated;

create or replace function public.record_chatgpt_dispatch_lifecycle(
  p_request_id uuid,
  p_lifecycle jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.chatgpt_dispatch_requests;
  v_lifecycle jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_user
   for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  v_lifecycle := private.chatgpt_bridge_merge_lifecycle(v_request.lifecycle_json, p_lifecycle);
  update public.chatgpt_dispatch_requests
     set lifecycle_json=v_lifecycle, updated_at=now()
   where id=v_request.id
   returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'lifecycle',v_request.lifecycle_json);
end;
$$;

revoke all on function public.record_chatgpt_dispatch_lifecycle(uuid,jsonb) from public, anon;
grant execute on function public.record_chatgpt_dispatch_lifecycle(uuid,jsonb) to authenticated;

create or replace function public.get_chatgpt_dispatch_lifecycle(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_lifecycle jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select lifecycle_json into v_lifecycle
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_user;
  if not found then raise exception 'Dispatch request not found'; end if;
  return jsonb_build_object('lifecycle',coalesce(v_lifecycle,'{}'::jsonb));
end;
$$;

revoke all on function public.get_chatgpt_dispatch_lifecycle(uuid) from public, anon;
grant execute on function public.get_chatgpt_dispatch_lifecycle(uuid) to authenticated;

-- The extension calls this through the service-role Edge Function. A lease
-- is required for every non-terminal state and the attempt id, when present,
-- must match the same delivery attempt. After completion only the final
-- response_uploaded_at marker may be appended, so a late worker retry cannot
-- rewrite the earlier delivery history.
create or replace function public.chatgpt_bridge_service_record_dispatch_lifecycle(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text default null,
  p_attempt_id uuid default null,
  p_lifecycle jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_lifecycle jsonb;
  v_key text;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device
    from public.chatgpt_bridge_devices
   where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_device.user_id
   for update;
  if not found then raise exception 'Dispatch request not found'; end if;

  if v_request.state='completed' then
    for v_key in select key from jsonb_object_keys(coalesce(p_lifecycle, '{}'::jsonb)) key loop
      if v_key not in ('response_uploaded_at','recovery_phase') then
        raise exception 'Only the upload marker may be recorded after completion';
      end if;
    end loop;
  elsif v_request.state in ('failed','cancelled','expired','user_required') then
    raise exception 'A terminal bridge dispatch cannot receive lifecycle updates';
  else
    if v_request.target_device_id is distinct from p_device_id
       or v_request.lease_token_hash is distinct from p_lease_token_hash
       or v_request.lease_expires_at is null
       or v_request.lease_expires_at <= now() then
      raise exception 'Dispatch lifecycle lease is invalid or has expired';
    end if;
    if p_attempt_id is not null and v_request.delivery_attempt_id is distinct from p_attempt_id then
      raise exception 'Dispatch lifecycle attempt is invalid';
    end if;
  end if;

  v_lifecycle := private.chatgpt_bridge_merge_lifecycle(v_request.lifecycle_json, p_lifecycle);
  update public.chatgpt_dispatch_requests
     set lifecycle_json=v_lifecycle, updated_at=now()
   where id=v_request.id
   returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'lifecycle',v_request.lifecycle_json);
end;
$$;

revoke all on function public.chatgpt_bridge_service_record_dispatch_lifecycle(uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_record_dispatch_lifecycle(uuid,uuid,text,uuid,jsonb) to service_role;

comment on column public.chatgpt_dispatch_requests.lifecycle_json is
  'Allow-listed Website Bridge lifecycle timestamps and recovery phase. Never store instructions, responses, tokens, or conversation contents here.';
