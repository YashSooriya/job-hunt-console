-- M37 follow-up: a legacy v1 send clears its delivery lease as soon as the
-- server records `sent`. Allow that bound device to publish the subsequent
-- response-detected marker without reopening a delivery lease. This remains
-- content-free and cannot authorize another Send.

create or replace function public.chatgpt_bridge_service_record_dispatch_lifecycle(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text default null,
  p_attempt_id uuid default null,
  p_lifecycle jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_lifecycle jsonb;
  v_key text;
  v_post_send_observation boolean := false;
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

  if v_request.state='completed' then
    for v_key in select key from jsonb_object_keys(coalesce(p_lifecycle, '{}'::jsonb)) key loop
      if v_key not in ('response_uploaded_at','recovery_phase') then
        raise exception 'Only the upload marker may be recorded after completion';
      end if;
    end loop;
  elsif v_request.state in ('failed','cancelled','expired','user_required') then
    raise exception 'A terminal bridge dispatch cannot receive lifecycle updates';
  elsif v_request.state in ('sent','acknowledged_by_mcp','running')
        and v_request.sent_at is not null
        and v_request.target_device_id is not distinct from p_device_id
        and v_request.lease_token_hash is null then
    -- v1 clears its lease when it transitions to sent. This branch records
    -- only post-send observation markers for that same target device.
    v_post_send_observation := true;
    for v_key in select key from jsonb_object_keys(coalesce(p_lifecycle, '{}'::jsonb)) key loop
      if v_key not in ('response_detected_at','response_uploaded_at','recovery_phase') then
        raise exception 'Only post-send observation markers may be recorded without a lease';
      end if;
    end loop;
  else
    if v_request.target_device_id is distinct from p_device_id
       or v_request.lease_token_hash is distinct from p_lease_token_hash
       or v_request.lease_expires_at is null
       or v_request.lease_expires_at <= now() then
      raise exception 'Dispatch lifecycle lease is invalid or has expired';
    end if;
    if p_attempt_id is not null and v_request.delivery_attempt_id is distinct from p_attempt_id then
      raise exception 'Dispatch lifecycle attempt is invalid';
    end if;
  end if;

  v_lifecycle := private.chatgpt_bridge_merge_lifecycle(v_request.lifecycle_json, p_lifecycle);
  update public.chatgpt_dispatch_requests
     set lifecycle_json=v_lifecycle, updated_at=now()
   where id=v_request.id
   returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'lifecycle',v_request.lifecycle_json,'post_send_observation',v_post_send_observation);
end;
$$;

revoke all on function public.chatgpt_bridge_service_record_dispatch_lifecycle(uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_record_dispatch_lifecycle(uuid,uuid,text,uuid,jsonb) to service_role;
