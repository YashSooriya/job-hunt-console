-- Keep a one-time Website Bridge Send authorization alive when a local
-- delivery timeout races the authorize_send RPC. Once the server has consumed
-- the send fence, stopping the row would hide a prompt that may already have
-- been clicked and would discard the only safe response-recovery lease.
-- Return the active state idempotently instead; the extension's read-only
-- recovery loop will confirm the exact user turn and capture the response.

create or replace function public.chatgpt_bridge_service_stop_dispatch_v2(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_attempt_id uuid,
  p_code text,
  p_message text
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
  if v_request.state in ('completed','failed','cancelled','expired','user_required') then
    return jsonb_build_object('id', v_request.id, 'state', v_request.state, 'idempotent', true);
  end if;
  if v_request.delivery_attempt_id is distinct from p_attempt_id
     or v_request.lease_token_hash is distinct from p_lease_token_hash then
    raise exception 'Dispatch stop lease is invalid';
  end if;

  -- Never convert an authorized or confirmed send into user_required. The
  -- content script may already have clicked Send, and only exact-turn
  -- read-only recovery is safe after this point.
  if v_request.state in ('send_attempted','sent','acknowledged_by_mcp','running')
     or v_request.send_attempted_at is not null
     or v_request.sent_at is not null then
    return jsonb_build_object(
      'id', v_request.id,
      'state', v_request.state,
      'idempotent', true,
      'send_attempted', v_request.send_attempted_at is not null,
      'sent_confirmed', v_request.sent_confirmed_at is not null
    );
  end if;

  update public.chatgpt_dispatch_requests
     set state = 'user_required',
         user_required_at = coalesce(user_required_at, now()),
         error_json = jsonb_build_object(
           'code', left(coalesce(nullif(p_code, ''), 'user_required'), 120),
           'message', left(coalesce(nullif(p_message, ''), 'The bridge stopped safely.'), 500)
         ),
         progress_json = jsonb_build_object(
           'stage', 'user_required',
           'protocol', 'v2',
           'code', left(coalesce(nullif(p_code, ''), 'user_required'), 120)
         ),
         lease_owner = null,
         lease_token_hash = null,
         lease_expires_at = null,
         updated_at = now()
   where id = v_request.id
   returning * into v_request;
  return jsonb_build_object('id', v_request.id, 'state', v_request.state, 'idempotent', false);
end;
$$;

revoke all on function public.chatgpt_bridge_service_stop_dispatch_v2(uuid,uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_stop_dispatch_v2(uuid,uuid,text,uuid,text,text) to service_role;
