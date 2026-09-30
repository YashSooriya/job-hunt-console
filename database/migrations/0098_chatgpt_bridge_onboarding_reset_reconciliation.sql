-- M40: allow the existing ownership-checked dispatch cancellation boundary to
-- abandon sent/result-pending onboarding work during a profile reset.
--
-- The request state changes only in JobHuntAI. ChatGPT conversation history is
-- never edited, and the existing public RPC signature is preserved so the
-- security-definer inventory does not gain an unreviewed overload.

create or replace function public.cancel_chatgpt_dispatch_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.chatgpt_dispatch_requests;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=p_request_id and user_id=v_user
   for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  if v_request.state in ('completed','failed','expired','cancelled') then
    return jsonb_build_object('id',v_request.id,'state',v_request.state,'idempotent',true);
  end if;

  -- Cancellation is also safe after Send: it prevents a captured result from
  -- being imported after onboarding data has been reset, while leaving the
  -- already-visible ChatGPT message untouched.
  update public.chatgpt_dispatch_requests
     set state='cancelled',
         cancelled_at=coalesce(cancelled_at,now()),
         lease_owner=null,
         lease_token_hash=null,
         lease_expires_at=null,
         error_json=jsonb_build_object('code','cancelled','message','The dispatch was cancelled by the user or an onboarding reset. ChatGPT conversation history was not changed.'),
         progress_json=coalesce(progress_json,'{}'::jsonb)||jsonb_build_object('stage','cancelled','code','cancelled'),
         updated_at=now()
   where id=v_request.id and user_id=v_user;

  if v_request.action_type='job.inspect_url' and (v_request.subject_refs ? 'inspection_id') then
    update public.job_url_inspection_requests
       set status='failed',
           error_json=jsonb_build_object('code','cancelled','message','Inspection dispatch cancelled by the user.'),
           updated_at=now()
     where id=(v_request.subject_refs->>'inspection_id')::uuid
       and user_id=v_user
       and status in ('queued','processing');
  end if;
  update public.chatgpt_work_items
     set state='failed',
         error_json=jsonb_build_object('code','cancelled','message','Dispatch cancelled by the user.'),
         failed_at=coalesce(failed_at,now()),
         lease_token=null,
         lease_expires_at=null,
         updated_at=now()
   where id=v_request.work_item_id
     and state in ('queued','leased','running','user_required');
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'chatgpt_bridge.dispatch_cancelled','chatgpt_dispatch_request',v_request.id,jsonb_build_object('correlation_id',v_request.correlation_id,'reason','user_or_onboarding_reset'));
  return jsonb_build_object('id',v_request.id,'state','cancelled','idempotent',false);
end;
$$;

revoke all on function public.cancel_chatgpt_dispatch_request(uuid) from public, anon;
grant execute on function public.cancel_chatgpt_dispatch_request(uuid) to authenticated;
