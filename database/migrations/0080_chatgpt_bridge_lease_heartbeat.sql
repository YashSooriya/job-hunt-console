-- Keep an actively handled Website Bridge request leased while ChatGPT is
-- thinking or rendering a response. If the extension disappears, the lease
-- still expires normally and the existing safe-stop recovery remains in force.
create or replace function public.chatgpt_bridge_service_touch_dispatch(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_lease_seconds integer;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
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
  if v_request.state not in ('claimed_by_extension','opening_chatgpt','composer_ready','sent') then
    return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true);
  end if;
  if v_request.lease_token_hash is distinct from p_lease_token_hash
     or v_request.target_device_id is distinct from p_device_id then
    raise exception 'Dispatch lease is invalid or has expired';
  end if;
  if v_request.lease_expires_at is null or v_request.lease_expires_at<=now() then
    raise exception 'Dispatch lease has expired';
  end if;

  v_lease_seconds := greatest(coalesce(v_request.timeout_seconds,300) + 120,300);
  update public.chatgpt_dispatch_requests
     set lease_expires_at=now()+make_interval(secs=>v_lease_seconds),
         updated_at=now()
   where id=v_request.id
   returning * into v_request;

  return jsonb_build_object(
    'id',v_request.id,
    'state',v_request.state,
    'lease_expires_at',v_request.lease_expires_at,
    'idempotent',false
  );
end;
$$;

revoke all on function public.chatgpt_bridge_service_touch_dispatch(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_touch_dispatch(uuid,uuid,text) to service_role;
