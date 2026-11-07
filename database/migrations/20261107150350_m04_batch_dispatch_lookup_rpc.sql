-- The dispatch table has no direct authenticated-client grants. Expose only
-- the exact batch's minimal dispatch identity through an owner-scoped RPC so
-- recovery can distinguish its own orphan from another active operation.
create or replace function public.get_job_url_inspection_batch_dispatch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_dispatch public.chatgpt_dispatch_requests;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_batch_id is null then raise exception 'A URL-import batch identity is required'; end if;
  if not exists(select 1 from public.job_url_inspection_requests where user_id=v_user and batch_id=p_batch_id) then
    return null;
  end if;
  select * into v_dispatch
    from public.chatgpt_dispatch_requests
   where user_id=v_user and idempotency_key='job.inspect_url.batch:'||p_batch_id::text;
  if not found then return null; end if;
  return jsonb_build_object(
    'id',v_dispatch.id,'action_type',v_dispatch.action_type,
    'state',v_dispatch.state,'idempotency_key',v_dispatch.idempotency_key
  );
end;
$$;
revoke all on function public.get_job_url_inspection_batch_dispatch(uuid) from public,anon,service_role;
grant execute on function public.get_job_url_inspection_batch_dispatch(uuid) to authenticated;
comment on function public.get_job_url_inspection_batch_dispatch(uuid) is
  'Returns only the authenticated owner’s minimal dispatch identity for an existing URL-import batch.';

notify pgrst, 'reload schema';
