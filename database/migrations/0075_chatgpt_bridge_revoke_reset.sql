-- M34: an explicit ChatGPT bridge revocation is a full binding reset.
--
-- Revoke the device credential, stop its pre-delivery requests, remove every
-- workflow conversation binding, and clear the legacy binding columns. The
-- ChatGPT Project and conversations themselves are external resources and are
-- deliberately not deleted by this operation.

create or replace function public.revoke_chatgpt_bridge_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_device public.chatgpt_bridge_devices;
  v_removed_bindings integer := 0;
  v_stopped_dispatches integer := 0;
  v_invalidated_pairing_codes integer := 0;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);

  select * into v_device
    from public.chatgpt_bridge_devices
   where id=p_device_id and user_id=v_user and revoked_at is null
   for update;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;

  -- A request which was already delivered is left auditable. Requests which
  -- could still reach the browser are stopped and their leases are cleared.
  update public.chatgpt_dispatch_requests
     set state='user_required',
         user_required_at=now(),
         error_json=jsonb_build_object('code','device_revoked','message','The bound ChatGPT bridge device was revoked before delivery.'),
         lease_token_hash=null,
         lease_expires_at=null,
         updated_at=now()
   where user_id=v_user
     and target_device_id=p_device_id
     and state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready');
  get diagnostics v_stopped_dispatches = row_count;

  update public.job_url_inspection_requests j
     set status='user_required',
         error_json=jsonb_build_object('code','device_revoked','message','The ChatGPT bridge device was revoked before inspection delivery.'),
         updated_at=now()
   where j.user_id=v_user
     and j.status in ('queued','processing')
     and exists(
       select 1
         from public.chatgpt_dispatch_requests r
        where r.user_id=v_user
          and r.target_device_id=p_device_id
          and r.action_type='job.inspect_url'
          and r.state='user_required'
          and r.subject_refs->>'inspection_id'=j.id::text
     );

  delete from public.chatgpt_bridge_conversation_slots
   where device_id=p_device_id;
  get diagnostics v_removed_bindings = row_count;

  -- A pairing code issued before the explicit reset must not recreate the
  -- revoked bridge's state through the upgrade-recovery path.
  update public.chatgpt_bridge_pairing_codes
     set used_at=now()
   where user_id=v_user and used_at is null;
  get diagnostics v_invalidated_pairing_codes = row_count;

  update public.chatgpt_bridge_devices
     set revoked_at=coalesce(revoked_at,now()),
         automatic_send_enabled=false,
         preferred=false,
         bound_conversation_url=null,
         bound_project_name=null,
         bound_project_verified_at=null,
         updated_at=now()
   where id=p_device_id and user_id=v_user;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(
    v_user,
    'user',
    v_user::text,
    'chatgpt_bridge.device_revoked',
    'chatgpt_bridge_device',
    p_device_id,
    jsonb_build_object(
      'workflow_bindings_removed',v_removed_bindings,
      'dispatches_stopped',v_stopped_dispatches,
      'pairing_codes_invalidated',v_invalidated_pairing_codes,
      'external_chatgpt_conversations_deleted',false
    )
  );

  return jsonb_build_object(
    'revoked',true,
    'device_id',p_device_id,
    'workflow_bindings_removed',v_removed_bindings,
    'dispatches_stopped',v_stopped_dispatches,
    'pairing_codes_invalidated',v_invalidated_pairing_codes,
    'external_chatgpt_conversations_deleted',false
  );
end;
$$;

revoke all on function public.revoke_chatgpt_bridge_device(uuid) from public, anon;
grant execute on function public.revoke_chatgpt_bridge_device(uuid) to authenticated;

-- Explicit revocation is the one operation that intentionally prevents the
-- upgrade-recovery pair flow from carrying the revoked device's old slots
-- into a new device. Active, non-revoked devices may still be migrated so a
-- routine extension upgrade does not force the user to recreate conversations.
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
  -- Keep the service-role check aligned with the existing Supabase RPC
  -- boundary: SECURITY DEFINER changes current_user, while auth.role()
  -- retains the role of the caller that invoked the Edge Function.
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

  -- Only an active device can be an upgrade-recovery source. A revoked device
  -- has been explicitly reset and must never repopulate workflow bindings.
  select d.* into v_source
    from public.chatgpt_bridge_devices d
   where d.user_id=v_pairing.user_id
     and d.revoked_at is null
   order by
     case when exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=d.id and s.active and s.project_verified_at is not null) then 0 else 1 end,
     d.preferred desc,
     d.updated_at desc nulls last,
     d.paired_at desc
   limit 1;

  if found then
    v_restore_automatic_send := v_source.automatic_send_enabled and exists(
      select 1 from public.chatgpt_bridge_conversation_slots s
       where s.device_id=v_source.id and s.active and s.project_verified_at is not null
    );
  end if;

  -- The newly paired browser becomes the preferred delivery device. Existing
  -- active devices remain auditable, but automatic delivery is disabled on
  -- them so two extension versions cannot race the same queue.
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
