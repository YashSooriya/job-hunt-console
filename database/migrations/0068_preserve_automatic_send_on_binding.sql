-- M32: binding or rotating a workflow conversation must preserve the user's
-- Automatic Send preference. The only operation allowed to change that flag
-- is chatgpt_bridge_service_set_automatic_send, which is called by the
-- explicit extension checkbox action.

create or replace function public.chatgpt_bridge_service_bind_conversation(
  p_device_id uuid,
  p_conversation_url text,
  p_project_name text,
  p_project_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_device public.chatgpt_bridge_devices;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null for update;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  if not coalesce(p_project_verified,false) or p_project_name <> 'JobHuntAI' then raise exception 'The visible ChatGPT Project must be verified as JobHuntAI'; end if;
  if length(coalesce(p_conversation_url,''))>2000 or p_conversation_url !~ '^https://(chatgpt[.]com|chat[.]openai[.]com)/[^[:space:]?#]+$' then raise exception 'The bound conversation URL is not a supported ChatGPT conversation URL'; end if;
  update public.chatgpt_bridge_devices
     set bound_conversation_url=p_conversation_url,bound_project_name='JobHuntAI',bound_project_verified_at=now(),updated_at=now()
   where id=v_device.id
   returning * into v_device;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_device.user_id,'system','chatgpt-bridge','chatgpt_bridge.conversation_bound','chatgpt_bridge_device',v_device.id,jsonb_build_object('project','JobHuntAI','host',split_part(split_part(p_conversation_url,'://',2), '/', 1)));
  return jsonb_build_object('id',v_device.id,'bound_conversation_url',v_device.bound_conversation_url,'bound_project_name',v_device.bound_project_name,'bound_project_verified',true,'automatic_send_enabled',v_device.automatic_send_enabled);
end;
$$;

create or replace function public.chatgpt_bridge_service_bind_conversation(
  p_device_id uuid,
  p_workflow_key text,
  p_conversation_url text,
  p_project_name text,
  p_project_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_workflow jsonb;
  v_slot public.chatgpt_bridge_conversation_slots;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null for update;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  v_workflow := private.chatgpt_bridge_workflow(p_workflow_key);
  if not coalesce(p_project_verified,false) or p_project_name <> 'JobHuntAI' then raise exception 'The visible ChatGPT Project must be verified as JobHuntAI'; end if;
  if length(coalesce(p_conversation_url,''))>2000 or p_conversation_url !~ '^https://(chatgpt[.]com|chat[.]openai[.]com)/[^[:space:]?#]+$' then raise exception 'The bound conversation URL is not a supported ChatGPT conversation URL'; end if;
  if exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=p_device_id and s.workflow_key<>p_workflow_key and s.conversation_url=p_conversation_url and s.active) then
    raise exception 'This conversation is already bound to another workflow slot; use a different ChatGPT conversation';
  end if;
  insert into public.chatgpt_bridge_conversation_slots(
    device_id,user_id,workflow_key,display_name,conversation_url,project_name,project_verified_at,active,bound_at,updated_at
  ) values(
    v_device.id,v_device.user_id,p_workflow_key,v_workflow->>'display_name',p_conversation_url,'JobHuntAI',now(),true,now(),now()
  )
  on conflict (device_id,workflow_key) do update set
    display_name=excluded.display_name,conversation_url=excluded.conversation_url,project_name=excluded.project_name,
    project_verified_at=excluded.project_verified_at,active=true,bound_at=now(),last_used_at=null,last_dispatch_at=null,updated_at=now()
  returning * into v_slot;
  update public.chatgpt_bridge_devices
     set bound_conversation_url=v_slot.conversation_url,bound_project_name=v_slot.project_name,bound_project_verified_at=v_slot.project_verified_at,
         updated_at=now()
   where id=v_device.id
   returning * into v_device;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_device.user_id,'system','chatgpt-bridge','chatgpt_bridge.conversation_bound','chatgpt_bridge_device',v_device.id,jsonb_build_object('workflow_key',v_slot.workflow_key,'project',v_slot.project_name,'host',split_part(split_part(p_conversation_url,'://',2), '/', 1)));
  return jsonb_build_object(
    'id',v_slot.id,'workflow_key',v_slot.workflow_key,'workflow_display_name',v_slot.display_name,
    'conversation_url',v_slot.conversation_url,'project_name',v_slot.project_name,'project_verified',true,
    'bound_at',v_slot.bound_at,'bound_conversation_url',v_slot.conversation_url,'bound_project_name',v_slot.project_name,
    'bound_project_verified',true,'automatic_send_enabled',v_device.automatic_send_enabled,
    'conversation_count',(select count(*) from public.chatgpt_bridge_conversation_slots s where s.device_id=v_device.id and s.active)
  );
end;
$$;

comment on function public.chatgpt_bridge_service_bind_conversation(uuid,text,text,text,boolean)
  is 'Bind or rotate one verified JobHuntAI workflow conversation without changing Automatic Send.';
