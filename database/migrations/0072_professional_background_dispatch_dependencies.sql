-- M33: make the professional-background flow a real source-first pipeline.
--
-- Source messages and the structured profile request are still ordinary
-- Website Bridge dispatches, but the profile request now records the exact
-- source request IDs it depends on. The bridge may claim the profile request
-- only after every source request has completed successfully.

alter table public.chatgpt_dispatch_requests
  add column if not exists depends_on_request_ids uuid[] not null default '{}'::uuid[];

create index if not exists chatgpt_dispatch_requests_dependencies_idx
  on public.chatgpt_dispatch_requests using gin (depends_on_request_ids);

-- The normal Website Bridge creator remains available to all other workflows.
-- This companion creator adds dependency metadata and can safely upgrade an
-- undelivered source request made by the pre-barrier implementation.
create or replace function public.create_chatgpt_dispatch_request_with_dependencies(
  p_action_type text,
  p_subject_refs jsonb default '{}'::jsonb,
  p_origin text default 'user_click',
  p_display_title text default null,
  p_idempotency_key text default null,
  p_priority integer default 50,
  p_website_instruction text default null,
  p_dependency_request_ids uuid[] default '{}'::uuid[],
  p_legacy_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb := '{}'::jsonb;
  v_request public.chatgpt_dispatch_requests;
  v_legacy public.chatgpt_dispatch_requests;
  v_instruction text := nullif(btrim(p_website_instruction),'');
  v_key text := nullif(btrim(p_idempotency_key),'');
  v_legacy_key text := nullif(btrim(p_legacy_idempotency_key),'');
  v_dependencies uuid[] := coalesce(p_dependency_request_ids,'{}'::uuid[]);
  v_idempotent boolean := false;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_action_type <> 'profile.background' then
    raise exception 'Dependency dispatches are only supported for professional background updates';
  end if;
  if v_key is null then raise exception 'Dependency dispatch idempotency key is required'; end if;
  if v_instruction is null then raise exception 'Website Bridge instruction is required'; end if;
  if p_idempotency_key is not null and (length(p_idempotency_key)<1 or length(p_idempotency_key)>200 or p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$') then
    raise exception 'Invalid dispatch idempotency key';
  end if;
  if p_legacy_idempotency_key is not null and (length(p_legacy_idempotency_key)<1 or length(p_legacy_idempotency_key)>200 or p_legacy_idempotency_key !~ '^[A-Za-z0-9_.:-]+$') then
    raise exception 'Invalid legacy dispatch idempotency key';
  end if;
  if length(v_instruction) > 6000 then raise exception 'Website Bridge instruction is too long'; end if;
  if v_instruction ~* '(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)' then
    raise exception 'Website Bridge instruction must be a plain-language task';
  end if;
  if cardinality(v_dependencies) > 50 then raise exception 'Too many dispatch dependencies'; end if;
  if exists(select 1 from unnest(v_dependencies) as dependency_id where dependency_id is null) then
    raise exception 'Dispatch dependencies cannot contain null IDs';
  end if;
  if exists(select 1 from unnest(v_dependencies) as dependency_id group by dependency_id having count(*) > 1) then
    raise exception 'Dispatch dependencies cannot contain duplicate IDs';
  end if;
  if exists(
    select 1
      from unnest(v_dependencies) as dependency_id
     where not exists(
       select 1 from public.chatgpt_dispatch_requests dependency
        where dependency.id=dependency_id and dependency.user_id=v_user
     )
  ) then
    raise exception 'Every dispatch dependency must belong to the current user';
  end if;

  select * into v_request
    from public.chatgpt_dispatch_requests
   where user_id=v_user and idempotency_key=v_key
   for update;
  if found then
    v_idempotent := true;
  else
    -- The first source-first implementation used one key for both its
    -- context-only and Memory modes. Reuse an old source row only when it is
    -- still queued, or when it already represents a real Memory update. A
    -- sent/completed context-only row is deliberately not reused as proof of
    -- an authorised Memory update.
    if v_legacy_key is not null then
      select * into v_legacy
        from public.chatgpt_dispatch_requests
       where user_id=v_user and idempotency_key=v_legacy_key
       for update;
      if found
         and v_legacy.action_type='profile.background'
         and (
           (v_legacy.state='queued' and v_legacy.display_title like 'Remember source %')
           or coalesce(v_legacy.website_instruction,v_legacy.manual_instruction) ~* 'Update your long-term Memory now'
         ) then
        v_request := v_legacy;
        v_idempotent := true;
        if v_request.state='queued' then
          update public.chatgpt_dispatch_requests
             set idempotency_key=v_key,
                 website_instruction=v_instruction,
                 manual_instruction=v_instruction,
                 updated_at=now()
           where id=v_request.id
           returning * into v_request;
        end if;
      end if;
    end if;
  end if;

  if v_request.id is null then
    v_result := public.create_chatgpt_dispatch_request(
      p_action_type,p_subject_refs,p_origin,p_display_title,p_idempotency_key,p_priority
    );
    select * into v_request
      from public.chatgpt_dispatch_requests
     where id=(v_result->>'id')::uuid and user_id=v_user
     for update;
    if not found then raise exception 'Dispatch request was not created'; end if;
    v_idempotent := coalesce((v_result->>'idempotent')::boolean,false);
  end if;

  if v_request.id = any(v_dependencies) then
    raise exception 'A dispatch cannot depend on itself';
  end if;

  if v_request.state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready') then
    update public.chatgpt_dispatch_requests
       set website_instruction=v_instruction,
           manual_instruction=v_instruction,
           depends_on_request_ids=v_dependencies,
           updated_at=now()
     where id=v_request.id
     returning * into v_request;
  end if;

  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,
    'action_version',v_request.action_version,'display_title',v_request.display_title,
    'idempotency_key',v_request.idempotency_key,'correlation_id',v_request.correlation_id,
    'website_instruction',coalesce(v_request.website_instruction,v_request.manual_instruction),
    'manual_instruction',v_request.manual_instruction,
    'mcp_fallback_instruction',coalesce(v_request.mcp_fallback_instruction,private.chatgpt_build_mcp_fallback_instruction(v_request.id)),
    'depends_on_request_ids',coalesce(v_request.depends_on_request_ids,'{}'::uuid[]),
    'progress',v_request.progress_json,'error',v_request.error_json,'output_refs',v_request.output_refs,
    'bridge_response',v_request.bridge_response,'bridge_response_at',v_request.bridge_response_at,
    'created_at',v_request.created_at,'updated_at',v_request.updated_at,'idempotent',v_idempotent
  );
end;
$$;

revoke all on function public.create_chatgpt_dispatch_request_with_dependencies(text,jsonb,text,text,text,integer,text,uuid[],text) from public, anon;
grant execute on function public.create_chatgpt_dispatch_request_with_dependencies(text,jsonb,text,text,text,integer,text,uuid[],text) to authenticated;

-- Keep the dependency list visible to the onboarding status route and to
-- diagnostics without exposing dispatch rows directly to browser clients.
create or replace function public.get_chatgpt_dispatch_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.chatgpt_dispatch_requests;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_user;
  if not found then raise exception 'Dispatch request not found'; end if;
  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,
    'action_version',v_request.action_version,'display_title',v_request.display_title,
    'origin',v_request.origin,'subject_refs',v_request.subject_refs,
    'idempotency_key',v_request.idempotency_key,'priority',v_request.priority,
    'confirmation_policy',v_request.confirmation_policy,'allowed_effects',v_request.allowed_effects,
    'required_mcp_tools',v_request.required_mcp_tools,'expected_outputs',v_request.expected_outputs,
    'attempt_count',v_request.attempt_count,'target_device_id',v_request.target_device_id,
    'depends_on_request_ids',coalesce(v_request.depends_on_request_ids,'{}'::uuid[]),
    'progress',v_request.progress_json,'output_refs',v_request.output_refs,'error',v_request.error_json,
    'website_instruction',coalesce(v_request.website_instruction,v_request.manual_instruction),
    'manual_instruction',v_request.manual_instruction,
    'mcp_fallback_instruction',coalesce(v_request.mcp_fallback_instruction,private.chatgpt_build_mcp_fallback_instruction(v_request.id)),
    'bridge_response',v_request.bridge_response,'bridge_response_at',v_request.bridge_response_at,
    'correlation_id',v_request.correlation_id,'created_at',v_request.created_at,
    'claimed_at',v_request.claimed_at,'sent_at',v_request.sent_at,
    'acknowledged_at',v_request.acknowledged_at,'running_at',v_request.running_at,
    'completed_at',v_request.completed_at,'user_required_at',v_request.user_required_at,
    'failed_at',v_request.failed_at,'cancelled_at',v_request.cancelled_at,
    'expires_at',v_request.expires_at,'updated_at',v_request.updated_at
  );
end;
$$;
revoke all on function public.get_chatgpt_dispatch_request(uuid) from public, anon;
grant execute on function public.get_chatgpt_dispatch_request(uuid) to authenticated;

-- Replace the slot-aware claim function from M28. Queue priority still helps
-- pick source rows in a natural order, but correctness comes from the
-- dependency checks below.
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

  -- Do not leave a dependent profile request looking queued forever after a
  -- source update has stopped. A later explicit retry can requeue the source
  -- and then the same profile request will be eligible again.
  update public.chatgpt_dispatch_requests dependent
     set state='user_required',
         user_required_at=coalesce(dependent.user_required_at,now()),
         error_json=jsonb_build_object(
           'code','source_memory_update_incomplete',
           'message','The structured profile was held until every source Memory update completed. A source update stopped before completion; retry or review that source update before requesting the profile again.'
         ),
         progress_json=jsonb_build_object('stage','user_required','reason','source_memory_update_incomplete'),
         updated_at=now()
   where dependent.user_id=v_device.user_id
     and dependent.state='queued'
     and cardinality(coalesce(dependent.depends_on_request_ids,'{}'::uuid[]))>0
     and exists(
       select 1
         from unnest(dependent.depends_on_request_ids) as dependency_id
         left join public.chatgpt_dispatch_requests source
           on source.id=dependency_id and source.user_id=dependent.user_id
        where source.id is null or source.state in ('failed','expired','cancelled','user_required')
     );
  update public.chatgpt_work_items w
     set state='user_required',
         user_required_at=coalesce(w.user_required_at,now()),
         error_json=jsonb_build_object('code','source_memory_update_incomplete','message','A source professional-background update did not complete.'),
         updated_at=now()
   where w.id in (
     select dependent.work_item_id
       from public.chatgpt_dispatch_requests dependent
      where dependent.user_id=v_device.user_id
        and dependent.state='user_required'
        and dependent.error_json->>'code'='source_memory_update_incomplete'
        and dependent.work_item_id is not null
   )
     and w.state in ('queued','leased','running','user_required');

  select * into v_request
    from public.chatgpt_dispatch_requests r
   where r.user_id=v_device.user_id
     and r.state='queued'
     and (p_request_id is null or r.id=p_request_id)
     and r.expires_at>now()
     and r.attempt_count<5
     and (r.target_device_id is null or r.target_device_id=p_device_id or not exists(select 1 from public.chatgpt_bridge_devices d where d.id=r.target_device_id and d.revoked_at is null))
     and exists(select 1 from public.chatgpt_bridge_conversation_slots s where s.device_id=p_device_id and s.workflow_key=private.chatgpt_bridge_workflow_key(r.action_type) and s.active and s.project_verified_at is not null)
     and not exists(
       select 1
         from unnest(coalesce(r.depends_on_request_ids,'{}'::uuid[])) as dependency_id
         left join public.chatgpt_dispatch_requests source
           on source.id=dependency_id and source.user_id=r.user_id
        where source.id is null or source.state<>'completed'
     )
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
    'depends_on_request_ids',coalesce(v_request.depends_on_request_ids,'{}'::uuid[]),
    'lease_expires_at',v_request.lease_expires_at,'lease_token',v_lease
  ));
end;
$$;

revoke all on function public.chatgpt_bridge_service_claim_dispatch(uuid,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_claim_dispatch(uuid,uuid) to service_role;

comment on column public.chatgpt_dispatch_requests.depends_on_request_ids is 'Dispatch IDs that must be completed before this request can be claimed; used by the source-first professional-background import.';
