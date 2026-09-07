-- M31: expose a safe v2 active-dispatch snapshot for recovery and make the
-- capability-negotiated protocol observable without exposing lease secrets.

create or replace function public.chatgpt_bridge_service_get_active_dispatches(
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_dispatches jsonb;
begin
  if coalesce((select auth.jwt()->>'role'),'') <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select * into v_device
    from public.chatgpt_bridge_devices
   where id = p_device_id
     and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);

  -- This snapshot deliberately contains no lease token or token hash. It is
  -- enough for a restarted extension to decide whether to inspect the exact
  -- existing turn, while a missing local lease can never authorise a resend.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'state', r.state,
    'action_type', r.action_type,
    'display_title', r.display_title,
    'instruction', r.manual_instruction,
    'correlation_id', r.correlation_id,
    'workflow_key', slot.workflow_key,
    'workflow_display_name', slot.display_name,
    'bound_conversation_url', slot.conversation_url,
    'bound_project_name', slot.project_name,
    'bound_project_verified', slot.project_verified_at is not null,
    'delivery_attempt_id', r.delivery_attempt_id,
    'send_attempted', r.send_attempted_at is not null,
    'sent_confirmed', r.sent_confirmed_at is not null,
    'turn_anchor', r.delivery_turn_anchor,
    'user_turn_fingerprint', r.delivery_user_turn_fingerprint,
    'user_turn_message_id', r.delivery_user_turn_message_id,
    'delivery_deadline_at', r.delivery_deadline_at,
    'response_deadline_at', r.response_deadline_at,
    'lease_expires_at', r.lease_expires_at,
    'response_check_only', coalesce((r.progress_json->>'response_check_only')::boolean, false),
    'progress', r.progress_json,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  ) order by r.created_at), '[]'::jsonb)
    into v_dispatches
    from public.chatgpt_dispatch_requests r
    join lateral (
      select s.workflow_key, s.display_name, s.conversation_url,
             s.project_name, s.project_verified_at
        from public.chatgpt_bridge_conversation_slots s
       where s.device_id = p_device_id
         and s.workflow_key = private.chatgpt_bridge_workflow_key(r.action_type)
         and s.active
       order by s.updated_at desc nulls last
       limit 1
    ) slot on true
   where r.user_id = v_device.user_id
     and r.target_device_id = p_device_id
     and r.state in (
       'claimed_by_extension','opening_chatgpt','composer_ready','send_attempted',
       'sent','acknowledged_by_mcp','running'
     )
     and r.expires_at > now();

  return jsonb_build_object('protocol', 'v2', 'dispatches', v_dispatches);
end;
$$;

revoke all on function public.chatgpt_bridge_service_get_active_dispatches(uuid) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_get_active_dispatches(uuid) to service_role;
