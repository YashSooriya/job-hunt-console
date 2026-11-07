-- M04: persist terminal per-entry outcomes without weakening exact-response provenance.

create or replace function private.save_job_url_inspection_initial_fit_outcome_for_user(
  p_user_id uuid,
  p_request_id uuid,
  p_dispatch_id uuid,
  p_response_hash text,
  p_fit_status text,
  p_fit_error text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request public.job_url_inspection_requests;
  v_dispatch public.chatgpt_dispatch_requests;
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid()) then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if p_request_id is null or p_dispatch_id is null or coalesce(p_response_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'The exact combined-import response identity is required';
  end if;
  if p_fit_status not in ('listing_unavailable','wrong_listing','invalid_response','missing_result','needs_user') then
    raise exception 'Only a non-assessed terminal fit outcome may use this operation';
  end if;
  if length(coalesce(p_fit_error,''))>1800 then raise exception 'The initial fit explanation is too long'; end if;

  select * into v_request from public.job_url_inspection_requests
   where id=p_request_id and user_id=p_user_id for update;
  if not found or v_request.batch_id is null or v_request.dispatch_request_id is distinct from p_dispatch_id then
    raise exception 'The fit outcome is not linked to this exact owner-scoped URL-import batch';
  end if;
  if v_request.initial_fit_response_hash is not null then
    if v_request.initial_fit_response_hash=p_response_hash and v_request.initial_fit_status=p_fit_status then
      return jsonb_build_object('request_id',v_request.id,'fit_status',v_request.initial_fit_status,'idempotent',true);
    end if;
    raise exception 'The initial fit outcome is already final for another captured response';
  end if;
  if v_request.initial_fit_status is not null and v_request.initial_fit_status<>'pending' then
    raise exception 'The initial fit outcome is already final';
  end if;
  if v_request.job_id is null and v_request.status not in ('failed','user_required') then
    raise exception 'A listing without a saved job must have a terminal inspection result';
  end if;

  select * into v_dispatch from public.chatgpt_dispatch_requests
   where id=p_dispatch_id and user_id=p_user_id for share;
  if not found or v_dispatch.action_type<>'job.inspect_url' or v_dispatch.state<>'completed'
     or v_dispatch.response_hash is distinct from p_response_hash or v_dispatch.bridge_response is null
     or encode(extensions.digest(convert_to(btrim(v_dispatch.bridge_response),'utf8'),'sha256'),'hex') is distinct from p_response_hash
     or v_dispatch.output_refs->>'response_provenance_recorded' is distinct from 'true'
     or v_dispatch.response_provenance is null then
    raise exception 'The fit outcome does not match the exact captured Website Bridge response';
  end if;
  perform private.chatgpt_validate_response_provenance(v_dispatch.response_provenance,v_dispatch);

  update public.job_url_inspection_requests
     set initial_fit_status=p_fit_status,
         initial_fit_error=nullif(left(coalesce(p_fit_error,''),1000),''),
         initial_fit_response_hash=p_response_hash,
         updated_at=now()
   where id=v_request.id and user_id=p_user_id;
  return jsonb_build_object('request_id',v_request.id,'fit_status',p_fit_status,'idempotent',false);
end;
$$;
revoke all on function private.save_job_url_inspection_initial_fit_outcome_for_user(uuid,uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function private.save_job_url_inspection_initial_fit_outcome_for_user(uuid,uuid,uuid,text,text,text) to authenticated;

create or replace function public.save_job_url_inspection_initial_fit_outcome(
  p_request_id uuid,
  p_dispatch_id uuid,
  p_response_hash text,
  p_fit_status text,
  p_fit_error text default null
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.save_job_url_inspection_initial_fit_outcome_for_user(
    (select auth.uid()),p_request_id,p_dispatch_id,p_response_hash,p_fit_status,p_fit_error
  );
$$;
revoke all on function public.save_job_url_inspection_initial_fit_outcome(uuid,uuid,text,text,text) from public,anon,service_role;
grant execute on function public.save_job_url_inspection_initial_fit_outcome(uuid,uuid,text,text,text) to authenticated;

create or replace function private.mark_job_url_inspection_initial_fit_needs_user_for_user(
  p_user_id uuid,
  p_request_id uuid,
  p_dispatch_id uuid,
  p_fit_error text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request public.job_url_inspection_requests;
  v_dispatch public.chatgpt_dispatch_requests;
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid()) then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if p_request_id is null or length(coalesce(p_fit_error,''))>1800 then raise exception 'The fit attention request is invalid'; end if;

  select * into v_request from public.job_url_inspection_requests
   where id=p_request_id and user_id=p_user_id for update;
  if not found or v_request.batch_id is null
     or not (v_request.status in ('failed','user_required') or (v_request.status='completed' and v_request.job_id is not null)) then
    raise exception 'The URL-import item is not in a terminal attention state';
  end if;
  if p_dispatch_id is distinct from v_request.dispatch_request_id then
    raise exception 'The fit attention request is not linked to this exact URL-import dispatch';
  end if;
  if v_request.initial_fit_response_hash is not null then
    raise exception 'A captured fit outcome cannot be replaced by an unverified attention status';
  end if;
  if v_request.initial_fit_status is not null and v_request.initial_fit_status not in ('pending','needs_user') then
    raise exception 'The initial fit outcome is already final';
  end if;

  if p_dispatch_id is not null then
    select * into v_dispatch from public.chatgpt_dispatch_requests
     where id=p_dispatch_id and user_id=p_user_id for share;
    if found and (v_dispatch.action_type<>'job.inspect_url' or v_dispatch.state not in ('failed','user_required','expired','cancelled','completed')) then
      raise exception 'The URL-import dispatch has not reached a terminal state';
    end if;
  end if;

  update public.job_url_inspection_requests
     set initial_fit_status='needs_user',
         initial_fit_error=nullif(left(coalesce(p_fit_error,''),1000),''),
         updated_at=now()
   where id=v_request.id and user_id=p_user_id;
  return jsonb_build_object('request_id',v_request.id,'fit_status','needs_user','idempotent',v_request.initial_fit_status='needs_user');
end;
$$;
revoke all on function private.mark_job_url_inspection_initial_fit_needs_user_for_user(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.mark_job_url_inspection_initial_fit_needs_user_for_user(uuid,uuid,uuid,text) to authenticated;

create or replace function public.mark_job_url_inspection_initial_fit_needs_user(
  p_request_id uuid,
  p_dispatch_id uuid default null,
  p_fit_error text default null
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.mark_job_url_inspection_initial_fit_needs_user_for_user(
    (select auth.uid()),p_request_id,p_dispatch_id,p_fit_error
  );
$$;
revoke all on function public.mark_job_url_inspection_initial_fit_needs_user(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.mark_job_url_inspection_initial_fit_needs_user(uuid,uuid,text) to authenticated;

comment on function public.save_job_url_inspection_initial_fit_outcome(uuid,uuid,text,text,text) is 'Owner-scoped exact-provenance persistence for a captured non-assessed combined URL-import outcome.';
comment on function public.mark_job_url_inspection_initial_fit_needs_user(uuid,uuid,text) is 'Marks a terminal URL-import item for attention when no verifiable fit result can be established; it never records response provenance.';
