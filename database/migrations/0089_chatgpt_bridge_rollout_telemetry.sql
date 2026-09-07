-- M36: bounded rollout telemetry for the Website Bridge v2 cutover.
--
-- This function intentionally returns operational metadata only. It never
-- returns website instructions, ChatGPT responses, lease tokens, or hashes of
-- those secrets. Request and device ids are safe correlation identifiers for
-- an operator investigating a non-zero counter.

create index if not exists chatgpt_dispatch_requests_rollout_active_idx
  on public.chatgpt_dispatch_requests(user_id, state, lease_expires_at, response_deadline_at)
  where state in (
    'claimed_by_extension','opening_chatgpt','composer_ready','send_attempted',
    'sent','acknowledged_by_mcp','running'
  );

create index if not exists chatgpt_dispatch_requests_rollout_send_attempted_idx
  on public.chatgpt_dispatch_requests(user_id, send_attempted_at, delivery_deadline_at)
  where state = 'send_attempted' and sent_at is null;

create index if not exists chatgpt_dispatch_requests_rollout_result_idx
  on public.chatgpt_dispatch_requests(user_id, state, response_deadline_at, bridge_response_at)
  where sent_at is not null and bridge_response_at is null;

-- ChatGPT bridge audit metadata is deliberately narrower than the general
-- audit table. Keep prompt and response content out of the audit trail even if
-- a future state transition accidentally tries to add one as a JSON key.
create or replace function private.chatgpt_bridge_audit_metadata_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type like 'chatgpt_bridge.%'
     and coalesce(new.metadata::text, '') ~* '"(manual_instruction|website_instruction|mcp_fallback_instruction|bridge_response|response_text)"[[:space:]]*:' then
    raise exception 'ChatGPT bridge audit metadata cannot contain instructions or response text';
  end if;
  return new;
end;
$$;

revoke all on function private.chatgpt_bridge_audit_metadata_guard() from public, anon, authenticated;
drop trigger if exists audit_events_chatgpt_bridge_metadata_guard on public.audit_events;
create trigger audit_events_chatgpt_bridge_metadata_guard
  before insert on public.audit_events
  for each row execute function private.chatgpt_bridge_audit_metadata_guard();

create or replace function public.chatgpt_bridge_service_get_rollout_telemetry(
  p_device_id uuid,
  p_since timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_user_id uuid;
  v_now timestamptz := now();
  v_since timestamptz := least(
    greatest(coalesce(p_since, now() - interval '24 hours'), now() - interval '30 days'),
    now()
  );
  v_total_devices integer := 0;
  v_v2_devices integer := 0;
  v_v1_devices integer := 0;
  v_recent_v1_devices integer := 0;
  v_v1_device_details jsonb := '[]'::jsonb;
  v_active_dispatches integer := 0;
  v_expired_active_leases integer := 0;
  v_overrenewed_leases integer := 0;
  v_orphaned_send_attempted integer := 0;
  v_pending_results integer := 0;
  v_lost_result_uploads integer := 0;
  v_completed_v2 integer := 0;
  v_uploaded_v2 integer := 0;
  v_missing_upload_metadata integer := 0;
  v_bridge_audit_events integer := 0;
  v_unsafe_bridge_audit_events integer := 0;
  v_oldest_send_attempted timestamptz;
  v_oldest_pending_result timestamptz;
  v_overrenewed_details jsonb := '[]'::jsonb;
  v_orphaned_details jsonb := '[]'::jsonb;
  v_lost_result_details jsonb := '[]'::jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select * into v_device
    from public.chatgpt_bridge_devices
   where id = p_device_id
     and revoked_at is null;
  if not found then
    raise exception 'ChatGPT bridge device not found';
  end if;
  v_user_id := v_device.user_id;
  perform private.assert_active_app_membership(v_user_id);

  -- A v2 device is one that advertises every capability needed by the
  -- durable protocol. A partially upgraded device remains a v1 device until
  -- its next authenticated heartbeat publishes the complete set.
  select
    count(*)::integer,
    count(*) filter (where
      case when (d.capabilities->>'protocol_version') ~ '^[0-9]+$'
        then (d.capabilities->>'protocol_version')::integer else 0 end >= 2
      and coalesce(d.capabilities->>'durable_dispatch_v2','false') = 'true'
      and coalesce(d.capabilities->>'send_authorization_v2','false') = 'true'
      and coalesce(d.capabilities->>'result_outbox_v1','false') = 'true'
      and case when (d.capabilities->>'concurrent_response_capture') ~ '^[0-9]+$'
        then (d.capabilities->>'concurrent_response_capture')::integer else 0 end >= 2
    )::integer
    into v_total_devices, v_v2_devices
    from public.chatgpt_bridge_devices d
   where d.user_id = v_user_id
     and d.revoked_at is null;
  v_v1_devices := greatest(v_total_devices - v_v2_devices, 0);

  select count(*)::integer into v_recent_v1_devices
    from public.chatgpt_bridge_devices d
   where d.user_id = v_user_id
     and d.revoked_at is null
     and not (
       case when (d.capabilities->>'protocol_version') ~ '^[0-9]+$'
         then (d.capabilities->>'protocol_version')::integer else 0 end >= 2
       and coalesce(d.capabilities->>'durable_dispatch_v2','false') = 'true'
       and coalesce(d.capabilities->>'send_authorization_v2','false') = 'true'
       and coalesce(d.capabilities->>'result_outbox_v1','false') = 'true'
       and case when (d.capabilities->>'concurrent_response_capture') ~ '^[0-9]+$'
         then (d.capabilities->>'concurrent_response_capture')::integer else 0 end >= 2
     )
     and coalesce(d.last_seen_at, d.paired_at) >= v_now - interval '15 minutes';

  select coalesce(jsonb_agg(to_jsonb(details) order by details.last_seen_at desc nulls last), '[]'::jsonb)
    into v_v1_device_details
    from (
      select d.id as device_id,
             d.extension_version,
             d.last_seen_at,
             d.paired_at
        from public.chatgpt_bridge_devices d
       where d.user_id = v_user_id
         and d.revoked_at is null
         and not (
           case when (d.capabilities->>'protocol_version') ~ '^[0-9]+$'
             then (d.capabilities->>'protocol_version')::integer else 0 end >= 2
           and coalesce(d.capabilities->>'durable_dispatch_v2','false') = 'true'
           and coalesce(d.capabilities->>'send_authorization_v2','false') = 'true'
           and coalesce(d.capabilities->>'result_outbox_v1','false') = 'true'
           and case when (d.capabilities->>'concurrent_response_capture') ~ '^[0-9]+$'
             then (d.capabilities->>'concurrent_response_capture')::integer else 0 end >= 2
         )
       order by d.last_seen_at desc nulls last, d.paired_at desc
       limit 50
    ) details;

  select
    count(*) filter (where r.state in (
      'claimed_by_extension','opening_chatgpt','composer_ready','send_attempted',
      'sent','acknowledged_by_mcp','running'
    ))::integer,
    count(*) filter (where r.state in (
      'claimed_by_extension','opening_chatgpt','composer_ready','send_attempted',
      'sent','acknowledged_by_mcp','running'
    ) and r.lease_expires_at is not null and r.lease_expires_at <= v_now)::integer,
    count(*) filter (where r.state in (
      'claimed_by_extension','opening_chatgpt','composer_ready','send_attempted',
      'sent','acknowledged_by_mcp','running'
    ) and r.lease_expires_at is not null and r.lease_expires_at > least(
      r.expires_at,
      coalesce(r.response_deadline_at, r.delivery_deadline_at, r.expires_at)
    ))::integer,
    count(*) filter (where r.state = 'send_attempted'
      and r.sent_at is null
      and r.send_attempted_at is not null
      and (r.delivery_deadline_at <= v_now or r.send_attempted_at <= v_now - interval '60 seconds'))::integer,
    min(r.send_attempted_at) filter (where r.state = 'send_attempted'
      and r.sent_at is null
      and r.send_attempted_at is not null
      and (r.delivery_deadline_at <= v_now or r.send_attempted_at <= v_now - interval '60 seconds')),
    count(*) filter (where r.state in ('sent','acknowledged_by_mcp','running')
      and r.sent_at is not null
      and r.bridge_response_at is null)::integer,
    min(r.sent_at) filter (where r.state in ('sent','acknowledged_by_mcp','running')
      and r.sent_at is not null
      and r.bridge_response_at is null),
    count(*) filter (where r.state in ('sent','acknowledged_by_mcp','running')
      and r.sent_at is not null
      and r.bridge_response_at is null
      and (r.response_deadline_at <= v_now or r.expires_at <= v_now))::integer,
    count(*) filter (where r.state = 'completed'
      and r.completed_at >= v_since
      and r.progress_json->>'protocol' = 'v2')::integer,
    count(*) filter (where r.state = 'completed'
      and r.completed_at >= v_since
      and r.progress_json->>'protocol' = 'v2'
      and r.bridge_response_at is not null
      and r.response_hash is not null
      and r.response_length is not null)::integer,
    count(*) filter (where r.state = 'completed'
      and r.completed_at >= v_since
      and r.progress_json->>'protocol' = 'v2'
      and r.bridge_response_at is not null
      and (r.response_hash is null or r.response_length is null))::integer
    into v_active_dispatches, v_expired_active_leases, v_overrenewed_leases,
         v_orphaned_send_attempted, v_oldest_send_attempted,
         v_pending_results, v_oldest_pending_result, v_lost_result_uploads,
         v_completed_v2, v_uploaded_v2, v_missing_upload_metadata
    from public.chatgpt_dispatch_requests r
   where r.user_id = v_user_id;

  -- Keep diagnostic lists bounded. They contain only ids, states, deadlines,
  -- and numeric ages; never include the instruction or captured response.
  select coalesce(jsonb_agg(jsonb_build_object(
      'request_id', details.id,
      'state', details.state,
      'protocol', case when details.delivery_attempt_id is null then 'v1' else 'v2' end,
      'lease_expires_at', details.lease_expires_at,
      'delivery_deadline_at', details.delivery_deadline_at,
      'response_deadline_at', details.response_deadline_at,
      'age_seconds', greatest(0, floor(extract(epoch from (v_now - details.updated_at)))::integer)
    ) order by details.updated_at asc), '[]'::jsonb)
    into v_overrenewed_details
    from (
      select r.id, r.state, r.delivery_attempt_id, r.lease_expires_at,
             r.delivery_deadline_at, r.response_deadline_at, r.updated_at
        from public.chatgpt_dispatch_requests r
       where r.user_id = v_user_id
         and r.state in ('claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','sent','acknowledged_by_mcp','running')
         and r.lease_expires_at is not null
         and r.lease_expires_at > least(r.expires_at, coalesce(r.response_deadline_at, r.delivery_deadline_at, r.expires_at))
       order by r.updated_at asc
       limit 20
    ) details;

  select coalesce(jsonb_agg(jsonb_build_object(
      'request_id', details.id,
      'state', details.state,
      'protocol', case when details.delivery_attempt_id is null then 'v1' else 'v2' end,
      'send_attempted_at', details.send_attempted_at,
      'delivery_deadline_at', details.delivery_deadline_at,
      'age_seconds', greatest(0, floor(extract(epoch from (v_now - details.send_attempted_at)))::integer)
    ) order by details.send_attempted_at asc), '[]'::jsonb)
    into v_orphaned_details
    from (
      select r.id, r.state, r.delivery_attempt_id, r.send_attempted_at, r.delivery_deadline_at
        from public.chatgpt_dispatch_requests r
       where r.user_id = v_user_id
         and r.state = 'send_attempted'
         and r.sent_at is null
         and r.send_attempted_at is not null
         and (r.delivery_deadline_at <= v_now or r.send_attempted_at <= v_now - interval '60 seconds')
       order by r.send_attempted_at asc
       limit 20
    ) details;

  select coalesce(jsonb_agg(jsonb_build_object(
      'request_id', details.id,
      'state', details.state,
      'protocol', case when details.delivery_attempt_id is null then 'v1' else 'v2' end,
      'sent_at', details.sent_at,
      'response_deadline_at', details.response_deadline_at,
      'age_seconds', greatest(0, floor(extract(epoch from (v_now - details.sent_at)))::integer)
    ) order by details.sent_at asc), '[]'::jsonb)
    into v_lost_result_details
    from (
      select r.id, r.state, r.delivery_attempt_id, r.sent_at, r.response_deadline_at
        from public.chatgpt_dispatch_requests r
       where r.user_id = v_user_id
         and r.state in ('sent','acknowledged_by_mcp','running')
         and r.sent_at is not null
         and r.bridge_response_at is null
         and (r.response_deadline_at <= v_now or r.expires_at <= v_now)
       order by r.sent_at asc
       limit 20
    ) details;

  select count(*)::integer,
         count(*) filter (where coalesce(a.metadata::text, '') ~* '"(manual_instruction|website_instruction|mcp_fallback_instruction|bridge_response|response_text)"[[:space:]]*:')::integer
    into v_bridge_audit_events, v_unsafe_bridge_audit_events
    from public.audit_events a
   where a.user_id = v_user_id
     and a.event_type like 'chatgpt_bridge.%'
     and a.created_at >= v_since;

  return jsonb_build_object(
    'schema_version', 1,
    'generated_at', v_now,
    'window', jsonb_build_object('since', v_since, 'until', v_now),
    'rollout', jsonb_build_object(
      'total_active_devices', v_total_devices,
      'v2_devices', v_v2_devices,
      'v1_devices', v_v1_devices,
      'recent_v1_devices', v_recent_v1_devices,
      'v1_device_details', v_v1_device_details,
      'v1_compatibility_can_be_removed', v_v1_devices = 0
    ),
    'leases', jsonb_build_object(
      'active_dispatches', v_active_dispatches,
      'expired_active_leases', v_expired_active_leases,
      'overrenewed_leases', v_overrenewed_leases,
      'overrenewed_details', v_overrenewed_details
    ),
    'delivery', jsonb_build_object(
      'orphaned_send_attempted', v_orphaned_send_attempted,
      'oldest_orphaned_send_attempted_at', v_oldest_send_attempted,
      'orphaned_details', v_orphaned_details
    ),
    'results', jsonb_build_object(
      'pending_result_uploads', v_pending_results,
      'oldest_pending_result_at', v_oldest_pending_result,
      'lost_result_uploads', v_lost_result_uploads,
      'lost_result_details', v_lost_result_details,
      'completed_v2_in_window', v_completed_v2,
      'uploaded_v2_in_window', v_uploaded_v2,
      'completed_v2_missing_upload_metadata', v_missing_upload_metadata
    ),
    'audit', jsonb_build_object(
      'bridge_events_in_window', v_bridge_audit_events,
      'unsafe_bridge_events_in_window', v_unsafe_bridge_audit_events
    ),
    'healthy', (
      v_overrenewed_leases = 0
      and v_orphaned_send_attempted = 0
      and v_lost_result_uploads = 0
      and v_missing_upload_metadata = 0
      and v_unsafe_bridge_audit_events = 0
    )
  );
end;
$$;

revoke all on function public.chatgpt_bridge_service_get_rollout_telemetry(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_get_rollout_telemetry(uuid, timestamptz) to service_role;
