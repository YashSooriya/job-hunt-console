-- M29 adaptive Website Bridge backoff. A v2 claim that is repeatedly
-- deferred because the bound ChatGPT conversation is already generating must
-- stop after the fifth bounded claim instead of cycling forever. Rate-limit
-- deferrals continue to return the request to the queue and are coordinated by
-- the extension's persisted device backoff.

create or replace function public.chatgpt_bridge_service_defer_dispatch(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_attempt_id uuid,
  p_delay_seconds integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.chatgpt_dispatch_requests;
  v_device public.chatgpt_bridge_devices;
  v_delay integer := least(greatest(coalesce(p_delay_seconds, 15), 1), 1800);
  v_reason text := lower(coalesce(nullif(btrim(p_reason), ''), 'deferred'));
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device
    from public.chatgpt_bridge_devices
   where id = p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);

  select * into v_request
    from public.chatgpt_dispatch_requests
   where id = p_request_id and user_id = v_device.user_id
   for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state not in ('claimed_by_extension', 'opening_chatgpt', 'composer_ready')
     or v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.target_device_id is distinct from p_device_id
     or v_request.send_attempted_at is not null then
    raise exception 'Only an unsent v2 dispatch can be deferred';
  end if;

  -- attempt_count is incremented atomically by the v2 claim RPC. The fifth
  -- already-generating result is therefore the final safe automatic retry.
  if v_reason = 'chatgpt_busy' and v_request.attempt_count >= 5 then
    update public.chatgpt_dispatch_requests
       set state = 'user_required',
           user_required_at = coalesce(user_required_at, now()),
           failed_at = null,
           available_at = null,
           lease_owner = null,
           lease_token_hash = null,
           lease_expires_at = null,
           delivery_attempt_id = null,
           delivery_deadline_at = null,
           error_json = jsonb_build_object(
             'code', 'chatgpt_busy_retry_limit',
             'message', 'ChatGPT was already generating after five bounded attempts; manual review is required.'
           ),
           progress_json = jsonb_build_object(
             'stage', 'user_required',
             'code', 'chatgpt_busy_retry_limit',
             'protocol', 'v2',
             'attempt_count', v_request.attempt_count
           ),
           updated_at = now()
     where id = v_request.id
     returning * into v_request;
    return jsonb_build_object(
      'id', v_request.id,
      'state', v_request.state,
      'user_required', true,
      'attempt_count', v_request.attempt_count,
      'idempotent', false
    );
  end if;

  update public.chatgpt_dispatch_requests
     set state = 'queued',
         available_at = least(expires_at, now() + make_interval(secs => v_delay)),
         lease_owner = null,
         lease_token_hash = null,
         lease_expires_at = null,
         delivery_attempt_id = null,
         delivery_deadline_at = null,
         error_json = jsonb_build_object(
           'code', v_reason,
           'message', 'The bridge deferred delivery before Send.'
         ),
         progress_json = jsonb_build_object(
           'stage', 'queued',
           'reason', v_reason,
           'attempt_count', v_request.attempt_count
         ),
         updated_at = now()
   where id = v_request.id
   returning * into v_request;

  return jsonb_build_object(
    'id', v_request.id,
    'state', v_request.state,
    'available_at', v_request.available_at,
    'attempt_count', v_request.attempt_count,
    'idempotent', false
  );
end;
$$;

revoke all on function public.chatgpt_bridge_service_defer_dispatch(uuid, uuid, text, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_defer_dispatch(uuid, uuid, text, uuid, integer, text) to service_role;
