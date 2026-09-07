-- M30: preserve the pre-send boundary and reconcile v2 requests after the
-- overall request expiry. These are additive overrides for the v2 protocol.

create or replace function public.chatgpt_bridge_service_reconcile_v2(
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_delivery_expired integer := 0;
  v_response_expired integer := 0;
begin
  if coalesce((select auth.jwt()->>'role'),'') <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device
    from public.chatgpt_bridge_devices
   where id=p_device_id and revoked_at is null
   for update;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);

  -- A v2 request that crossed the delivery lease is ambiguous if the worker
  -- disappeared before it confirmed the visible Send. It must become an
  -- explicit user stop even when the broader request expiry has passed.
  with transitioned as (
    update public.chatgpt_dispatch_requests
       set state='user_required',
           failed_at=null,
           user_required_at=coalesce(user_required_at,now()),
           lease_owner=null,
           lease_token_hash=null,
           lease_expires_at=null,
           error_json=jsonb_build_object('code','delivery_lease_expired','message','The v2 delivery lease expired before Website Bridge delivery could be confirmed. Review the bound ChatGPT conversation before retrying.'),
           progress_json=coalesce(progress_json,'{}'::jsonb)||jsonb_build_object('stage','user_required','code','delivery_lease_expired','protocol','v2'),
           updated_at=now()
     where user_id=v_device.user_id
       and state in ('claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','acknowledged_by_mcp','running')
       and sent_at is null
       and delivery_attempt_id is not null
       and delivery_deadline_at is not null
       and delivery_deadline_at<=now()
     returning id
  )
  select count(*)::integer into v_delivery_expired from transitioned;

  -- A sent request must never remain in sent/running forever merely because
  -- expires_at was also reached. Preserve its durable turn anchor and expose
  -- the bounded capture timeout for manual review or a read-only response
  -- check.
  with transitioned as (
    update public.chatgpt_dispatch_requests
       set state='user_required',
           user_required_at=coalesce(user_required_at,now()),
           lease_owner=null,
           lease_token_hash=null,
           lease_expires_at=null,
           error_json=jsonb_build_object('code','response_capture_timeout','message','The Website Bridge sent this request but its bounded response-capture window ended. Review the bound ChatGPT conversation before retrying.'),
           progress_json=coalesce(progress_json,'{}'::jsonb)||jsonb_build_object('stage','user_required','code','response_capture_timeout','protocol','v2'),
           updated_at=now()
     where user_id=v_device.user_id
       and state in ('sent','acknowledged_by_mcp','running')
       and sent_at is not null
       and response_deadline_at is not null
       and response_deadline_at<=now()
     returning id
  )
  select count(*)::integer into v_response_expired from transitioned;

  update public.job_url_inspection_requests inspection
     set status='user_required',
         error_json=jsonb_build_object('code','delivery_lease_expired','message','The ChatGPT bridge delivery lease expired before this inspection request was confirmed.'),
         updated_at=now()
   where inspection.user_id=v_device.user_id
     and inspection.status in ('queued','processing')
     and exists (
       select 1
         from public.chatgpt_dispatch_requests r
        where r.user_id=v_device.user_id
          and r.action_type='job.inspect_url'
          and r.state='user_required'
          and r.error_json->>'code'='delivery_lease_expired'
          and r.subject_refs ? 'inspection_id'
          and (r.subject_refs->>'inspection_id')::uuid=inspection.id
     );

  update public.job_url_inspection_requests inspection
     set status='user_required',
         error_json=jsonb_build_object('code','response_capture_timeout','message','The ChatGPT bridge sent this inspection request but its response-capture window ended.'),
         updated_at=now()
   where inspection.user_id=v_device.user_id
     and inspection.status in ('queued','processing')
     and exists (
       select 1
         from public.chatgpt_dispatch_requests r
        where r.user_id=v_device.user_id
          and r.action_type='job.inspect_url'
          and r.state='user_required'
          and r.error_json->>'code'='response_capture_timeout'
          and r.subject_refs ? 'inspection_id'
          and (r.subject_refs->>'inspection_id')::uuid=inspection.id
     );

  return jsonb_build_object(
    'protocol','v2',
    'delivery_expired',v_delivery_expired,
    'response_expired',v_response_expired
  );
end;
$$;
revoke all on function public.chatgpt_bridge_service_reconcile_v2(uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_reconcile_v2(uuid) to service_role;

-- The pre-send turn boundary remains authoritative after the click. A later
-- post-send refinement may add the exact rendered user identity, but replacing
-- the boundary with a post-click turnCount would reject message-id-less DOMs.
create or replace function public.chatgpt_bridge_service_record_send_anchor(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_attempt_id uuid,
  p_turn_anchor jsonb default null,
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
  v_anchor jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  if p_turn_anchor is null then raise exception 'A durable ChatGPT turn anchor is required before Send'; end if;
  if jsonb_typeof(p_turn_anchor) <> 'object' then raise exception 'The dispatch turn anchor must be an object'; end if;
  if length(p_turn_anchor::text)>4000 then raise exception 'The dispatch turn anchor is too large'; end if;
  if exists(
    select 1 from jsonb_object_keys(p_turn_anchor) key
     where key not in ('conversationUrl','turnCount','lastUserFingerprint','lastAssistantFingerprint','lastUserMessageId','lastAssistantMessageId','artifactCount')
  ) then raise exception 'The dispatch turn anchor contains an unsupported field'; end if;
  if length(coalesce(p_turn_anchor->>'conversationUrl',''))<1 or length(coalesce(p_turn_anchor->>'conversationUrl',''))>500 then raise exception 'The dispatch turn anchor conversation URL is invalid'; end if;
  if length(coalesce(p_turn_anchor->>'lastUserFingerprint',''))>200 or length(coalesce(p_turn_anchor->>'lastAssistantFingerprint',''))>200 then raise exception 'The dispatch turn anchor fingerprint is invalid'; end if;
  if length(coalesce(p_turn_anchor->>'lastUserMessageId',''))>300 or length(coalesce(p_turn_anchor->>'lastAssistantMessageId',''))>300 then raise exception 'The dispatch turn anchor message id is invalid'; end if;
  if length(coalesce(p_user_turn_fingerprint,'')) > 200 then raise exception 'The dispatch user fingerprint is too long'; end if;
  if length(coalesce(p_user_turn_message_id,'')) > 300 then raise exception 'The dispatch message id is too long'; end if;
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
    return jsonb_build_object('id',v_request.id,'state','completed','idempotent',true,'turn_anchor',v_request.delivery_turn_anchor,'user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,'user_turn_message_id',v_request.delivery_user_turn_message_id);
  end if;
  if v_request.state not in ('send_attempted','sent','acknowledged_by_mcp','running')
     or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.target_device_id is distinct from p_device_id then raise exception 'Dispatch turn anchor lease is invalid'; end if;

  v_anchor := coalesce(v_request.delivery_turn_anchor,p_turn_anchor);
  update public.chatgpt_dispatch_requests
     set delivery_turn_anchor=v_anchor,
         delivery_user_turn_fingerprint=coalesce(nullif(btrim(p_user_turn_fingerprint),''),delivery_user_turn_fingerprint),
         delivery_user_turn_message_id=coalesce(nullif(btrim(p_user_turn_message_id),''),delivery_user_turn_message_id),
         updated_at=now()
   where id=v_request.id
   returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',false,'turn_anchor',v_request.delivery_turn_anchor,'user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,'user_turn_message_id',v_request.delivery_user_turn_message_id);
end;
$$;
revoke all on function public.chatgpt_bridge_service_record_send_anchor(uuid,uuid,text,uuid,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_record_send_anchor(uuid,uuid,text,uuid,jsonb,text,text) to service_role;
