-- M42: quarantine queued work that an older paired bridge can no longer
-- deliver safely.  This is deliberately limited to the pre-Send states: a
-- request with a durable Send boundary is left for the existing reconciliation
-- and manual-review paths because ChatGPT may already have seen it.

do $$
declare
  v_request record;
begin
  for v_request in
    select r.id, r.user_id, r.work_item_id, r.correlation_id
      from public.chatgpt_dispatch_requests r
      join public.chatgpt_bridge_devices d on d.id=r.target_device_id
     where r.state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready')
       and r.send_attempted_at is null
       and r.sent_at is null
       and not coalesce(d.capabilities @> '{"result_completion_v3":true,"response_provenance_v3":true}'::jsonb, false)
       and d.revoked_at is null
  loop
    update public.chatgpt_dispatch_requests
       set state='cancelled',
           cancelled_at=coalesce(cancelled_at,now()),
           lease_owner=null,
           lease_token_hash=null,
           lease_expires_at=null,
           error_json=jsonb_build_object(
             'code','bridge_upgrade_required',
             'message','The queued request was quarantined because its paired Website Bridge did not support the v3 result-completion contract. No ChatGPT message was sent.'
           ),
           progress_json=coalesce(progress_json,'{}'::jsonb)||jsonb_build_object('stage','cancelled','code','bridge_upgrade_required'),
           updated_at=now()
     where id=v_request.id;

    update public.chatgpt_work_items
       set state='failed',
           error_json=jsonb_build_object('code','bridge_upgrade_required','message','Dispatch quarantined until the Website Bridge is upgraded.'),
           failed_at=coalesce(failed_at,now()),
           lease_token=null,
           lease_expires_at=null,
           updated_at=now()
     where id=v_request.work_item_id
       and state in ('queued','leased','running','user_required');

    insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(
      v_request.user_id,
      'system',
      'chatgpt_bridge_readiness',
      'chatgpt_bridge.dispatch_quarantined',
      'chatgpt_dispatch_request',
      v_request.id,
      jsonb_build_object('correlation_id',v_request.correlation_id,'reason','bridge_upgrade_required')
    );
  end loop;
end;
$$;
