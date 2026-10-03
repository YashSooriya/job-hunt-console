-- A response may be captured locally after the server's bounded response
-- deadline. Allow upload-only recovery for this one confirmed-sent terminal
-- state; never reopen an unsent, ambiguous, revoked, or otherwise terminal
-- dispatch, and never authorize a second ChatGPT Send.
create or replace function public.chatgpt_bridge_service_reopen_response_capture(
  p_device_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_lease text := private.chatgpt_urlsafe_token();
  v_deadline timestamptz;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;

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
  if v_request.target_device_id is distinct from p_device_id then
    raise exception 'Dispatch recovery device is invalid';
  end if;
  if v_request.state = 'completed' then
    return jsonb_build_object('id', v_request.id, 'state', 'completed', 'idempotent', true);
  end if;
  if v_request.sent_at is null or v_request.state not in ('user_required', 'sent') then
    raise exception 'Only a sent response may be reopened';
  end if;

  if v_request.state = 'user_required' then
    if coalesce(v_request.error_json->>'code', '') <> 'response_capture_timeout'
       or v_request.send_attempted_at is null
       or v_request.sent_confirmed_at is null
       or v_request.delivery_attempt_id is null
       or v_request.response_hash is not null then
      raise exception 'Only a confirmed-sent response timeout may be reopened';
    end if;
    -- Request expiry must not discard an exact response already captured for
    -- this sent turn. The renewed lease is still bounded by the original
    -- per-request timeout and grants no permission to send another message.
    v_deadline := now() + make_interval(secs => least(greatest(coalesce(v_request.timeout_seconds, 300), 60), 86400));
  else
    v_deadline := least(
      v_request.expires_at,
      now() + make_interval(secs => greatest(coalesce(v_request.timeout_seconds, 300), 60))
    );
  end if;
  if v_deadline <= now() then raise exception 'Dispatch recovery deadline has expired'; end if;

  update public.chatgpt_dispatch_requests
     set state = 'sent',
         lease_owner = p_device_id::text,
         lease_token_hash = private.chatgpt_token_hash(v_lease),
         lease_expires_at = v_deadline,
         response_deadline_at = v_deadline,
         error_json = null,
         updated_at = now()
   where id = v_request.id
   returning * into v_request;

  return jsonb_build_object(
    'id', v_request.id,
    'state', 'sent',
    'lease_token', v_lease,
    'lease_expires_at', v_deadline,
    'delivery_attempt_id', v_request.delivery_attempt_id,
    'idempotent', false
  );
end;
$function$;

revoke all on function public.chatgpt_bridge_service_reopen_response_capture(uuid, uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_reopen_response_capture(uuid, uuid) to service_role;
