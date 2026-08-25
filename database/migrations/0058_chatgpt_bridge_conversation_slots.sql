-- M28.1: route each opaque ChatGPT dispatch workflow to its own verified
-- Project conversation. Job Hunt remains the system of record, so a slot can
-- be rebound to a fresh conversation without migrating ChatGPT history.

create table if not exists public.chatgpt_bridge_conversation_slots (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.chatgpt_bridge_devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_key text not null check (workflow_key in (
    'job.inspect_url',
    'jobs.search.manual',
    'jobs.analyse_selected',
    'documents.cv.create',
    'documents.cover_letter.create',
    'emails.process_now',
    'tracker.sync_now',
    'bridge.diagnostic'
  )),
  display_name text not null,
  conversation_url text not null,
  project_name text not null check (project_name = 'Job Hunt'),
  project_verified_at timestamptz not null,
  active boolean not null default true,
  bound_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_dispatch_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(device_id, workflow_key),
  unique(device_id, conversation_url)
);

create index if not exists chatgpt_bridge_conversation_slots_user_idx
  on public.chatgpt_bridge_conversation_slots(user_id, device_id, active, workflow_key);
create index if not exists chatgpt_bridge_conversation_slots_device_use_idx
  on public.chatgpt_bridge_conversation_slots(device_id, active, last_used_at desc nulls last);

alter table public.chatgpt_bridge_conversation_slots enable row level security;
revoke all on public.chatgpt_bridge_conversation_slots from public, anon, authenticated;
grant select, insert, update, delete on public.chatgpt_bridge_conversation_slots to service_role;
drop policy if exists chatgpt_bridge_conversation_slots_no_direct_client_access on public.chatgpt_bridge_conversation_slots;
create policy chatgpt_bridge_conversation_slots_no_direct_client_access on public.chatgpt_bridge_conversation_slots
  as restrictive for all to authenticated using (false) with check (false);

create or replace function private.chatgpt_bridge_workflow(p_workflow_key text)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if coalesce(p_workflow_key,'') not in (
    'job.inspect_url',
    'jobs.search.manual',
    'jobs.analyse_selected',
    'documents.cv.create',
    'documents.cover_letter.create',
    'emails.process_now',
    'tracker.sync_now',
    'bridge.diagnostic'
  ) then
    raise exception 'Unsupported ChatGPT bridge workflow';
  end if;
  return jsonb_build_object(
    'workflow_key',p_workflow_key,
    'display_name',case p_workflow_key
      when 'job.inspect_url' then 'Job inspection'
      when 'jobs.search.manual' then 'Job search'
      when 'jobs.analyse_selected' then 'Job analysis'
      when 'documents.cv.create' then 'CV drafting'
      when 'documents.cover_letter.create' then 'Cover-letter drafting'
      when 'emails.process_now' then 'Email processing'
      when 'tracker.sync_now' then 'Tracker sync'
      when 'bridge.diagnostic' then 'Bridge diagnostic'
    end
  );
end;
$$;
revoke all on function private.chatgpt_bridge_workflow(text) from public, anon, authenticated;

create or replace function private.chatgpt_bridge_workflow_key(p_action_type text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if coalesce(p_action_type,'') in (
    'job.inspect_url',
    'jobs.search.manual',
    'jobs.analyse_selected',
    'documents.cv.create',
    'documents.cover_letter.create',
    'emails.process_now',
    'tracker.sync_now',
    'bridge.diagnostic'
  ) then
    return p_action_type;
  end if;
  return null;
end;
$$;
revoke all on function private.chatgpt_bridge_workflow_key(text) from public, anon, authenticated;

-- Preserve the one legacy binding as a diagnostic slot. New dispatches never
-- use the legacy device columns; users can replace this slot or bind the
-- remaining workflow slots from the extension popup.
insert into public.chatgpt_bridge_conversation_slots(
  device_id,user_id,workflow_key,display_name,conversation_url,project_name,project_verified_at
)
select d.id,d.user_id,'bridge.diagnostic','Bridge diagnostic',d.bound_conversation_url,'Job Hunt',d.bound_project_verified_at
  from public.chatgpt_bridge_devices d
 where d.bound_conversation_url is not null
   and d.bound_project_name='Job Hunt'
   and d.bound_project_verified_at is not null
on conflict (device_id,workflow_key) do nothing;

create or replace function public.get_chatgpt_bridge_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_memory jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select to_jsonb(m) into v_memory
    from public.candidate_chatgpt_memory m
    join public.candidate_profiles p on p.id=m.profile_id
   where p.user_id=v_user;
  return jsonb_build_object(
    'memory',coalesce(v_memory,jsonb_build_object('memory_enabled_user_confirmed',false)),
    'devices',coalesce((select jsonb_agg(jsonb_build_object(
      'id',d.id,'display_name',d.display_name,'platform',d.platform,'extension_version',d.extension_version,
      'capabilities',d.capabilities,'bound_conversation_url',d.bound_conversation_url,'bound_project_name',d.bound_project_name,
      'bound_project_verified',d.bound_project_verified_at is not null,'automatic_send_enabled',d.automatic_send_enabled,'preferred',d.preferred,
      'paired_at',d.paired_at,'last_seen_at',d.last_seen_at,'online',coalesce(d.last_seen_at > now()-interval '90 seconds',false),
      'conversations',coalesce((select jsonb_agg(jsonb_build_object(
        'id',s.id,'workflow_key',s.workflow_key,'display_name',s.display_name,'conversation_url',s.conversation_url,
        'project_name',s.project_name,'project_verified',s.project_verified_at is not null,'bound_at',s.bound_at,
        'last_used_at',s.last_used_at,'last_dispatch_at',s.last_dispatch_at,'active',s.active
      ) order by s.display_name) from public.chatgpt_bridge_conversation_slots s where s.device_id=d.id and s.active),'[]'::jsonb)
    ) order by d.preferred desc,d.last_seen_at desc nulls last,d.paired_at desc) from public.chatgpt_bridge_devices d where d.user_id=v_user and d.revoked_at is null),'[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_chatgpt_bridge_status() from public, anon;
grant execute on function public.get_chatgpt_bridge_status() to authenticated;

create or replace function public.chatgpt_bridge_service_authenticate_device(
  p_device_id uuid,
  p_token_hash text,
  p_extension_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_device public.chatgpt_bridge_devices;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and token_hash=p_token_hash and revoked_at is null for update;
  if not found then raise exception 'Invalid ChatGPT bridge device credentials'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  update public.chatgpt_bridge_devices set last_seen_at=now(),extension_version=coalesce(nullif(left(coalesce(p_extension_version,''),40),''),extension_version),updated_at=now() where id=v_device.id returning * into v_device;
  return jsonb_build_object(
    'id',v_device.id,'user_id',v_device.user_id,'display_name',v_device.display_name,'platform',v_device.platform,
    'extension_version',v_device.extension_version,'capabilities',v_device.capabilities,'bound_conversation_url',v_device.bound_conversation_url,
    'bound_project_name',v_device.bound_project_name,'bound_project_verified',v_device.bound_project_verified_at is not null,
    'automatic_send_enabled',v_device.automatic_send_enabled,'preferred',v_device.preferred,'paired_at',v_device.paired_at,'last_seen_at',v_device.last_seen_at,
    'conversations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'workflow_key',s.workflow_key,'display_name',s.display_name,'conversation_url',s.conversation_url,
      'project_name',s.project_name,'project_verified',s.project_verified_at is not null,'bound_at',s.bound_at,
      'last_used_at',s.last_used_at,'last_dispatch_at',s.last_dispatch_at,'active',s.active
    ) order by s.display_name) from public.chatgpt_bridge_conversation_slots s where s.device_id=v_device.id and s.active),'[]'::jsonb)
  );
end;
$$;

drop function if exists public.chatgpt_bridge_service_claim_dispatch(uuid);
create or replace function public.chatgpt_bridge_service_claim_dispatch(
  p_device_id uuid,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_slot public.chatgpt_bridge_conversation_slots;
  v_workflow_key text;
  v_lease text;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null for update;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  if not v_device.automatic_send_enabled then
    return jsonb_build_object('request',null,'ready',false,'reason','automatic_send_disabled');
  end if;
  if not exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=p_device_id and s.active and s.project_verified_at is not null) then
    return jsonb_build_object('request',null,'ready',false,'reason','conversation_slot_not_bound');
  end if;
  update public.chatgpt_dispatch_requests
     set state='expired',user_required_at=coalesce(user_required_at,now()),error_json=coalesce(error_json,jsonb_build_object('code','expired','message','Dispatch request expired before browser delivery.')),updated_at=now()
   where user_id=v_device.user_id and state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready') and expires_at<=now();
  update public.chatgpt_dispatch_requests
     set state='expired',failed_at=null,user_required_at=now(),error_json=jsonb_build_object('code','retry_limit','message','The dispatch reached its bounded delivery retry limit.'),updated_at=now()
   where user_id=v_device.user_id and state='queued' and attempt_count>=5 and expires_at>now();
  update public.job_url_inspection_requests set status='user_required',error_json=jsonb_build_object('code','expired','message','The ChatGPT bridge dispatch expired before delivery.'),updated_at=now()
   where user_id=v_device.user_id and status in ('queued','processing') and id in (select (r.subject_refs->>'inspection_id')::uuid from public.chatgpt_dispatch_requests r where r.user_id=v_device.user_id and r.action_type='job.inspect_url' and r.state='expired' and r.subject_refs ? 'inspection_id');
  select * into v_request
    from public.chatgpt_dispatch_requests r
   where r.user_id=v_device.user_id
     and r.state='queued'
     and (p_request_id is null or r.id=p_request_id)
     and r.expires_at>now()
     and r.attempt_count<5
     and (r.target_device_id is null or r.target_device_id=p_device_id or not exists(select 1 from public.chatgpt_bridge_devices d where d.id=r.target_device_id and d.revoked_at is null))
     and exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=p_device_id and s.workflow_key=private.chatgpt_bridge_workflow_key(r.action_type) and s.active and s.project_verified_at is not null)
   order by r.priority desc,r.created_at
   for update skip locked limit 1;
  if not found then return jsonb_build_object('request',null); end if;
  v_workflow_key := private.chatgpt_bridge_workflow_key(v_request.action_type);
  select * into v_slot from public.chatgpt_bridge_conversation_slots s where s.device_id=p_device_id and s.workflow_key=v_workflow_key and s.active and s.project_verified_at is not null for update;
  if not found then return jsonb_build_object('request',null,'ready',false,'reason','conversation_slot_not_bound','workflow_key',v_workflow_key); end if;
  v_lease := private.chatgpt_urlsafe_token();
  update public.chatgpt_dispatch_requests
     set state='claimed_by_extension',target_device_id=p_device_id,attempt_count=attempt_count+1,lease_owner=p_device_id::text,
         lease_token_hash=private.chatgpt_token_hash(v_lease),lease_expires_at=now()+interval '5 minutes',claimed_at=coalesce(claimed_at,now()),
         progress_json=jsonb_build_object('stage','claimed_by_extension','workflow_key',v_workflow_key),updated_at=now()
   where id=v_request.id
   returning * into v_request;
  update public.chatgpt_bridge_conversation_slots set last_used_at=now(),last_dispatch_at=now(),updated_at=now() where id=v_slot.id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_device.user_id,'system','chatgpt-bridge','chatgpt_bridge.dispatch_claimed','chatgpt_dispatch_request',v_request.id,jsonb_build_object('correlation_id',v_request.correlation_id,'device_id',v_device.id,'workflow_key',v_workflow_key,'attempt_count',v_request.attempt_count));
  return jsonb_build_object('request',jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,'action_version',v_request.action_version,
    'display_title',v_request.display_title,'instruction',v_request.manual_instruction,'correlation_id',v_request.correlation_id,
    'workflow_key',v_slot.workflow_key,'workflow_display_name',v_slot.display_name,
    'bound_conversation_url',v_slot.conversation_url,'bound_project_name',v_slot.project_name,
    'bound_project_verified',v_slot.project_verified_at is not null,'automatic_send_enabled',v_device.automatic_send_enabled,
    'lease_expires_at',v_request.lease_expires_at,'lease_token',v_lease
  ));
end;
$$;

drop function if exists public.chatgpt_bridge_service_bind_conversation(uuid,text,text,boolean);
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
  if not coalesce(p_project_verified,false) or p_project_name <> 'Job Hunt' then raise exception 'The visible ChatGPT Project must be verified as Job Hunt'; end if;
  if length(coalesce(p_conversation_url,''))>2000 or p_conversation_url !~ '^https://(chatgpt[.]com|chat[.]openai[.]com)/[^[:space:]?#]+$' then raise exception 'The bound conversation URL is not a supported ChatGPT conversation URL'; end if;
  if exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=p_device_id and s.workflow_key<>p_workflow_key and s.conversation_url=p_conversation_url and s.active) then
    raise exception 'This conversation is already bound to another workflow slot; use a different ChatGPT conversation';
  end if;
  insert into public.chatgpt_bridge_conversation_slots(
    device_id,user_id,workflow_key,display_name,conversation_url,project_name,project_verified_at,active,bound_at,updated_at
  ) values(
    v_device.id,v_device.user_id,p_workflow_key,v_workflow->>'display_name',p_conversation_url,'Job Hunt',now(),true,now(),now()
  )
  on conflict (device_id,workflow_key) do update set
    display_name=excluded.display_name,conversation_url=excluded.conversation_url,project_name=excluded.project_name,
    project_verified_at=excluded.project_verified_at,active=true,bound_at=now(),last_used_at=null,last_dispatch_at=null,updated_at=now()
  returning * into v_slot;
  update public.chatgpt_bridge_devices
     set bound_conversation_url=v_slot.conversation_url,bound_project_name=v_slot.project_name,bound_project_verified_at=v_slot.project_verified_at,
         automatic_send_enabled=false,updated_at=now()
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

create or replace function public.chatgpt_bridge_service_set_automatic_send(p_device_id uuid,p_enabled boolean)
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
  if p_enabled and not exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=v_device.id and s.active and s.project_verified_at is not null) then
    raise exception 'Bind and verify at least one Job Hunt workflow conversation before enabling automatic Send';
  end if;
  update public.chatgpt_bridge_devices set automatic_send_enabled=coalesce(p_enabled,false),updated_at=now() where id=v_device.id returning * into v_device;
  return jsonb_build_object(
    'id',v_device.id,'automatic_send_enabled',v_device.automatic_send_enabled,
    'bound_project_verified',exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=v_device.id and s.active and s.project_verified_at is not null),
    'conversation_count',(select count(*) from public.chatgpt_bridge_conversation_slots s where s.device_id=v_device.id and s.active)
  );
end;
$$;

revoke all on function public.chatgpt_bridge_service_pair_device(text,text,text,text,text,jsonb),public.chatgpt_bridge_service_authenticate_device(uuid,text,text),public.chatgpt_bridge_service_claim_dispatch(uuid,uuid),public.chatgpt_bridge_service_update_dispatch(uuid,uuid,text,text,jsonb,jsonb),public.chatgpt_bridge_service_retry_dispatch(uuid,uuid),public.chatgpt_bridge_service_bind_conversation(uuid,text,text,text,boolean),public.chatgpt_bridge_service_set_automatic_send(uuid,boolean),public.chatgpt_bridge_service_prefer_device(uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_pair_device(text,text,text,text,text,jsonb),public.chatgpt_bridge_service_authenticate_device(uuid,text,text),public.chatgpt_bridge_service_claim_dispatch(uuid,uuid),public.chatgpt_bridge_service_update_dispatch(uuid,uuid,text,text,jsonb,jsonb),public.chatgpt_bridge_service_retry_dispatch(uuid,uuid),public.chatgpt_bridge_service_bind_conversation(uuid,text,text,text,boolean),public.chatgpt_bridge_service_set_automatic_send(uuid,boolean),public.chatgpt_bridge_service_prefer_device(uuid) to service_role;

comment on table public.chatgpt_bridge_conversation_slots is 'One verified Job Hunt Project conversation per bridge workflow; rebinding rotates only that workflow slot.';
