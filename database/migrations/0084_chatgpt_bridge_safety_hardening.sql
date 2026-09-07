-- M29: close the remaining v2 retry, recovery-ticket, and send-boundary gaps.
-- This migration is intentionally additive: already-applied v1 functions remain
-- available, while the latest definitions fence ambiguous v2 deliveries.

create or replace function public.retry_chatgpt_dispatch_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.chatgpt_dispatch_requests;
  v_target uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_user
   for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.sent_at is not null
     or v_request.send_attempted_at is not null
     or v_request.delivery_turn_anchor is not null then
    raise exception 'A dispatch that reached the ChatGPT Send boundary cannot be retried; inspect the bound conversation first';
  end if;
  if coalesce(v_request.progress_json->>'protocol','v1') <> 'v2'
     and v_request.state='user_required'
     and coalesce(v_request.error_json->>'code','') in ('delivery_uncertain','delivery_lease_expired','delivery_ambiguous') then
    raise exception 'A legacy dispatch with ambiguous delivery cannot be retried automatically; inspect the bound conversation first';
  end if;
  if v_request.state not in ('user_required','failed','expired') then
    if v_request.state='queued' then return jsonb_build_object('id',v_request.id,'state','queued','idempotent',true); end if;
    raise exception 'Only a pre-delivery dispatch can be explicitly retried';
  end if;
  if v_request.attempt_count >= 5 then raise exception 'The dispatch reached its bounded retry limit'; end if;
  select id into v_target
    from public.chatgpt_bridge_devices
   where user_id=v_user and revoked_at is null and preferred
   order by last_seen_at desc nulls last
   limit 1;
  update public.chatgpt_dispatch_requests
     set state='queued',
         target_device_id=v_target,
         available_at=now(),
         expires_at=greatest(
           v_request.expires_at,
           now()+make_interval(secs=>least(greatest(coalesce(v_request.timeout_seconds,900),60),86400))
         ),
         lease_owner=null,
         lease_token_hash=null,
         lease_expires_at=null,
         delivery_attempt_id=null,
         delivery_deadline_at=null,
         send_attempted_at=null,
         sent_confirmed_at=null,
         response_deadline_at=null,
         response_hash=null,
         response_length=null,
         delivery_turn_anchor=null,
         delivery_user_turn_fingerprint=null,
         delivery_user_turn_message_id=null,
         claimed_at=null,
         acknowledged_at=null,
         running_at=null,
         user_required_at=null,
         failed_at=null,
         error_json=null,
         progress_json=jsonb_build_object('stage','requeued_by_user') || case when v_request.progress_json->>'protocol'='v2' then jsonb_build_object('protocol','v2') else '{}'::jsonb end,
         updated_at=now()
   where id=v_request.id
   returning * into v_request;
  if v_request.action_type='job.inspect_url' and (v_request.subject_refs ? 'inspection_id') then
    update public.job_url_inspection_requests
       set status='queued',error_json=null,updated_at=now()
     where id=(v_request.subject_refs->>'inspection_id')::uuid
       and user_id=v_user
       and status in ('failed','user_required','processing');
  end if;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'chatgpt_bridge.dispatch_retried','chatgpt_dispatch_request',v_request.id,
    jsonb_build_object('correlation_id',v_request.correlation_id,'attempt_count',v_request.attempt_count,'protocol','v2'));
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'attempt_count',v_request.attempt_count,'idempotent',false);
end;
$$;
revoke all on function public.retry_chatgpt_dispatch_request(uuid) from public, anon;
grant execute on function public.retry_chatgpt_dispatch_request(uuid) to authenticated;

create or replace function public.chatgpt_bridge_service_retry_dispatch(p_device_id uuid,p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
begin
  if coalesce((select auth.jwt()->>'role'),'') <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device
    from public.chatgpt_bridge_devices
   where id=p_device_id and revoked_at is null
   for update;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_device.user_id
   for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.sent_at is not null
     or v_request.send_attempted_at is not null
     or v_request.delivery_turn_anchor is not null then
    raise exception 'A dispatch that reached the ChatGPT Send boundary cannot be retried; inspect the bound conversation first';
  end if;
  if coalesce(v_request.progress_json->>'protocol','v1') <> 'v2'
     and v_request.state='user_required'
     and coalesce(v_request.error_json->>'code','') in ('delivery_uncertain','delivery_lease_expired','delivery_ambiguous') then
    raise exception 'A legacy dispatch with ambiguous delivery cannot be retried automatically; inspect the bound conversation first';
  end if;
  if v_request.state not in ('user_required','failed','expired') then
    if v_request.state='queued' then return jsonb_build_object('id',v_request.id,'state','queued','idempotent',true); end if;
    raise exception 'Only a pre-delivery dispatch can be explicitly retried';
  end if;
  if v_request.attempt_count >= 5 then raise exception 'The dispatch reached its bounded retry limit'; end if;
  update public.chatgpt_dispatch_requests
     set state='queued',
         target_device_id=v_device.id,
         available_at=now(),
         expires_at=greatest(
           v_request.expires_at,
           now()+make_interval(secs=>least(greatest(coalesce(v_request.timeout_seconds,900),60),86400))
         ),
         lease_owner=null,
         lease_token_hash=null,
         lease_expires_at=null,
         delivery_attempt_id=null,
         delivery_deadline_at=null,
         send_attempted_at=null,
         sent_confirmed_at=null,
         response_deadline_at=null,
         response_hash=null,
         response_length=null,
         delivery_turn_anchor=null,
         delivery_user_turn_fingerprint=null,
         delivery_user_turn_message_id=null,
         claimed_at=null,
         acknowledged_at=null,
         running_at=null,
         user_required_at=null,
         failed_at=null,
         error_json=null,
         progress_json=jsonb_build_object('stage','requeued_by_extension') || case when v_request.progress_json->>'protocol'='v2' then jsonb_build_object('protocol','v2') else '{}'::jsonb end,
         updated_at=now()
   where id=v_request.id
   returning * into v_request;
  if v_request.action_type='job.inspect_url' and (v_request.subject_refs ? 'inspection_id') then
    update public.job_url_inspection_requests
       set status='queued',error_json=null,updated_at=now()
     where id=(v_request.subject_refs->>'inspection_id')::uuid
       and user_id=v_device.user_id
       and status in ('failed','user_required','processing');
  end if;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_device.user_id,'system','chatgpt-bridge','chatgpt_bridge.dispatch_retried','chatgpt_dispatch_request',v_request.id,
    jsonb_build_object('correlation_id',v_request.correlation_id,'device_id',v_device.id,'attempt_count',v_request.attempt_count,'protocol','v2'));
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'attempt_count',v_request.attempt_count,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_retry_dispatch(uuid,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_retry_dispatch(uuid,uuid) to service_role;

-- Response checks are a separate, read-only creation boundary. The general
-- profile.background creator intentionally accepts no subject references;
-- this function validates the linked source and then records the one allowed
-- response_check_for reference server-side.
create or replace function public.create_chatgpt_response_check_dispatch(
  p_source_request_id uuid,
  p_website_instruction text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_source public.chatgpt_dispatch_requests;
  v_result jsonb;
  v_request public.chatgpt_dispatch_requests;
  v_instruction text := nullif(btrim(p_website_instruction),'');
  v_title constant text := 'Check completed professional profile response';
  v_key text := 'profile.memory.response-check:'||p_source_request_id::text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_source_request_id is null then raise exception 'A source dispatch is required'; end if;
  if v_instruction is null or length(v_instruction)>6000 then raise exception 'Website Bridge instruction is invalid'; end if;
  if v_instruction ~* '(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)' then raise exception 'Website Bridge instruction must be a plain-language task'; end if;
  if p_idempotency_key is distinct from v_key then raise exception 'The response-check idempotency key must match its source dispatch'; end if;
  select * into v_source
    from public.chatgpt_dispatch_requests
   where id=p_source_request_id and user_id=v_user
   for update;
  if not found then raise exception 'Source dispatch not found'; end if;
  if v_source.action_type <> 'profile.background' then raise exception 'Only a professional-background dispatch can be checked'; end if;
  if coalesce((v_source.progress_json->>'response_check_only')::boolean,false) is true then raise exception 'A response-check ticket cannot create another response-check ticket'; end if;
  if v_instruction is distinct from nullif(btrim(coalesce(v_source.website_instruction,v_source.manual_instruction,'')),'') then raise exception 'The response-check instruction must match its source dispatch'; end if;
  if v_source.state not in ('user_required','sent') then raise exception 'The source dispatch is not eligible for a response check'; end if;
  if v_source.bridge_response is not null or v_source.completed_at is not null then raise exception 'The source dispatch already has a completed response'; end if;
  if v_source.delivery_turn_anchor is null then raise exception 'The source dispatch has no durable exact-turn anchor and requires manual review'; end if;
  if v_source.state='user_required' and coalesce(v_source.error_json->>'code','') not in ('response_not_captured','response_capture_failed','delivery_uncertain','delivery_lease_expired','delivery_ambiguous','response_capture_timeout') then
    raise exception 'The source dispatch did not stop at an eligible response boundary';
  end if;

  v_result := public.create_chatgpt_dispatch_request(
    'profile.background','{}'::jsonb,'user_click',v_title,v_key,80
  );
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=(v_result->>'id')::uuid and user_id=v_user
   for update;
  if not found then raise exception 'Response-check dispatch was not created'; end if;
  if v_result->>'idempotent' = 'true' and (v_request.subject_refs->>'response_check_for') is distinct from p_source_request_id::text then
    raise exception 'The response-check idempotency key belongs to another source dispatch';
  end if;
  update public.chatgpt_dispatch_requests
     set subject_refs=jsonb_build_object('response_check_for',p_source_request_id),
         website_instruction=v_instruction,
         manual_instruction=v_instruction,
         progress_json=jsonb_build_object('stage','queued','protocol','v2','response_check_only',true,'response_check_for',p_source_request_id),
         updated_at=now()
   where id=v_request.id
   returning * into v_request;
  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,
    'action_version',v_request.action_version,'display_title',v_request.display_title,
    'idempotency_key',v_request.idempotency_key,'correlation_id',v_request.correlation_id,
    'website_instruction',v_request.website_instruction,'manual_instruction',v_request.manual_instruction,
    'mcp_fallback_instruction',coalesce(v_request.mcp_fallback_instruction,private.chatgpt_build_mcp_fallback_instruction(v_request.id)),
    'progress',v_request.progress_json,'error',v_request.error_json,'output_refs',v_request.output_refs,
    'bridge_response',v_request.bridge_response,'bridge_response_at',v_request.bridge_response_at,
    'created_at',v_request.created_at,'updated_at',v_request.updated_at,
    'idempotent',coalesce((v_result->>'idempotent')::boolean,false)
  );
end;
$$;
revoke all on function public.create_chatgpt_response_check_dispatch(uuid,text,text) from public, anon;
grant execute on function public.create_chatgpt_response_check_dispatch(uuid,text,text) to authenticated;

-- Consume the one-time Send fence and persist the rendered turn boundary in a
-- single transaction. A worker that disappears after this RPC can be resumed
-- only through the exact-turn, read-only reconciliation path below.
create or replace function public.chatgpt_bridge_service_authorize_send_v2(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_attempt_id uuid,
  p_turn_anchor jsonb,
  p_user_turn_fingerprint text default null,
  p_user_turn_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
begin
  if coalesce((select auth.jwt()->>'role'),'') <> 'service_role' then raise exception 'Service role required'; end if;
  if p_turn_anchor is null or jsonb_typeof(p_turn_anchor) <> 'object' then raise exception 'A durable ChatGPT turn anchor is required before Send'; end if;
  if length(p_turn_anchor::text)>4000 then raise exception 'The dispatch turn anchor is too large'; end if;
  if exists(
    select 1 from jsonb_object_keys(p_turn_anchor) key
     where key not in ('conversationUrl','turnCount','lastUserFingerprint','lastAssistantFingerprint','lastUserMessageId','lastAssistantMessageId','artifactCount')
  ) then raise exception 'The dispatch turn anchor contains an unsupported field'; end if;
  if length(coalesce(p_turn_anchor->>'conversationUrl',''))<1 or length(coalesce(p_turn_anchor->>'conversationUrl',''))>500 then raise exception 'The dispatch turn anchor conversation URL is invalid'; end if;
  if coalesce(jsonb_typeof(p_turn_anchor->'turnCount'),'missing') <> 'number' then raise exception 'The dispatch turn anchor turn count is invalid'; end if;
  if (p_turn_anchor->>'turnCount')::numeric < 0 or (p_turn_anchor->>'turnCount')::numeric > 10000 or trunc((p_turn_anchor->>'turnCount')::numeric) <> (p_turn_anchor->>'turnCount')::numeric then raise exception 'The dispatch turn anchor turn count is invalid'; end if;
  if coalesce(jsonb_typeof(p_turn_anchor->'lastUserFingerprint'),'missing') <> 'string' or coalesce(jsonb_typeof(p_turn_anchor->'lastAssistantFingerprint'),'missing') <> 'string' then raise exception 'The dispatch turn anchor fingerprint is invalid'; end if;
  if length(coalesce(p_turn_anchor->>'lastUserFingerprint',''))>200 or length(coalesce(p_turn_anchor->>'lastAssistantFingerprint',''))>200 then raise exception 'The dispatch turn anchor fingerprint is invalid'; end if;
  if (p_turn_anchor ? 'lastUserMessageId' and jsonb_typeof(p_turn_anchor->'lastUserMessageId') not in ('string','null')) or (p_turn_anchor ? 'lastAssistantMessageId' and jsonb_typeof(p_turn_anchor->'lastAssistantMessageId') not in ('string','null')) then raise exception 'The dispatch turn anchor message id is invalid'; end if;
  if length(coalesce(p_turn_anchor->>'lastUserMessageId',''))>300 or length(coalesce(p_turn_anchor->>'lastAssistantMessageId',''))>300 then raise exception 'The dispatch turn anchor message id is invalid'; end if;
  if p_turn_anchor ? 'artifactCount' and jsonb_typeof(p_turn_anchor->'artifactCount') <> 'number' then raise exception 'The dispatch turn anchor artifact count is invalid'; end if;
  if p_turn_anchor ? 'artifactCount' and ((p_turn_anchor->>'artifactCount')::numeric < 0 or (p_turn_anchor->>'artifactCount')::numeric > 1000 or trunc((p_turn_anchor->>'artifactCount')::numeric) <> (p_turn_anchor->>'artifactCount')::numeric) then raise exception 'The dispatch turn anchor artifact count is invalid'; end if;
  if length(coalesce(p_user_turn_fingerprint,''))>200 then raise exception 'The dispatch user fingerprint is too long'; end if;
  if length(coalesce(p_user_turn_message_id,''))>300 then raise exception 'The dispatch message id is too long'; end if;

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
  if v_request.state in ('send_attempted','sent','acknowledged_by_mcp','running','completed','failed','cancelled','expired','user_required') then
    return jsonb_build_object(
      'id',v_request.id,'state',v_request.state,'may_send',false,'idempotent',true,
      'turn_anchor',v_request.delivery_turn_anchor,
      'user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,
      'user_turn_message_id',v_request.delivery_user_turn_message_id
    );
  end if;
  if v_request.state <> 'composer_ready'
     or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.target_device_id is distinct from p_device_id
     or v_request.delivery_deadline_at is null or v_request.delivery_deadline_at<=now()
     or v_request.lease_expires_at is null or v_request.lease_expires_at<=now() then
    raise exception 'Dispatch send authorization is invalid or has expired';
  end if;
  update public.chatgpt_dispatch_requests
     set state='send_attempted',
         send_attempted_at=now(),
         delivery_turn_anchor=p_turn_anchor,
         delivery_user_turn_fingerprint=nullif(btrim(p_user_turn_fingerprint),''),
         delivery_user_turn_message_id=nullif(btrim(p_user_turn_message_id),''),
         progress_json=jsonb_build_object('stage','send_attempted','protocol','v2','delivery_attempt_id',p_attempt_id),
         updated_at=now()
   where id=v_request.id
   returning * into v_request;
  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'may_send',true,'idempotent',false,
    'turn_anchor',v_request.delivery_turn_anchor,
    'user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,
    'user_turn_message_id',v_request.delivery_user_turn_message_id
  );
end;
$$;
revoke all on function public.chatgpt_bridge_service_authorize_send_v2(uuid,uuid,text,uuid,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_authorize_send_v2(uuid,uuid,text,uuid,jsonb,text,text) to service_role;

-- Return only delivery metadata needed to recover a persisted local record.
-- Terminal rows have already cleared their lease hash, so the same bound
-- device and delivery-attempt identity remain the authorization boundary.
create or replace function public.chatgpt_bridge_service_get_dispatch_v2(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
begin
  if coalesce((select auth.jwt()->>'role'),'') <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device
    from public.chatgpt_bridge_devices
   where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_device.user_id;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.target_device_id is distinct from p_device_id
     or v_request.delivery_attempt_id is distinct from p_attempt_id then
    raise exception 'Dispatch recovery identity is invalid';
  end if;
  if v_request.state not in ('completed','failed','cancelled','expired','user_required')
     and v_request.lease_token_hash is distinct from p_lease_token_hash then
    raise exception 'Dispatch recovery lease is invalid';
  end if;
  return jsonb_build_object(
    'id',v_request.id,
    'state',v_request.state,
    'send_attempted',v_request.send_attempted_at is not null,
    'sent_confirmed',v_request.sent_confirmed_at is not null,
    'turn_anchor',v_request.delivery_turn_anchor,
    'user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,
    'user_turn_message_id',v_request.delivery_user_turn_message_id,
    'delivery_deadline_at',v_request.delivery_deadline_at,
    'response_deadline_at',v_request.response_deadline_at,
    'lease_expires_at',v_request.lease_expires_at,
    'response_check_only',coalesce((v_request.progress_json->>'response_check_only')::boolean,false),
    'terminal',v_request.state in ('completed','failed','cancelled','expired','user_required')
  );
end;
$$;
revoke all on function public.chatgpt_bridge_service_get_dispatch_v2(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_get_dispatch_v2(uuid,uuid,text,uuid) to service_role;

-- The authenticated status surface exposes safe delivery facts, never lease
-- tokens or hashes. The webapp can therefore explain retry/recovery choices
-- without reproducing the server's safety policy.
create or replace function public.get_chatgpt_dispatch_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.chatgpt_dispatch_requests;
  v_protocol text;
  v_response_check_available boolean;
  v_retry_allowed boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_user;
  if not found then raise exception 'Dispatch request not found'; end if;

  v_protocol := coalesce(nullif(v_request.progress_json->>'protocol',''),case when v_request.delivery_attempt_id is null then 'v1' else 'v2' end);
  v_response_check_available := v_request.action_type='profile.background'
    and coalesce((v_request.progress_json->>'response_check_only')::boolean,false) is not true
    and v_request.state in ('user_required','sent')
    and v_request.bridge_response is null
    and v_request.completed_at is null
    and v_request.delivery_turn_anchor is not null
    and (
      v_request.state='sent'
      or coalesce(v_request.error_json->>'code','') in ('response_not_captured','response_capture_failed','delivery_uncertain','delivery_lease_expired','delivery_ambiguous','response_capture_timeout')
    );
  v_retry_allowed := v_request.state in ('user_required','failed','expired')
    and v_request.attempt_count<5
    and v_request.sent_at is null
    and v_request.send_attempted_at is null
    and v_request.delivery_turn_anchor is null
    and not (
      v_protocol<>'v2'
      and v_request.state='user_required'
      and coalesce(v_request.error_json->>'code','') in ('delivery_uncertain','delivery_lease_expired','delivery_ambiguous')
    );

  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,
    'action_version',v_request.action_version,'display_title',v_request.display_title,
    'origin',v_request.origin,'subject_refs',v_request.subject_refs,
    'idempotency_key',v_request.idempotency_key,'priority',v_request.priority,
    'confirmation_policy',v_request.confirmation_policy,'allowed_effects',v_request.allowed_effects,
    'required_mcp_tools',v_request.required_mcp_tools,'expected_outputs',v_request.expected_outputs,
    'attempt_count',v_request.attempt_count,'target_device_id',v_request.target_device_id,
    'progress',v_request.progress_json,'output_refs',v_request.output_refs,'error',v_request.error_json,
    'website_instruction',coalesce(v_request.website_instruction,v_request.manual_instruction),
    'manual_instruction',v_request.manual_instruction,
    'mcp_fallback_instruction',coalesce(v_request.mcp_fallback_instruction,private.chatgpt_build_mcp_fallback_instruction(v_request.id)),
    'bridge_response',v_request.bridge_response,'bridge_response_at',v_request.bridge_response_at,
    'correlation_id',v_request.correlation_id,'created_at',v_request.created_at,
    'claimed_at',v_request.claimed_at,'sent_at',v_request.sent_at,
    'send_attempted_at',v_request.send_attempted_at,'sent_confirmed_at',v_request.sent_confirmed_at,
    'protocol',v_protocol,'has_delivery_turn_anchor',v_request.delivery_turn_anchor is not null,
    'response_check_available',v_response_check_available,'retry_allowed',v_retry_allowed,
    'manual_review_required',(v_request.state='user_required' and not v_response_check_available and not v_retry_allowed),
    'delivery_deadline_at',v_request.delivery_deadline_at,'response_deadline_at',v_request.response_deadline_at,
    'acknowledged_at',v_request.acknowledged_at,'running_at',v_request.running_at,
    'completed_at',v_request.completed_at,'user_required_at',v_request.user_required_at,
    'failed_at',v_request.failed_at,'cancelled_at',v_request.cancelled_at,
    'expires_at',v_request.expires_at,'updated_at',v_request.updated_at
  );
end;
$$;
revoke all on function public.get_chatgpt_dispatch_request(uuid) from public, anon;
grant execute on function public.get_chatgpt_dispatch_request(uuid) to authenticated;
