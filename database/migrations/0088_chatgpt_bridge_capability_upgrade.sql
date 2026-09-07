-- M35: allow an existing paired extension to publish its negotiated bridge
-- capabilities during authentication. This makes a routine extension update
-- upgrade the server-side device record without forcing a new pairing code.

drop function if exists public.chatgpt_bridge_service_authenticate_device(uuid,text,text);

create or replace function public.chatgpt_bridge_service_authenticate_device(
  p_device_id uuid,
  p_token_hash text,
  p_extension_version text default null,
  p_capabilities jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  if p_capabilities is not null and jsonb_typeof(p_capabilities) <> 'object' then
    raise exception 'Capabilities must be an object';
  end if;

  select * into v_device
    from public.chatgpt_bridge_devices
   where id=p_device_id
     and token_hash=p_token_hash
     and revoked_at is null
   for update;
  if not found then raise exception 'Invalid ChatGPT bridge device credentials'; end if;
  perform private.assert_active_app_membership(v_device.user_id);

  update public.chatgpt_bridge_devices
     set last_seen_at=now(),
         extension_version=coalesce(nullif(left(coalesce(p_extension_version,''),40),''),extension_version),
         capabilities=case
           when p_capabilities is null then capabilities
           else p_capabilities
         end,
         updated_at=now()
   where id=v_device.id
   returning * into v_device;

  return jsonb_build_object(
    'id',v_device.id,
    'user_id',v_device.user_id,
    'display_name',v_device.display_name,
    'platform',v_device.platform,
    'extension_version',v_device.extension_version,
    'capabilities',v_device.capabilities,
    'bound_conversation_url',v_device.bound_conversation_url,
    'bound_project_name',v_device.bound_project_name,
    'bound_project_verified',v_device.bound_project_verified_at is not null,
    'automatic_send_enabled',v_device.automatic_send_enabled,
    'preferred',v_device.preferred,
    'paired_at',v_device.paired_at,
    'last_seen_at',v_device.last_seen_at,
    'conversations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,
      'workflow_key',s.workflow_key,
      'display_name',s.display_name,
      'conversation_url',s.conversation_url,
      'project_name',s.project_name,
      'project_verified',s.project_verified_at is not null,
      'bound_at',s.bound_at,
      'last_used_at',s.last_used_at,
      'last_dispatch_at',s.last_dispatch_at,
      'active',s.active
    ) order by s.display_name)
      from public.chatgpt_bridge_conversation_slots s
     where s.device_id=v_device.id
       and s.active), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.chatgpt_bridge_service_authenticate_device(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_authenticate_device(uuid,text,text,jsonb) to service_role;
