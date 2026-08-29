-- Preserve bounded Website Bridge delivery timing in audit metadata.
--
-- The dispatch row intentionally keeps only the latest progress object, so
-- its timing is overwritten by later response-capture states.  The extension
-- sends only numeric stage durations here; this migration stores those values
-- on the corresponding audit event without storing the instruction or any
-- ChatGPT response content.
create or replace function public.chatgpt_bridge_service_update_dispatch(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_state text,
  p_progress jsonb default '{}'::jsonb,
  p_error jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_ok boolean := false;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  if p_state not in ('opening_chatgpt','composer_ready','sent','user_required','failed') then raise exception 'The extension cannot set that dispatch state'; end if;
  if jsonb_typeof(coalesce(p_progress,'{}'::jsonb)) <> 'object' or length(coalesce(p_progress,'{}'::jsonb)::text)>4000 then raise exception 'Dispatch progress must be a small object'; end if;
  if p_error is not null and (jsonb_typeof(p_error) <> 'object' or length(p_error::text)>4000) then raise exception 'Dispatch error must be an object'; end if;
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state in ('completed','failed','cancelled','expired','user_required') then return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true); end if;
  if v_request.lease_token_hash is distinct from p_lease_token_hash or v_request.target_device_id is distinct from p_device_id then raise exception 'Dispatch lease is invalid or has expired'; end if;
  if v_request.lease_expires_at is null or v_request.lease_expires_at<=now() then raise exception 'Dispatch lease has expired'; end if;
  v_ok := (v_request.state='claimed_by_extension' and p_state in ('opening_chatgpt','user_required','failed'))
       or (v_request.state='opening_chatgpt' and p_state in ('composer_ready','user_required','failed'))
       or (v_request.state='composer_ready' and p_state in ('sent','user_required','failed'))
       or (v_request.state='sent' and p_state in ('user_required','failed'));
  if not v_ok then raise exception 'Invalid browser delivery transition from % to %',v_request.state,p_state; end if;
  update public.chatgpt_dispatch_requests set
    state=p_state,
    progress_json=coalesce(p_progress,'{}'::jsonb),
    error_json=case when p_state in ('user_required','failed') then coalesce(p_error,jsonb_build_object('code',p_state,'message','The bridge stopped before completion.')) else null end,
    sent_at=case when p_state='sent' then coalesce(sent_at,now()) else sent_at end,
    user_required_at=case when p_state='user_required' then coalesce(user_required_at,now()) else user_required_at end,
    failed_at=case when p_state='failed' then coalesce(failed_at,now()) else failed_at end,
    lease_token_hash=case when p_state in ('user_required','failed') then null else lease_token_hash end,
    lease_expires_at=case
      when p_state in ('user_required','failed') then null
      when p_state='sent' then now() + make_interval(secs => greatest(coalesce(v_request.timeout_seconds,300) + 120,300))
      else lease_expires_at
    end,
    updated_at=now()
  where id=v_request.id returning * into v_request;
  if p_state in ('user_required','failed') and v_request.action_type='job.inspect_url' and (v_request.subject_refs ? 'inspection_id') then
    update public.job_url_inspection_requests
       set status=p_state,
           error_json=coalesce(p_error,jsonb_build_object('code',p_state,'message','The ChatGPT bridge stopped before inspection completion.')),
           updated_at=now()
     where id=(v_request.subject_refs->>'inspection_id')::uuid
       and user_id=v_device.user_id
       and status in ('queued','processing');
  end if;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_device.user_id,'system','chatgpt-bridge','chatgpt_bridge.dispatch_'||p_state,'chatgpt_dispatch_request',v_request.id,
    jsonb_strip_nulls(jsonb_build_object(
      'correlation_id',v_request.correlation_id,
      'device_id',v_device.id,
      'timing',case when jsonb_typeof(p_progress->'timing')='object' then p_progress->'timing' else null end
    )));
  return jsonb_build_object('id',v_request.id,'state',v_request.state,'progress',v_request.progress_json,'error',v_request.error_json,'idempotent',false);
end;
$$;
revoke all on function public.chatgpt_bridge_service_update_dispatch(uuid,uuid,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_update_dispatch(uuid,uuid,text,text,jsonb,jsonb) to service_role;
