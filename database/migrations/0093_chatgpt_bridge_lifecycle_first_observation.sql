-- M37 follow-up: repeated page hints and late worker retries keep the first
-- observation for each lifecycle stage. This makes retries idempotent while
-- preserving one monotonic sequence even when two transports race.

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
    'browser_hint_emitted_at','extension_hint_received_at','server_claimed_at',
    'bound_tab_selected_at','content_script_ready_at','composer_ready_at',
    'send_boundary_recorded_at','user_turn_verified_at','response_detected_at',
    'response_uploaded_at','recovery_phase'
  ];
  v_timestamp_keys text[] := array[
    'browser_hint_emitted_at','extension_hint_received_at','server_claimed_at',
    'bound_tab_selected_at','content_script_ready_at','composer_ready_at',
    'send_boundary_recorded_at','user_turn_verified_at','response_detected_at',
    'response_uploaded_at'
  ];
  v_merged jsonb := '{}'::jsonb;
  v_key text;
  v_value text;
  v_current timestamptz;
  v_update timestamptz;
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

  for v_key in select unnest(v_allowed) loop
    if coalesce(p_existing, '{}'::jsonb) ? v_key
       and jsonb_typeof(coalesce(p_existing, '{}'::jsonb)->v_key) <> 'null' then
      v_merged := jsonb_set(v_merged, array[v_key], coalesce(p_existing, '{}'::jsonb)->v_key, true);
    end if;
  end loop;
  for v_key in select key from jsonb_object_keys(coalesce(p_update, '{}'::jsonb)) key loop
    if jsonb_typeof(p_update->v_key) = 'null' then
      continue;
    end if;
    if v_key = any(v_timestamp_keys) and v_merged ? v_key then
      begin
        v_current := (v_merged->>v_key)::timestamptz;
        v_update := (p_update->>v_key)::timestamptz;
      exception when others then
        raise exception 'Bridge lifecycle timestamp is invalid';
      end;
      -- The first observation is authoritative for a phase. Keeping the
      -- earliest value makes repeated hints and late retries idempotent.
      if v_update < v_current then
        v_merged := jsonb_set(v_merged, array[v_key], p_update->v_key, true);
      end if;
    else
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
