-- M37 follow-up: lifecycle writes are queued in the extension so they never
-- slow the one-time Send operation. A worker can therefore finish the final
-- markers after the completion RPC has already moved the row to `completed`.

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

  if v_request.state in ('completed','sent','acknowledged_by_mcp','running')
     and v_request.target_device_id is not distinct from p_device_id
     and v_request.sent_at is not null
     and v_request.lease_token_hash is null then
    -- A v1 post-send row has no lease. Lifecycle is an allow-listed
    -- observability record and cannot authorize another browser action.
    null;
  elsif v_request.state in ('failed','cancelled','expired','user_required') then
    raise exception 'A terminal bridge dispatch cannot receive lifecycle updates';
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

  -- The private merge function remains the single allow-list, size, timestamp
  -- parsing, and monotonic-order validator for every caller.
  v_lifecycle := private.chatgpt_bridge_merge_lifecycle(v_request.lifecycle_json, p_lifecycle);
  update public.chatgpt_dispatch_requests
     set lifecycle_json=v_lifecycle, updated_at=now()
   where id=v_request.id
   returning * into v_request;
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'lifecycle',v_request.lifecycle_json);
end;
$$;

revoke all on function public.chatgpt_bridge_service_record_dispatch_lifecycle(uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_record_dispatch_lifecycle(uuid,uuid,text,uuid,jsonb) to service_role;
