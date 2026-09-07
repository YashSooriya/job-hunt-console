-- M30: carry verified workflow conversations across an explicit bridge
-- re-pair. A new extension version must not force the user to recreate the
-- JobHuntAI Project or its chats.

create or replace function public.chatgpt_bridge_service_pair_device(
  p_code_hash text,
  p_token_hash text,
  p_display_name text,
  p_platform text default 'chrome',
  p_extension_version text default null,
  p_capabilities jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pairing public.chatgpt_bridge_pairing_codes;
  v_source public.chatgpt_bridge_devices;
  v_device public.chatgpt_bridge_devices;
  v_restore_automatic_send boolean := false;
  v_restored_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  if nullif(btrim(coalesce(p_code_hash,'')),'') is null then raise exception 'Pairing-code hash is required'; end if;
  if nullif(btrim(coalesce(p_token_hash,'')),'') is null then raise exception 'Device-token hash is required'; end if;
  if jsonb_typeof(coalesce(p_capabilities,'{}'::jsonb)) <> 'object' then raise exception 'Capabilities must be an object'; end if;
  select * into v_pairing
    from public.chatgpt_bridge_pairing_codes
   where code_hash=p_code_hash and used_at is null and expires_at>now()
   for update;
  if not found then raise exception 'Pairing code is invalid, expired, or already used'; end if;
  perform private.assert_active_app_membership(v_pairing.user_id);

  -- Prefer the user's most recent device that has verified workflow slots.
  -- Include revoked devices because revocation deliberately leaves their
  -- server-recorded bindings available for an explicit replacement pairing.
  select d.* into v_source
    from public.chatgpt_bridge_devices d
   where d.user_id=v_pairing.user_id
   order by
     case when exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=d.id and s.active and s.project_verified_at is not null) then 0 else 1 end,
     case when d.revoked_at is null then 0 else 1 end,
     d.preferred desc,
     d.updated_at desc nulls last,
     d.paired_at desc
   limit 1;

  if found then
    v_restore_automatic_send := v_source.revoked_at is null and v_source.automatic_send_enabled and exists(
      select 1 from public.chatgpt_bridge_conversation_slots s
       where s.device_id=v_source.id and s.active and s.project_verified_at is not null
    );
  end if;

  -- The newly paired browser becomes the preferred delivery device. Existing
  -- devices remain auditable and recoverable, but automatic delivery is
  -- disabled on them so two extension versions cannot race the same queue.
  update public.chatgpt_bridge_devices
     set preferred=false,automatic_send_enabled=false,updated_at=now()
   where user_id=v_pairing.user_id and revoked_at is null;

  insert into public.chatgpt_bridge_devices(
    user_id,display_name,platform,extension_version,token_hash,capabilities,
    automatic_send_enabled,preferred,last_seen_at
  ) values(
    v_pairing.user_id,
    left(coalesce(nullif(btrim(p_display_name),''),'JobHuntAI ChatGPT Bridge'),160),
    left(coalesce(nullif(btrim(p_platform),''),'chrome'),40),
    nullif(left(coalesce(p_extension_version,''),40),''),
    p_token_hash,
    p_capabilities,
    v_restore_automatic_send,
    true,
    now()
  ) returning * into v_device;

  if v_source.id is not null then
    insert into public.chatgpt_bridge_conversation_slots(
      device_id,user_id,workflow_key,display_name,conversation_url,project_name,
      project_verified_at,active,bound_at,last_used_at,last_dispatch_at,created_at,updated_at
    )
    select
      v_device.id,v_device.user_id,s.workflow_key,s.display_name,s.conversation_url,
      'JobHuntAI',s.project_verified_at,true,coalesce(s.bound_at,now()),
      s.last_used_at,s.last_dispatch_at,coalesce(s.created_at,now()),now()
      from public.chatgpt_bridge_conversation_slots s
     where s.device_id=v_source.id and s.active and s.project_verified_at is not null
    on conflict (device_id,workflow_key) do nothing;
    get diagnostics v_restored_count = row_count;

    -- Requests created before the upgrade were targeted at the old device.
    -- Move only still-queued requests; an in-flight request must expire or be
    -- explicitly retried rather than being delivered twice.
    update public.chatgpt_dispatch_requests
       set target_device_id=v_device.id,updated_at=now()
     where user_id=v_pairing.user_id and target_device_id=v_source.id and state='queued';
  end if;

  update public.chatgpt_bridge_pairing_codes set used_at=now() where id=v_pairing.id and used_at is null;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(
    v_pairing.user_id,'system','chatgpt-bridge','chatgpt_bridge.device_paired',
    'chatgpt_bridge_device',v_device.id,
    jsonb_build_object(
      'platform',v_device.platform,
      'extension_version',v_device.extension_version,
      'capabilities',v_device.capabilities,
      'migrated_from_device_id',v_source.id,
      'restored_workflow_count',v_restored_count,
      'automatic_send_restored',v_restore_automatic_send
    )
  );
  return jsonb_build_object(
    'id',v_device.id,'user_id',v_device.user_id,'display_name',v_device.display_name,
    'platform',v_device.platform,'extension_version',v_device.extension_version,
    'preferred',v_device.preferred,'automatic_send_enabled',v_device.automatic_send_enabled,
    'paired_at',v_device.paired_at,'restored_workflow_count',v_restored_count,
    'conversations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'workflow_key',s.workflow_key,'display_name',s.display_name,
      'conversation_url',s.conversation_url,'project_name',s.project_name,
      'project_verified',s.project_verified_at is not null,'bound_at',s.bound_at,
      'last_used_at',s.last_used_at,'last_dispatch_at',s.last_dispatch_at,'active',s.active
    ) order by s.display_name) from public.chatgpt_bridge_conversation_slots s where s.device_id=v_device.id and s.active),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.chatgpt_bridge_service_pair_device(text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_pair_device(text,text,text,text,text,jsonb) to service_role;
