-- M28 delivery v2: durable send authorization, bounded recovery, and
-- capacity-aware claims. The existing v1 RPCs remain available while devices
-- upgrade; v2 devices use the suffixed RPCs below.

alter table public.chatgpt_dispatch_requests
  add column if not exists available_at timestamptz,
  add column if not exists delivery_attempt_id uuid,
  add column if not exists delivery_deadline_at timestamptz,
  add column if not exists send_attempted_at timestamptz,
  add column if not exists sent_confirmed_at timestamptz,
  add column if not exists response_deadline_at timestamptz,
  add column if not exists response_hash text,
  add column if not exists response_length integer,
  add column if not exists delivery_turn_anchor jsonb,
  add column if not exists delivery_user_turn_fingerprint text,
  add column if not exists delivery_user_turn_message_id text;

alter table public.chatgpt_dispatch_requests
  drop constraint if exists chatgpt_dispatch_requests_state_check;
alter table public.chatgpt_dispatch_requests
  add constraint chatgpt_dispatch_requests_state_check check (state in (
    'queued','claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','sent',
    'acknowledged_by_mcp','running','completed','user_required','failed','expired','cancelled'
  ));

create index if not exists chatgpt_dispatch_requests_v2_ready_idx
  on public.chatgpt_dispatch_requests(target_device_id, state, available_at, priority desc, created_at)
  where state = 'queued';
create index if not exists chatgpt_dispatch_requests_v2_attempt_idx
  on public.chatgpt_dispatch_requests(target_device_id, delivery_attempt_id)
  where delivery_attempt_id is not null;

-- Existing rows are safe to inspect under the old semantics. A sent row gets a
-- fixed response deadline; old pre-send rows retain their current lease rules.
update public.chatgpt_dispatch_requests
   set sent_confirmed_at = coalesce(sent_confirmed_at, sent_at),
       response_deadline_at = coalesce(response_deadline_at,
         least(expires_at, coalesce(sent_at, now()) + make_interval(secs => greatest(coalesce(timeout_seconds, 300), 60))))
 where state = 'sent' and sent_at is not null;

create or replace function public.chatgpt_bridge_service_claim_dispatch_v2(
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
  v_attempt uuid := extensions.gen_random_uuid();
  v_lease text := private.chatgpt_urlsafe_token();
  v_workflow_key text;
  v_active integer;
  v_response_check_only boolean := false;
  v_response_turn_anchor jsonb;
  v_response_user_turn_fingerprint text;
  v_response_user_turn_message_id text;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices
   where id = p_device_id and revoked_at is null for update;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  if v_device.automatic_send_enabled is not true then
    return jsonb_build_object('request', null, 'ready', false, 'reason', 'automatic_send_disabled');
  end if;

  update public.chatgpt_dispatch_requests
     set state='expired',user_required_at=coalesce(user_required_at,now()),error_json=coalesce(error_json,jsonb_build_object('code','expired','message','Dispatch request expired before browser delivery.')),updated_at=now()
   where user_id=v_device.user_id and state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready','send_attempted') and expires_at<=now();

  -- Never re-queue a v2 lease whose worker disappeared around the send
  -- boundary. The delivery deadline is a safe stop, not permission to type
  -- the same prompt again.
  update public.chatgpt_dispatch_requests
     set state='user_required',user_required_at=coalesce(user_required_at,now()),failed_at=null,lease_owner=null,lease_token_hash=null,lease_expires_at=null,
         error_json=jsonb_build_object('code','delivery_lease_expired','message','The v2 delivery lease expired before Website Bridge delivery could be confirmed. Review the bound ChatGPT conversation before retrying.'),
         progress_json=jsonb_build_object('stage','user_required','code','delivery_lease_expired','protocol','v2'),updated_at=now()
   where user_id=v_device.user_id
     and ((state in ('claimed_by_extension','opening_chatgpt','composer_ready','send_attempted'))
       or (state in ('acknowledged_by_mcp','running') and delivery_attempt_id is not null))
     and sent_at is null and expires_at>now()
     and delivery_deadline_at is not null and delivery_deadline_at<=now();

  update public.chatgpt_dispatch_requests
     set state='user_required',user_required_at=coalesce(user_required_at,now()),lease_owner=null,lease_token_hash=null,lease_expires_at=null,
         error_json=jsonb_build_object('code','response_capture_timeout','message','The Website Bridge sent this request but its bounded response-capture window ended. Review the bound ChatGPT conversation before retrying.'),
         progress_json=jsonb_build_object('stage','user_required','code','response_capture_timeout','protocol','v2'),updated_at=now()
   where user_id=v_device.user_id and state in ('sent','acknowledged_by_mcp','running') and sent_at is not null and expires_at>now()
     and response_deadline_at is not null and response_deadline_at<=now();

  update public.chatgpt_dispatch_requests
     set state='user_required',failed_at=null,user_required_at=coalesce(user_required_at,now()),error_json=jsonb_build_object('code','retry_limit','message','The dispatch reached its bounded delivery retry limit.'),updated_at=now()
   where user_id=v_device.user_id and state='queued' and attempt_count>=5 and expires_at>now();

  update public.job_url_inspection_requests set status='user_required',error_json=jsonb_build_object('code','expired','message','The ChatGPT bridge dispatch expired before delivery.'),updated_at=now()
   where user_id=v_device.user_id and status in ('queued','processing') and id in (
     select (r.subject_refs->>'inspection_id')::uuid
       from public.chatgpt_dispatch_requests r
      where r.user_id=v_device.user_id and r.action_type='job.inspect_url' and r.state in ('expired','user_required') and r.subject_refs ? 'inspection_id'
   );

  -- A structured profile request must remain blocked until every source
  -- Memory update completes. Surface a failed dependency instead of leaving
  -- it indefinitely queued while the worker polls for unrelated work.
  update public.chatgpt_dispatch_requests dependent
     set state='user_required',user_required_at=coalesce(dependent.user_required_at,now()),
         error_json=jsonb_build_object('code','source_memory_update_incomplete','message','A source professional-background update did not complete. Retry or review that source update before requesting the profile again.'),
         progress_json=jsonb_build_object('stage','user_required','reason','source_memory_update_incomplete'),updated_at=now()
   where dependent.user_id=v_device.user_id and dependent.state='queued'
     and cardinality(coalesce(dependent.depends_on_request_ids,'{}'::uuid[]))>0
     and exists(
       select 1 from unnest(dependent.depends_on_request_ids) as dependency_id
       left join public.chatgpt_dispatch_requests source on source.id=dependency_id and source.user_id=dependent.user_id
       where source.id is null or source.state in ('failed','expired','cancelled','user_required')
     );

  -- A v2 device may watch two different conversations, but never two turns
  -- in one bound workflow chat.
  select count(*) into v_active
    from public.chatgpt_dispatch_requests r
   where r.target_device_id = p_device_id
     and r.state in ('claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','sent','acknowledged_by_mcp','running')
     and r.expires_at > now();
  if v_active >= 2 then
    return jsonb_build_object('request', null, 'ready', true, 'reason', 'capacity_full');
  end if;

  select * into v_request
    from public.chatgpt_dispatch_requests r
   where r.user_id = v_device.user_id
     and r.state = 'queued'
     and (p_request_id is null or r.id = p_request_id)
     and r.expires_at > now()
     and r.attempt_count < 5
     and coalesce(r.available_at, now()) <= now()
    and (r.target_device_id is null or r.target_device_id = p_device_id
      or not exists (select 1 from public.chatgpt_bridge_devices d where d.id = r.target_device_id and d.revoked_at is null))
    and not exists (
      select 1
        from unnest(coalesce(r.depends_on_request_ids,'{}'::uuid[])) as dependency_id
        left join public.chatgpt_dispatch_requests source
          on source.id=dependency_id and source.user_id=r.user_id
       where source.id is null or source.state<>'completed'
    )
    and exists (
       select 1 from public.chatgpt_bridge_conversation_slots s
        where s.device_id = p_device_id
          and s.workflow_key = private.chatgpt_bridge_workflow_key(r.action_type)
          and s.active and s.project_verified_at is not null
     )
     and not exists (
       select 1
         from public.chatgpt_dispatch_requests active
        where active.target_device_id = p_device_id
          and active.state in ('claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','sent','acknowledged_by_mcp','running')
          and active.expires_at > now()
          and private.chatgpt_bridge_workflow_key(active.action_type) = private.chatgpt_bridge_workflow_key(r.action_type)
     )
   order by r.priority desc, r.created_at
   for update skip locked limit 1;
  if not found then return jsonb_build_object('request', null, 'ready', true); end if;

  v_workflow_key := private.chatgpt_bridge_workflow_key(v_request.action_type);
  select * into v_slot from public.chatgpt_bridge_conversation_slots s
   where s.device_id = p_device_id and s.workflow_key = v_workflow_key
     and s.active and s.project_verified_at is not null for update;
  if not found then return jsonb_build_object('request', null, 'ready', false, 'reason', 'conversation_slot_not_bound'); end if;

  -- The activation recovery RPC persists an explicit marker. The manual
  -- "check completed professional profile response" route predates that
  -- marker and can only identify its read-only ticket by its constrained
  -- display title, so carry both forms into the durable v2 claim.
  v_response_check_only := coalesce((v_request.progress_json->>'response_check_only')::boolean,false)
    or (v_request.action_type = 'profile.background' and v_request.display_title = 'Check completed professional profile response');

  -- A manual response-check ticket points at the original dispatch through a
  -- small owned UUID reference. Copy only the non-content turn identity from
  -- that sent request; the ticket itself never gets permission to send.
  if v_response_check_only
     and (v_request.subject_refs->>'response_check_for') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select source.delivery_turn_anchor,source.delivery_user_turn_fingerprint,source.delivery_user_turn_message_id
      into v_response_turn_anchor,v_response_user_turn_fingerprint,v_response_user_turn_message_id
      from public.chatgpt_dispatch_requests source
     where source.id=(v_request.subject_refs->>'response_check_for')::uuid
       and source.user_id=v_device.user_id
       and source.action_type='profile.background'
       and source.delivery_turn_anchor is not null;
  end if;
  -- Activation recovery reuses the original row and marks it read-only in
  -- progress_json instead of creating a second ticket. In that case its own
  -- pre-send anchor is the source of truth.
  if v_response_check_only and v_response_turn_anchor is null then
    v_response_turn_anchor := v_request.delivery_turn_anchor;
    v_response_user_turn_fingerprint := v_request.delivery_user_turn_fingerprint;
    v_response_user_turn_message_id := v_request.delivery_user_turn_message_id;
  end if;
  if v_response_check_only and v_response_turn_anchor is null then
    update public.chatgpt_dispatch_requests
       set state='user_required',
           user_required_at=coalesce(user_required_at,now()),
           error_json=jsonb_build_object('code','response_check_anchor_missing','message','This read-only response check has no durable exact-turn anchor and requires manual review.'),
           progress_json=jsonb_build_object('stage','user_required','code','response_check_anchor_missing','protocol','v2','response_check_only',true),
           updated_at=now()
     where id=v_request.id;
    return jsonb_build_object('request',null,'ready',true,'reason','response_check_anchor_missing');
  end if;

  update public.chatgpt_dispatch_requests
     set state = 'claimed_by_extension',
         target_device_id = p_device_id,
         attempt_count = attempt_count + 1,
         lease_owner = p_device_id::text,
         lease_token_hash = private.chatgpt_token_hash(v_lease),
         lease_expires_at = least(expires_at, now() + interval '5 minutes'),
         delivery_attempt_id = v_attempt,
         delivery_deadline_at = least(expires_at, now() + interval '2 minutes'),
         delivery_turn_anchor = case when v_response_check_only then v_response_turn_anchor else delivery_turn_anchor end,
         delivery_user_turn_fingerprint = case when v_response_check_only then v_response_user_turn_fingerprint else delivery_user_turn_fingerprint end,
         delivery_user_turn_message_id = case when v_response_check_only then v_response_user_turn_message_id else delivery_user_turn_message_id end,
         available_at = null,
         claimed_at = coalesce(claimed_at, now()),
         progress_json = jsonb_build_object('stage','claimed_by_extension','protocol','v2','delivery_attempt_id',v_attempt,'response_check_only',v_response_check_only),
         updated_at = now()
   where id = v_request.id
   returning * into v_request;

  update public.chatgpt_bridge_conversation_slots
     set last_used_at=now(),last_dispatch_at=now(),updated_at=now()
   where id=v_slot.id;

  return jsonb_build_object('request', jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,
    'action_version',v_request.action_version,'display_title',v_request.display_title,
    'instruction',v_request.manual_instruction,'correlation_id',v_request.correlation_id,
    'response_check_only',v_response_check_only,
    'response_check_turn_anchor',v_response_turn_anchor,
    'response_check_user_turn_fingerprint',v_response_user_turn_fingerprint,
    'response_check_user_turn_message_id',v_response_user_turn_message_id,
    'workflow_key',v_slot.workflow_key,'workflow_display_name',v_slot.display_name,
    'bound_conversation_url',v_slot.conversation_url,'bound_project_name',v_slot.project_name,
    'bound_project_verified',v_slot.project_verified_at is not null,
    'automatic_send_enabled',v_device.automatic_send_enabled,
    'delivery_attempt_id',v_attempt,'delivery_deadline_at',v_request.delivery_deadline_at,
    'depends_on_request_ids',coalesce(v_request.depends_on_request_ids,'{}'::uuid[]),
    'lease_expires_at',v_request.lease_expires_at,'lease_token',v_lease
  ), 'ready', true);
end;
$$;
revoke all on function public.chatgpt_bridge_service_claim_dispatch_v2(uuid,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_claim_dispatch_v2(uuid,uuid) to service_role;

-- Persist the rendered conversation boundary before the visible Send click.
-- This is deliberately separate from the Send authorization transition: the
-- extension must be able to fail closed if the anchor cannot be recorded, and
-- a later read-only response check must have the same turn identity even if
-- the original service worker has been suspended or replaced.
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
declare v_device public.chatgpt_bridge_devices; v_request public.chatgpt_dispatch_requests;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  if p_turn_anchor is null then raise exception 'A durable ChatGPT turn anchor is required before Send'; end if;
  if p_turn_anchor is not null and jsonb_typeof(p_turn_anchor) <> 'object' then raise exception 'The dispatch turn anchor must be an object'; end if;
  if p_turn_anchor is not null and length(p_turn_anchor::text)>4000 then raise exception 'The dispatch turn anchor is too large'; end if;
  if p_turn_anchor is not null and exists(
    select 1 from jsonb_object_keys(p_turn_anchor) key
     where key not in ('conversationUrl','turnCount','lastUserFingerprint','lastAssistantFingerprint','lastUserMessageId','lastAssistantMessageId','artifactCount')
  ) then raise exception 'The dispatch turn anchor contains an unsupported field'; end if;
  if p_turn_anchor is not null and (length(coalesce(p_turn_anchor->>'conversationUrl',''))<1 or length(coalesce(p_turn_anchor->>'conversationUrl',''))>500) then raise exception 'The dispatch turn anchor conversation URL is invalid'; end if;
  if p_turn_anchor is not null and (length(coalesce(p_turn_anchor->>'lastUserFingerprint',''))>200 or length(coalesce(p_turn_anchor->>'lastAssistantFingerprint',''))>200) then raise exception 'The dispatch turn anchor fingerprint is invalid'; end if;
  if p_turn_anchor is not null and (length(coalesce(p_turn_anchor->>'lastUserMessageId',''))>300 or length(coalesce(p_turn_anchor->>'lastAssistantMessageId',''))>300) then raise exception 'The dispatch turn anchor message id is invalid'; end if;
  if length(coalesce(p_user_turn_fingerprint,'')) > 200 then raise exception 'The dispatch user fingerprint is too long'; end if;
  if length(coalesce(p_user_turn_message_id,'')) > 300 then raise exception 'The dispatch message id is too long'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state='completed' then
    return jsonb_build_object('id',v_request.id,'state','completed','idempotent',true,'turn_anchor',v_request.delivery_turn_anchor,'user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,'user_turn_message_id',v_request.delivery_user_turn_message_id);
  end if;
  if v_request.state not in ('send_attempted','sent','acknowledged_by_mcp','running')
     or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.target_device_id is distinct from p_device_id then raise exception 'Dispatch turn anchor lease is invalid'; end if;
  update public.chatgpt_dispatch_requests
     set delivery_turn_anchor=coalesce(p_turn_anchor,delivery_turn_anchor),
         delivery_user_turn_fingerprint=coalesce(nullif(btrim(p_user_turn_fingerprint),''),delivery_user_turn_fingerprint),
         delivery_user_turn_message_id=coalesce(nullif(btrim(p_user_turn_message_id),''),delivery_user_turn_message_id),
         updated_at=now()
   where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',false,'turn_anchor',v_request.delivery_turn_anchor,'user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,'user_turn_message_id',v_request.delivery_user_turn_message_id);
end;
$$;
revoke all on function public.chatgpt_bridge_service_record_send_anchor(uuid,uuid,text,uuid,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_record_send_anchor(uuid,uuid,text,uuid,jsonb,text,text) to service_role;

create or replace function public.chatgpt_bridge_service_prepare_dispatch_v2(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid, p_stage text, p_progress jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_request public.chatgpt_dispatch_requests; v_device public.chatgpt_bridge_devices; v_next text := lower(coalesce(p_stage,''));
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  if v_next not in ('opening_chatgpt','composer_ready') then raise exception 'Invalid v2 preparation stage'; end if;
  if jsonb_typeof(coalesce(p_progress,'{}'::jsonb)) <> 'object' or length(coalesce(p_progress,'{}'::jsonb)::text)>4000 then raise exception 'Dispatch progress must be a small object'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state in ('completed','failed','cancelled','expired','user_required') then return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true); end if;
  if v_request.delivery_attempt_id is distinct from p_attempt_id or v_request.lease_token_hash is distinct from p_lease_token_hash or v_request.target_device_id is distinct from p_device_id then raise exception 'Dispatch preparation lease is invalid'; end if;
  if v_request.lease_expires_at is null or v_request.lease_expires_at<=now() or v_request.delivery_deadline_at is null or v_request.delivery_deadline_at<=now() then raise exception 'Dispatch preparation lease has expired'; end if;
  if v_request.state='claimed_by_extension' and v_next='composer_ready' then raise exception 'The ChatGPT conversation has not reached its composer stage'; end if;
  if v_request.state='composer_ready' and v_next='opening_chatgpt' then return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true); end if;
  if v_request.state not in ('claimed_by_extension','opening_chatgpt','composer_ready') then raise exception 'Invalid v2 preparation transition from %',v_request.state; end if;
  update public.chatgpt_dispatch_requests set state=case when v_request.state='composer_ready' then v_request.state else v_next end,
    progress_json=coalesce(v_request.progress_json,'{}'::jsonb)||jsonb_build_object('stage',case when v_request.state='composer_ready' then v_request.state else v_next end,'protocol','v2')||coalesce(p_progress,'{}'::jsonb),updated_at=now()
   where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'progress',v_request.progress_json,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_prepare_dispatch_v2(uuid,uuid,text,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_prepare_dispatch_v2(uuid,uuid,text,uuid,text,jsonb) to service_role;

create or replace function public.chatgpt_bridge_service_authorize_send(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_request public.chatgpt_dispatch_requests; v_device public.chatgpt_bridge_devices;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state = 'send_attempted' then
    return jsonb_build_object('id',v_request.id,'state',v_request.state,'may_send',false,'idempotent',true);
  end if;
  if v_request.state in ('sent','completed','failed','cancelled','expired','user_required') then
    return jsonb_build_object('id',v_request.id,'state',v_request.state,'may_send',false,'idempotent',true);
  end if;
  if v_request.state <> 'composer_ready' or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.target_device_id is distinct from p_device_id
     or v_request.delivery_deadline_at is null or v_request.delivery_deadline_at <= now()
     or v_request.lease_expires_at is null or v_request.lease_expires_at <= now() then
    raise exception 'Dispatch send authorization is invalid or has expired';
  end if;
  update public.chatgpt_dispatch_requests set state='send_attempted',send_attempted_at=now(),
    progress_json=jsonb_build_object('stage','send_attempted','protocol','v2','delivery_attempt_id',p_attempt_id),updated_at=now()
   where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'may_send',true,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_authorize_send(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_authorize_send(uuid,uuid,text,uuid) to service_role;

create or replace function public.chatgpt_bridge_service_confirm_sent(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_request public.chatgpt_dispatch_requests; v_device public.chatgpt_bridge_devices; v_deadline timestamptz;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state = 'completed' then
    return jsonb_build_object('id',v_request.id,'state','completed','idempotent',true);
  end if;
  if v_request.state in ('sent','acknowledged_by_mcp','running') then
    if v_request.delivery_attempt_id is distinct from p_attempt_id or v_request.lease_token_hash is distinct from p_lease_token_hash then raise exception 'Dispatch sent confirmation is invalid'; end if;
    v_deadline := coalesce(v_request.response_deadline_at, least(v_request.expires_at, now() + make_interval(secs => greatest(coalesce(v_request.timeout_seconds,300),60))));
    update public.chatgpt_dispatch_requests set sent_at=coalesce(sent_at,now()),sent_confirmed_at=coalesce(sent_confirmed_at,now()),response_deadline_at=coalesce(response_deadline_at,v_deadline),lease_expires_at=v_deadline,updated_at=now() where id=v_request.id returning * into v_request;
    return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true,'response_deadline_at',v_request.response_deadline_at);
  end if;
  if v_request.state <> 'send_attempted' or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash then raise exception 'Dispatch sent confirmation is invalid'; end if;
  v_deadline := least(v_request.expires_at, now() + make_interval(secs => greatest(coalesce(v_request.timeout_seconds,300),60)));
  update public.chatgpt_dispatch_requests set state='sent',sent_at=coalesce(sent_at,now()),sent_confirmed_at=coalesce(sent_confirmed_at,now()),response_deadline_at=v_deadline,lease_expires_at=v_deadline,
    progress_json=jsonb_build_object('stage','sent','protocol','v2','delivery_attempt_id',p_attempt_id),updated_at=now()
   where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',false,'response_deadline_at',v_deadline);
end;
$$;
revoke all on function public.chatgpt_bridge_service_confirm_sent(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_confirm_sent(uuid,uuid,text,uuid) to service_role;

create or replace function public.chatgpt_bridge_service_defer_dispatch(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid, p_delay_seconds integer, p_reason text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_request public.chatgpt_dispatch_requests; v_device public.chatgpt_bridge_devices; v_delay integer := least(greatest(coalesce(p_delay_seconds,15),1),1800);
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state not in ('claimed_by_extension','opening_chatgpt','composer_ready') or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash or v_request.target_device_id is distinct from p_device_id
     or v_request.send_attempted_at is not null then raise exception 'Only an unsent v2 dispatch can be deferred'; end if;
  update public.chatgpt_dispatch_requests set state='queued',available_at=least(expires_at,now()+make_interval(secs=>v_delay)),lease_owner=null,lease_token_hash=null,lease_expires_at=null,delivery_attempt_id=null,delivery_deadline_at=null,
    error_json=jsonb_build_object('code',coalesce(nullif(p_reason,''),'deferred'),'message','The bridge deferred delivery before Send.'),progress_json=jsonb_build_object('stage','queued','reason',coalesce(nullif(p_reason,''),'deferred')),updated_at=now()
   where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'available_at',v_request.available_at,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_defer_dispatch(uuid,uuid,text,uuid,integer,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_defer_dispatch(uuid,uuid,text,uuid,integer,text) to service_role;

create or replace function public.chatgpt_bridge_service_touch_dispatch_v2(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_request public.chatgpt_dispatch_requests; v_device public.chatgpt_bridge_devices; v_cap timestamptz;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state in ('completed','failed','cancelled','expired','user_required') then return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true); end if;
  if v_request.delivery_attempt_id is distinct from p_attempt_id or v_request.lease_token_hash is distinct from p_lease_token_hash then raise exception 'Dispatch lease is invalid'; end if;
  v_cap := least(v_request.expires_at,coalesce(v_request.response_deadline_at,v_request.delivery_deadline_at,v_request.expires_at));
  update public.chatgpt_dispatch_requests set lease_expires_at=least(v_cap,now()+interval '5 minutes'),updated_at=now() where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'lease_expires_at',v_request.lease_expires_at,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_touch_dispatch_v2(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_touch_dispatch_v2(uuid,uuid,text,uuid) to service_role;

create or replace function public.chatgpt_bridge_service_complete_dispatch_v2(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid, p_response_text text, p_response_hash text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_device public.chatgpt_bridge_devices; v_request public.chatgpt_dispatch_requests; v_response text := btrim(coalesce(p_response_text,''));
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  if length(v_response)<1 or length(v_response)>100000 then raise exception 'A bounded ChatGPT response is required'; end if;
  if length(coalesce(p_response_hash,''))<>64 then raise exception 'A response hash is required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state='completed' and v_request.response_hash=p_response_hash then return jsonb_build_object('id',v_request.id,'state','completed','idempotent',true); end if;
  if v_request.state='completed' then return jsonb_build_object('id',v_request.id,'state','completed','accepted',false,'idempotent',true); end if;
  if v_request.state in ('failed','cancelled','expired','user_required') then return jsonb_build_object('id',v_request.id,'state',v_request.state,'accepted',false,'idempotent',true); end if;
  -- The authenticated MCP fallback may claim a normally delivered request
  -- while the Website Bridge is still reading the final assistant turn. Keep
  -- the same lease and allow the bridge to attach that response from any
  -- active post-delivery state; this closes the race without permitting a
  -- second browser send.
  if v_request.state not in ('sent','acknowledged_by_mcp','running')
     or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.lease_expires_at is null or v_request.lease_expires_at<=now() then raise exception 'Dispatch completion lease is invalid or expired'; end if;
  update public.chatgpt_dispatch_requests set state='completed',sent_at=coalesce(sent_at,now()),sent_confirmed_at=coalesce(sent_confirmed_at,now()),response_deadline_at=coalesce(response_deadline_at,least(expires_at,now()+make_interval(secs=>greatest(coalesce(timeout_seconds,300),60)))),bridge_response=v_response,bridge_response_at=now(),response_hash=p_response_hash,response_length=length(v_response),output_refs=coalesce(output_refs,'{}'::jsonb)||jsonb_build_object('source','website_bridge','response_captured',true),progress_json=jsonb_build_object('stage','completed','protocol','v2','response_hash',p_response_hash),completed_at=now(),lease_token_hash=null,lease_expires_at=null,updated_at=now() where id=v_request.id returning * into v_request;
  update public.chatgpt_work_items set state='completed',output_json=coalesce(output_json,'{}'::jsonb)||jsonb_build_object('source','website_bridge','response_captured',true),completed_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=v_request.work_item_id and state in ('queued','leased','running','user_required');
  return jsonb_build_object('id',v_request.id,'state','completed','accepted',true,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_complete_dispatch_v2(uuid,uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_complete_dispatch_v2(uuid,uuid,text,uuid,text,text) to service_role;

-- A response-check dispatch is intentionally read-only: it claims a queued
-- recovery ticket, inspects an already-sent turn, and completes the ticket
-- without manufacturing a new sent_at event or authorizing another click.
create or replace function public.chatgpt_bridge_service_complete_reused_dispatch_v2(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid, p_response_text text, p_response_hash text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_device public.chatgpt_bridge_devices; v_request public.chatgpt_dispatch_requests; v_response text := btrim(coalesce(p_response_text,''));
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  if length(v_response)<1 or length(v_response)>100000 then raise exception 'A bounded ChatGPT response is required'; end if;
  if length(coalesce(p_response_hash,''))<>64 then raise exception 'A response hash is required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state='completed' and v_request.response_hash=p_response_hash then return jsonb_build_object('id',v_request.id,'state','completed','accepted',true,'idempotent',true); end if;
  if v_request.state in ('failed','cancelled','expired','user_required') then return jsonb_build_object('id',v_request.id,'state',v_request.state,'accepted',false,'idempotent',true); end if;
  if coalesce((v_request.progress_json->>'response_check_only')::boolean,false) is not true then raise exception 'Only a response-check dispatch may reuse an existing response'; end if;
  if v_request.state not in ('claimed_by_extension','opening_chatgpt','composer_ready','acknowledged_by_mcp','running')
     or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.lease_expires_at is null or v_request.lease_expires_at<=now() then raise exception 'Dispatch reuse lease is invalid or expired'; end if;
  update public.chatgpt_dispatch_requests set state='completed',bridge_response=v_response,bridge_response_at=now(),response_hash=p_response_hash,response_length=length(v_response),output_refs=coalesce(output_refs,'{}'::jsonb)||jsonb_build_object('source','website_bridge','response_captured',true,'response_reused',true),progress_json=jsonb_build_object('stage','completed','protocol','v2','response_reused',true,'response_hash',p_response_hash),completed_at=now(),lease_token_hash=null,lease_expires_at=null,updated_at=now() where id=v_request.id returning * into v_request;
  update public.chatgpt_work_items set state='completed',output_json=coalesce(output_json,'{}'::jsonb)||jsonb_build_object('source','website_bridge','response_captured',true,'response_reused',true),completed_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=v_request.work_item_id and state in ('queued','leased','running','user_required');
  return jsonb_build_object('id',v_request.id,'state','completed','accepted',true,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_complete_reused_dispatch_v2(uuid,uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_complete_reused_dispatch_v2(uuid,uuid,text,uuid,text,text) to service_role;

create or replace function public.chatgpt_bridge_service_reopen_response_capture(
  p_device_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_device public.chatgpt_bridge_devices; v_request public.chatgpt_dispatch_requests; v_lease text:=private.chatgpt_urlsafe_token(); v_deadline timestamptz;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state='completed' then return jsonb_build_object('id',v_request.id,'state','completed','idempotent',true); end if;
  if v_request.sent_at is null or v_request.state not in ('user_required','sent') then raise exception 'Only a sent response may be reopened'; end if;
  v_deadline:=least(v_request.expires_at,now()+make_interval(secs=>greatest(coalesce(v_request.timeout_seconds,300),60)));
  update public.chatgpt_dispatch_requests set state='sent',lease_owner=p_device_id::text,lease_token_hash=private.chatgpt_token_hash(v_lease),lease_expires_at=v_deadline,response_deadline_at=v_deadline,error_json=null,updated_at=now() where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state','sent','lease_token',v_lease,'lease_expires_at',v_deadline,'delivery_attempt_id',v_request.delivery_attempt_id,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_reopen_response_capture(uuid,uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_reopen_response_capture(uuid,uuid) to service_role;

create or replace function public.chatgpt_bridge_service_stop_dispatch_v2(
  p_device_id uuid, p_request_id uuid, p_lease_token_hash text, p_attempt_id uuid, p_code text, p_message text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_device public.chatgpt_bridge_devices; v_request public.chatgpt_dispatch_requests;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state in ('completed','failed','cancelled','expired','user_required') then return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true); end if;
  if v_request.delivery_attempt_id is distinct from p_attempt_id or v_request.lease_token_hash is distinct from p_lease_token_hash then raise exception 'Dispatch stop lease is invalid'; end if;
  update public.chatgpt_dispatch_requests set state='user_required',user_required_at=coalesce(user_required_at,now()),error_json=jsonb_build_object('code',left(coalesce(nullif(p_code,''),'user_required'),120),'message',left(coalesce(nullif(p_message,''),'The bridge stopped safely.'),500)),progress_json=jsonb_build_object('stage','user_required','protocol','v2','code',left(coalesce(nullif(p_code,''),'user_required'),120)),lease_owner=null,lease_token_hash=null,lease_expires_at=null,updated_at=now() where id=v_request.id returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_stop_dispatch_v2(uuid,uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_stop_dispatch_v2(uuid,uuid,text,uuid,text,text) to service_role;
