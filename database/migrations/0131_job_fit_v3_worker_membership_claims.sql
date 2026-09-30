-- The V3 scheduler calls the authenticated, owner-scoped batch/result routines
-- from a narrowly granted service-role boundary. A service JWT has no user
-- email claim, while current_user_active_member() intentionally checks both
-- auth.uid() and the verified membership email. Reconstruct only those
-- transaction-local claims from the active server-side membership row before
-- entering the existing user RPCs; this does not change the database role or
-- widen any table or function privilege.

create or replace function private.job_fit_v3_worker_create_batch_internal(
  p_user_id uuid,p_request_id uuid,p_mode text,p_job_ids uuid[],p_tasks jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_batch_id uuid; v_member_email text;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_user_id is null then raise exception 'User is required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  select lower(m.email) into v_member_email
    from private.app_memberships m where m.user_id=p_user_id and m.status='active' for share;
  if v_member_email is null then raise exception 'Active Job Hunt Console membership required'; end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',p_user_id::text,'role','authenticated','email',v_member_email
  )::text,true);
  v_result:=public.create_job_fit_v3_batch(p_request_id,p_mode,p_job_ids,p_tasks);
  v_batch_id:=(v_result->>'batch_id')::uuid;
  insert into public.job_fit_v3_inputs(task_id,user_id,generation,input_hash,input_payload,steps,created_at)
  select t.id,t.user_id,1,t.input_hash,t.input_payload,t.steps,t.created_at
    from public.job_fit_v3_tasks t where t.batch_id=v_batch_id
  on conflict(task_id,generation) do nothing;
  update public.job_fit_v3_tasks t set current_input_id=i.id
    from public.job_fit_v3_inputs i
   where i.task_id=t.id and i.generation=1 and t.batch_id=v_batch_id and t.current_input_id is null;
  return v_result;
end;
$$;

create or replace function private.job_fit_v3_save_result_internal(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_task public.job_fit_v3_tasks; v_result_id uuid; v_member_email text;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if p_lease_token is null then raise exception 'A fit scheduler lease is required to publish a captured result'; end if;
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id for update;
  if not found then raise exception 'Fit task not found'; end if;
  if v_task.scheduler_lease_token is distinct from p_lease_token
    or v_task.scheduler_lease_expires_at is null or v_task.scheduler_lease_expires_at<=now() then
    raise exception 'Fit scheduler lease expired before result publication';
  end if;
  select lower(m.email) into v_member_email
    from private.app_memberships m where m.user_id=p_user_id and m.status='active' for share;
  if v_member_email is null then raise exception 'Active Job Hunt Console membership required'; end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',p_user_id::text,'role','authenticated','email',v_member_email
  )::text,true);
  v_result:=public.save_job_fit_v3_result(p_task_id);
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id;
  if v_task.state='completed' and v_task.result_json is not null then
    insert into public.job_fit_v3_results(task_id,user_id,input_hash,result_json,analysis_id)
    values(v_task.id,v_task.user_id,v_task.input_hash,v_task.result_json,v_task.analysis_id)
    on conflict(task_id) do nothing returning id into v_result_id;
    if v_result_id is null then select id into v_result_id from public.job_fit_v3_results where task_id=v_task.id; end if;
    insert into public.job_fit_v3_evidence_references(result_id,task_id,user_id,analysis_reference,evidence_reference,quote)
    select v_result_id,v_task.id,v_task.user_id,requirement->>'analysis_reference',evidence->>'reference',evidence->>'quote'
      from jsonb_array_elements(v_task.result_json->'requirements') requirement
      cross join lateral jsonb_array_elements(coalesce(requirement->'evidence_quotes','[]'::jsonb)) evidence
     where jsonb_typeof(evidence)='object'
    on conflict(result_id,analysis_reference,evidence_reference,quote) do nothing;
  end if;
  update public.job_fit_v3_tasks set scheduler_lease_token=null,scheduler_lease_expires_at=null where id=p_task_id and user_id=p_user_id;
  return v_result;
end;
$$;

-- CREATE OR REPLACE retains the existing service-only ACL, but state the
-- intended grant explicitly so a future schema restore cannot broaden it.
revoke all on function private.job_fit_v3_worker_create_batch_internal(uuid,uuid,text,uuid[],jsonb) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_create_batch_internal(uuid,uuid,text,uuid[],jsonb) to service_role;
revoke all on function private.job_fit_v3_save_result_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_save_result_internal(uuid,uuid,uuid) to service_role;
