-- M34: make the activation button resumable after an ambiguous browser
-- delivery. An activation retry is an explicit user action, but an ambiguous
-- message must be checked read-only before the bridge is allowed to send any
-- new message. Dependent profile parts are re-queued only after the source
-- part has been recovered or completed.

create or replace function public.resume_professional_background_activation(
  p_request_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_device uuid;
  v_ids uuid[] := coalesce(p_request_ids, '{}'::uuid[]);
  v_resumed uuid[] := '{}'::uuid[];
  v_response_check uuid[] := '{}'::uuid[];
  v_request public.chatgpt_dispatch_requests;
  v_error_code text;
  v_stage text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if cardinality(v_ids) > 50 then raise exception 'Too many activation dispatches'; end if;
  if exists (
    select 1
      from unnest(v_ids) as requested(request_id)
     where requested.request_id is null
        or not exists (
          select 1
            from public.chatgpt_dispatch_requests r
           where r.id=requested.request_id
             and r.user_id=v_user
             and r.action_type='profile.background'
             and r.idempotency_key like 'profile.activation.memory:v2:part:%'
        )
  ) then
    raise exception 'Activation recovery received an invalid profile dispatch';
  end if;

  select d.id into v_device
    from public.chatgpt_bridge_devices d
   where d.user_id=v_user and d.revoked_at is null and d.preferred
   order by d.last_seen_at desc nulls last
   limit 1;

  for v_request in
    select r.*
      from public.chatgpt_dispatch_requests r
     where r.user_id=v_user
       and r.id=any(v_ids)
       and r.sent_at is null
       and r.state in ('user_required','failed','expired')
     order by r.created_at
     for update
  loop
    v_error_code := lower(coalesce(v_request.error_json->>'code',''));
    v_stage := lower(coalesce(v_request.progress_json->>'stage',''));

    if v_error_code in ('delivery_uncertain','response_capture_failed','response_not_captured','response_not_ready')
       or v_stage in ('delivery_uncertain','requeued_for_response_check') then
      update public.chatgpt_dispatch_requests
         set state='queued',
             target_device_id=v_device,
             lease_owner=null,
             lease_token_hash=null,
             lease_expires_at=null,
             user_required_at=null,
             failed_at=null,
             error_json=null,
             expires_at=greatest(expires_at,now()+interval '24 hours'),
             progress_json=jsonb_build_object(
               'stage','requeued_for_response_check',
               'response_check_only',true,
               'previous_error_code',nullif(v_error_code,'')
             ),
             updated_at=now()
       where id=v_request.id;
      v_response_check := array_append(v_response_check,v_request.id);
    else
      update public.chatgpt_dispatch_requests
         set state='queued',
             target_device_id=v_device,
             lease_owner=null,
             lease_token_hash=null,
             lease_expires_at=null,
             user_required_at=null,
             failed_at=null,
             error_json=null,
             expires_at=greatest(expires_at,now()+interval '24 hours'),
             progress_json=jsonb_build_object(
               'stage','requeued_by_activation',
               'response_check_only',false,
               'previous_error_code',nullif(v_error_code,'')
             ),
             updated_at=now()
       where id=v_request.id;
      v_resumed := array_append(v_resumed,v_request.id);
    end if;
  end loop;

  if cardinality(v_resumed)+cardinality(v_response_check)>0 then
    insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(
      v_user,'user',v_user::text,'chatgpt_bridge.activation_resumed',
      'user',v_user,
      jsonb_build_object(
        'resumed_ids',to_jsonb(v_resumed),
        'response_check_ids',to_jsonb(v_response_check),
        'device_id',v_device
      )
    );
  end if;

  return jsonb_build_object(
    'resumed_ids',to_jsonb(v_resumed),
    'response_check_ids',to_jsonb(v_response_check),
    'resumed_count',cardinality(v_resumed),
    'response_check_count',cardinality(v_response_check)
  );
end;
$$;

revoke all on function public.resume_professional_background_activation(uuid[]) from public, anon;
grant execute on function public.resume_professional_background_activation(uuid[]) to authenticated;

-- Carry the read-only recovery marker through the service claim response.
-- The extension uses this field to choose CHECK_EXISTING_DISPATCH_RESPONSE;
-- it never infers recovery mode from a user-visible title.
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
         progress_json=jsonb_build_object('stage','claimed_by_extension','workflow_key',v_workflow_key,'response_check_only',coalesce((v_request.progress_json->>'response_check_only')::boolean,false)),updated_at=now()
   where id=v_request.id
   returning * into v_request;
  update public.chatgpt_bridge_conversation_slots set last_used_at=now(),last_dispatch_at=now(),updated_at=now() where id=v_slot.id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_device.user_id,'system','chatgpt-bridge','chatgpt_bridge.dispatch_claimed','chatgpt_dispatch_request',v_request.id,jsonb_build_object('correlation_id',v_request.correlation_id,'device_id',v_device.id,'workflow_key',v_workflow_key,'attempt_count',v_request.attempt_count,'response_check_only',coalesce((v_request.progress_json->>'response_check_only')::boolean,false)));
  return jsonb_build_object('request',jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,'action_version',v_request.action_version,
    'display_title',v_request.display_title,'instruction',v_request.manual_instruction,'correlation_id',v_request.correlation_id,
    'workflow_key',v_slot.workflow_key,'workflow_display_name',v_slot.display_name,
    'bound_conversation_url',v_slot.conversation_url,'bound_project_name',v_slot.project_name,
    'bound_project_verified',v_slot.project_verified_at is not null,'automatic_send_enabled',v_device.automatic_send_enabled,
    'depends_on_request_ids',coalesce(v_request.depends_on_request_ids,'{}'::uuid[]),
    'response_check_only',coalesce((v_request.progress_json->>'response_check_only')::boolean,false),
    'lease_expires_at',v_request.lease_expires_at,'lease_token',v_lease
  ));
end;
$$;

revoke all on function public.chatgpt_bridge_service_claim_dispatch(uuid,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_claim_dispatch(uuid,uuid) to service_role;
