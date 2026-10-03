begin;

-- Let the minute scheduler finish an already-created Memory-only batch after
-- the Jobs page closes. The worker can only use the normal Website Bridge
-- dispatch contract and the existing exact-turn capture/result functions.
alter table public.job_fit_memory_v4_items
  drop constraint if exists job_fit_memory_v4_items_state_check;
alter table public.job_fit_memory_v4_items
  add constraint job_fit_memory_v4_items_state_check
  check (state in ('queued','saving','assessed','insufficient_memory','listing_unavailable','wrong_listing','invalid_response','missing_result','needs_user'));

alter table public.job_fit_memory_v4_batches
  add column advance_lease_token uuid;
alter table public.job_fit_memory_v4_batches
  add column advance_lease_expires_at timestamptz;

alter table public.job_fit_memory_v4_batches
  add constraint job_fit_memory_v4_batch_advance_lease_pair
  check ((advance_lease_token is null) = (advance_lease_expires_at is null));

create index job_fit_memory_v4_background_due
  on public.job_fit_memory_v4_batches(advance_lease_expires_at,updated_at)
  where state in ('queued','processing','partial');

create or replace function private.job_fit_memory_v4_worker_claim_internal(p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_row record;
  v_token uuid;
  v_claims jsonb := '[]'::jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_limit is null or p_limit<1 or p_limit>5 then raise exception 'Invalid Memory-fit worker claim size'; end if;
  for v_row in
    select b.id,b.user_id
      from public.job_fit_memory_v4_batches b
     where b.state in ('queued','processing','partial')
       and exists(select 1 from private.app_memberships m where m.user_id=b.user_id and m.status='active')
       and (b.advance_lease_expires_at is null or b.advance_lease_expires_at<=now())
       and exists(select 1 from public.job_fit_memory_v4_chunks c where c.batch_id=b.id and c.state in ('queued','waiting_for_bridge','saving'))
     order by b.updated_at,b.created_at
     limit p_limit
     for update of b skip locked
  loop
    v_token:=gen_random_uuid();
    update public.job_fit_memory_v4_batches
       set advance_lease_token=v_token,advance_lease_expires_at=now()+interval '90 seconds',updated_at=now()
     where id=v_row.id;
    v_claims:=v_claims||jsonb_build_array(jsonb_build_object('batch_id',v_row.id,'user_id',v_row.user_id,'lease_token',v_token));
  end loop;
  return v_claims;
end;
$$;
revoke all on function private.job_fit_memory_v4_worker_claim_internal(integer) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_memory_v4_worker_claim_internal(integer) to service_role;

create or replace function private.job_fit_memory_v4_worker_context_internal(p_user_id uuid,p_batch_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_batch public.job_fit_memory_v4_batches;
  v_chunk public.job_fit_memory_v4_chunks;
  v_items jsonb;
  v_dispatch jsonb;
  v_preferences jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_user_id is null or p_batch_id is null or p_lease_token is null then raise exception 'Memory-fit worker lease is required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  select * into v_batch from public.job_fit_memory_v4_batches b
   where b.id=p_batch_id and b.user_id=p_user_id and b.advance_lease_token=p_lease_token
     and b.advance_lease_expires_at>now() for update;
  if not found then raise exception 'Memory-fit worker lease expired'; end if;

  select * into v_chunk from public.job_fit_memory_v4_chunks c where c.batch_id=p_batch_id
    and c.user_id=p_user_id and c.state in ('waiting_for_bridge','saving') order by c.ordinal limit 1 for update;
  if not found then
    select * into v_chunk from public.job_fit_memory_v4_chunks c where c.batch_id=p_batch_id
      and c.user_id=p_user_id and c.state='queued' order by c.ordinal limit 1 for update;
  end if;
  if not found then
    return jsonb_build_object('batch',jsonb_build_object('id',v_batch.id,'user_id',v_batch.user_id,
      'request_id',v_batch.request_id,'state',v_batch.state,'assessment_as_of',v_batch.assessment_as_of,
      'testing_mode',v_batch.testing_mode,'requested_count',v_batch.requested_count),
      'chunk',null,'items','[]'::jsonb,'preferences','{}'::jsonb,'dispatch',null);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'item',jsonb_build_object('id',i.id,'chunk_id',i.chunk_id,'job_id',i.job_id,'listing_url',i.listing_url,
      'job_revision',i.job_revision,'state',i.state,'result_json',i.result_json,'analysis_id',i.analysis_id,
      'error_message',i.error_message),
    'job',jsonb_build_object('id',j.id,'title',j.title,'industry',j.industry,'source_url',j.source_url,
      'application_url',j.application_url,'analysis_revision',j.analysis_revision,'current_snapshot_id',j.current_snapshot_id,
      'location_text',j.location_text,'work_mode',j.work_mode,'employment_type',j.employment_type,
      'salary_min',j.salary_min,'salary_max',j.salary_max,'salary_currency',j.salary_currency,'salary_text',j.salary_text,
      'posted_at',j.posted_at,'closes_at',j.closes_at,'ats_provider',j.ats_provider,'discovery_source',j.discovery_source),
    'snapshot',jsonb_build_object('description_text',s.description_text,
      'listing_extraction',coalesce(s.raw_metadata->'listing_extraction','{}'::jsonb))
  ) order by array_position(v_chunk.job_ids,i.job_id)),'[]'::jsonb)
    into v_items
    from public.job_fit_memory_v4_items i
    join public.jobs j on j.id=i.job_id and j.user_id=p_user_id
    left join public.job_snapshots s on s.id=j.current_snapshot_id
   where i.chunk_id=v_chunk.id and i.user_id=p_user_id;

  select cp.preferences into v_preferences from public.candidate_profiles p
    join public.candidate_preferences cp on cp.profile_id=p.id where p.user_id=p_user_id;
  if v_preferences is null then v_preferences:='{}'::jsonb; end if;

  if v_chunk.dispatch_id is not null then
    select jsonb_build_object('id',d.id,'state',d.state,'action_type',d.action_type,'idempotency_key',d.idempotency_key,
      'subject_refs',d.subject_refs,'website_instruction',coalesce(d.website_instruction,d.manual_instruction),
      'output_refs',d.output_refs,'bridge_response',d.bridge_response,'bridge_response_at',d.bridge_response_at,
      'response_provenance',d.response_provenance,'delivery_turn_anchor',d.delivery_turn_anchor,
      'delivery_user_turn_fingerprint',d.delivery_user_turn_fingerprint,'sent_at',d.sent_at,
      'send_attempted_at',d.send_attempted_at,'sent_confirmed_at',d.sent_confirmed_at,'completed_at',d.completed_at,
      'error_json',d.error_json)
      into v_dispatch from public.chatgpt_dispatch_requests d
     where d.id=v_chunk.dispatch_id and d.user_id=p_user_id;
  end if;

  return jsonb_build_object(
    'batch',jsonb_build_object('id',v_batch.id,'user_id',v_batch.user_id,'request_id',v_batch.request_id,
      'state',v_batch.state,'assessment_as_of',v_batch.assessment_as_of,'testing_mode',v_batch.testing_mode,
      'requested_count',v_batch.requested_count),
    'chunk',jsonb_build_object('id',v_chunk.id,'ordinal',v_chunk.ordinal,'batch_id',v_chunk.batch_id,
      'job_ids',v_chunk.job_ids,'instruction',v_chunk.instruction,'idempotency_key',v_chunk.idempotency_key,
      'state',v_chunk.state,'dispatch_id',v_chunk.dispatch_id,'operation_id',v_chunk.operation_id,
      'captured_response',v_chunk.captured_response,'captured_response_hash',v_chunk.captured_response_hash,
      'captured_response_at',v_chunk.captured_response_at,'error_message',v_chunk.error_message),
    'items',v_items,'preferences',v_preferences,'dispatch',v_dispatch);
end;
$$;
revoke all on function private.job_fit_memory_v4_worker_context_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_memory_v4_worker_context_internal(uuid,uuid,uuid) to service_role;

create or replace function private.job_fit_memory_v4_worker_capture_internal(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_dispatch_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_original_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
  v_original_role text:=coalesce(current_setting('request.jwt.claim.role',true),'');
  v_original_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
  v_member_email text;
  v_result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if not exists(select 1 from public.job_fit_memory_v4_batches b where b.id=p_batch_id and b.user_id=p_user_id
    and b.advance_lease_token=p_lease_token and b.advance_lease_expires_at>now()) then raise exception 'Memory-fit worker lease expired'; end if;
  if not exists(select 1 from public.job_fit_memory_v4_chunks c where c.id=p_chunk_id and c.batch_id=p_batch_id
    and c.user_id=p_user_id and c.dispatch_id=p_dispatch_id and c.state='waiting_for_bridge') then raise exception 'Exact Memory-fit dispatch is not awaiting capture'; end if;
  select lower(m.email) into v_member_email from private.app_memberships m where m.user_id=p_user_id and m.status='active' for share;
  if v_member_email is null then raise exception 'Active Job Hunt Console membership required'; end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id::text,'role','authenticated','email',v_member_email)::text,true);
  v_result:=public.capture_job_fit_memory_v4_chunk(p_chunk_id,p_dispatch_id);
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  perform set_config('request.jwt.claim.role',v_original_role,true);
  perform set_config('request.jwt.claims',v_original_claims,true);
  return v_result;
exception when others then
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  perform set_config('request.jwt.claim.role',v_original_role,true);
  perform set_config('request.jwt.claims',v_original_claims,true);
  raise;
end;
$$;
revoke all on function private.job_fit_memory_v4_worker_capture_internal(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_memory_v4_worker_capture_internal(uuid,uuid,uuid,uuid,uuid) to service_role;

create or replace function private.job_fit_memory_v4_worker_save_internal(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_lease_token uuid,p_results jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_original_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
  v_original_role text:=coalesce(current_setting('request.jwt.claim.role',true),'');
  v_original_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
  v_member_email text;
  v_result jsonb;
  v_operation_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if not exists(select 1 from public.job_fit_memory_v4_batches b where b.id=p_batch_id and b.user_id=p_user_id
    and b.advance_lease_token=p_lease_token and b.advance_lease_expires_at>now()) then raise exception 'Memory-fit worker lease expired'; end if;
  select c.operation_id into v_operation_id from public.job_fit_memory_v4_chunks c
    where c.id=p_chunk_id and c.batch_id=p_batch_id and c.user_id=p_user_id and c.state='saving'
      and c.captured_response is not null;
  if not found then raise exception 'No exact captured Memory-fit response is ready to save'; end if;
  select lower(m.email) into v_member_email from private.app_memberships m where m.user_id=p_user_id and m.status='active' for share;
  if v_member_email is null then raise exception 'Active Job Hunt Console membership required'; end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id::text,'role','authenticated','email',v_member_email)::text,true);
  v_result:=public.save_job_fit_memory_v4_chunk_results(p_chunk_id,p_results);
  if v_operation_id is not null then
    perform public.manage_chatgpt_user_operation(v_operation_id,'release',null::text,'{}'::uuid[]);
  end if;
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  perform set_config('request.jwt.claim.role',v_original_role,true);
  perform set_config('request.jwt.claims',v_original_claims,true);
  return v_result;
exception when others then
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  perform set_config('request.jwt.claim.role',v_original_role,true);
  perform set_config('request.jwt.claims',v_original_claims,true);
  raise;
end;
$$;
revoke all on function private.job_fit_memory_v4_worker_save_internal(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_memory_v4_worker_save_internal(uuid,uuid,uuid,uuid,jsonb) to service_role;

create or replace function private.job_fit_memory_v4_worker_dispatch_internal(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_original_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
  v_original_role text:=coalesce(current_setting('request.jwt.claim.role',true),'');
  v_original_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
  v_member_email text;
  v_batch public.job_fit_memory_v4_batches;
  v_chunk public.job_fit_memory_v4_chunks;
  v_operation_id uuid:=gen_random_uuid();
  v_lock jsonb;
  v_dispatch jsonb;
  v_dispatch_id uuid;
  v_attached boolean;
  v_title text;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  select * into v_batch from public.job_fit_memory_v4_batches b where b.id=p_batch_id and b.user_id=p_user_id
    and b.advance_lease_token=p_lease_token and b.advance_lease_expires_at>now() for update;
  if not found then raise exception 'Memory-fit worker lease expired'; end if;
  select * into v_chunk from public.job_fit_memory_v4_chunks c where c.id=p_chunk_id and c.batch_id=p_batch_id
    and c.user_id=p_user_id and c.state='queued' for update;
  if not found then raise exception 'Memory-fit message group is no longer queued'; end if;
  if exists(select 1 from public.job_fit_memory_v4_chunks c where c.batch_id=p_batch_id and c.state='waiting_for_bridge') then
    raise exception 'Another exact Memory-fit dispatch is already active';
  end if;

  select lower(m.email) into v_member_email from private.app_memberships m where m.user_id=p_user_id and m.status='active' for share;
  if v_member_email is null then raise exception 'Active Job Hunt Console membership required'; end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id::text,'role','authenticated','email',v_member_email)::text,true);
  v_title:='Analyse '||cardinality(v_chunk.job_ids)::text||' job'||case when cardinality(v_chunk.job_ids)=1 then '' else 's' end||' using ChatGPT Memory';
  v_lock:=public.manage_chatgpt_user_operation(v_operation_id,'begin',v_title,'{}'::uuid[]);
  if coalesce((v_lock->>'ok')::boolean,false) is distinct from true then
    perform set_config('request.jwt.claim.sub',v_original_sub,true);
    perform set_config('request.jwt.claim.role',v_original_role,true);
    perform set_config('request.jwt.claims',v_original_claims,true);
    return jsonb_build_object('state','blocked','error',coalesce(v_lock->>'error','Another ChatGPT action is active.'));
  end if;
  v_dispatch:=public.create_chatgpt_dispatch_request_with_website_instruction(
    'jobs.analyse_selected',jsonb_build_object('job_ids',to_jsonb(v_chunk.job_ids)),'user_click',v_title,
    v_chunk.idempotency_key,50,v_chunk.instruction
  );
  v_dispatch_id:=nullif(v_dispatch->>'id','')::uuid;
  if v_dispatch_id is null or v_dispatch->>'action_type' is distinct from 'jobs.analyse_selected'
    or v_dispatch->>'idempotency_key' is distinct from v_chunk.idempotency_key
    or coalesce(v_dispatch->>'website_instruction',v_dispatch->>'manual_instruction') is distinct from v_chunk.instruction then
    raise exception 'The generic Website Bridge did not create the exact saved Memory-fit request';
  end if;
  update public.job_fit_memory_v4_chunks set state='waiting_for_bridge',dispatch_id=v_dispatch_id,
      operation_id=v_operation_id,error_message=null,updated_at=now()
    where id=v_chunk.id and user_id=p_user_id and state='queued' returning true into v_attached;
  if not coalesce(v_attached,false) then raise exception 'Memory-fit dispatch could not be attached to its saved group'; end if;
  v_lock:=public.manage_chatgpt_user_operation(v_operation_id,'track',null,array[v_dispatch_id]::uuid[]);
  if coalesce((v_lock->>'ok')::boolean,false) is distinct from true then raise exception 'Memory-fit operation could not track its generic Website Bridge dispatch'; end if;
  update public.job_fit_memory_v4_batches set state='processing',updated_at=now() where id=p_batch_id and user_id=p_user_id;
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  perform set_config('request.jwt.claim.role',v_original_role,true);
  perform set_config('request.jwt.claims',v_original_claims,true);
  return jsonb_build_object('state','waiting_for_bridge','dispatch_id',v_dispatch_id,'dispatch',v_dispatch);
exception when others then
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  perform set_config('request.jwt.claim.role',v_original_role,true);
  perform set_config('request.jwt.claims',v_original_claims,true);
  raise;
end;
$$;
revoke all on function private.job_fit_memory_v4_worker_dispatch_internal(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_memory_v4_worker_dispatch_internal(uuid,uuid,uuid,uuid) to service_role;

create or replace function private.job_fit_memory_v4_worker_needs_user_internal(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_lease_token uuid,p_error text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_original_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
  v_original_role text:=coalesce(current_setting('request.jwt.claim.role',true),'');
  v_original_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
  v_member_email text;
  v_operation_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if not exists(select 1 from public.job_fit_memory_v4_batches b where b.id=p_batch_id and b.user_id=p_user_id
    and b.advance_lease_token=p_lease_token and b.advance_lease_expires_at>now()) then raise exception 'Memory-fit worker lease expired'; end if;
  update public.job_fit_memory_v4_chunks set state='needs_user',error_message=left(coalesce(p_error,'The exact Website Bridge request needs review.'),1000),updated_at=now()
    where id=p_chunk_id and batch_id=p_batch_id and user_id=p_user_id and state in ('queued','waiting_for_bridge','saving')
    returning operation_id into v_operation_id;
  if not found then raise exception 'Memory-fit message group is no longer waiting'; end if;
  update public.job_fit_memory_v4_items set state='needs_user',error_message=left(coalesce(p_error,'The exact Website Bridge request needs review.'),1000),updated_at=now()
   where chunk_id=p_chunk_id and user_id=p_user_id and state in ('queued','saving');
  update public.job_fit_memory_v4_batches b set state=case when exists(select 1 from public.job_fit_memory_v4_chunks c
      where c.batch_id=b.id and c.state in ('queued','waiting_for_bridge','saving')) then 'processing' else 'partial' end,
      updated_at=now() where b.id=p_batch_id and b.user_id=p_user_id;
  if v_operation_id is not null then
    select lower(m.email) into v_member_email from private.app_memberships m where m.user_id=p_user_id and m.status='active' for share;
    if v_member_email is null then raise exception 'Active Job Hunt Console membership required'; end if;
    perform set_config('request.jwt.claim.sub',p_user_id::text,true);
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',p_user_id::text,'role','authenticated','email',v_member_email)::text,true);
    perform public.manage_chatgpt_user_operation(v_operation_id,'release',null::text,'{}'::uuid[]);
    perform set_config('request.jwt.claim.sub',v_original_sub,true);
    perform set_config('request.jwt.claim.role',v_original_role,true);
    perform set_config('request.jwt.claims',v_original_claims,true);
  end if;
  return jsonb_build_object('state','needs_user');
exception when others then
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  perform set_config('request.jwt.claim.role',v_original_role,true);
  perform set_config('request.jwt.claims',v_original_claims,true);
  raise;
end;
$$;
revoke all on function private.job_fit_memory_v4_worker_needs_user_internal(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_memory_v4_worker_needs_user_internal(uuid,uuid,uuid,uuid,text) to service_role;

create or replace function private.job_fit_memory_v4_worker_release_internal(p_batch_id uuid,p_user_id uuid,p_lease_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  update public.job_fit_memory_v4_batches set advance_lease_token=null,advance_lease_expires_at=null
   where id=p_batch_id and user_id=p_user_id and advance_lease_token=p_lease_token;
  return found;
end;
$$;
revoke all on function private.job_fit_memory_v4_worker_release_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_memory_v4_worker_release_internal(uuid,uuid,uuid) to service_role;

-- Public RPC names make the service-only helpers callable by the scheduler.
-- These wrappers are SECURITY INVOKER and expose no V4 table grants.
create or replace function public.job_fit_memory_v4_worker_claim(p_limit integer default 5)
returns jsonb language sql security invoker set search_path='' as $$
  select private.job_fit_memory_v4_worker_claim_internal($1);
$$;
create or replace function public.job_fit_memory_v4_worker_context(p_user_id uuid,p_batch_id uuid,p_lease_token uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select private.job_fit_memory_v4_worker_context_internal($1,$2,$3);
$$;
create or replace function public.job_fit_memory_v4_worker_capture(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_dispatch_id uuid,p_lease_token uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select private.job_fit_memory_v4_worker_capture_internal($1,$2,$3,$4,$5);
$$;
create or replace function public.job_fit_memory_v4_worker_save(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_lease_token uuid,p_results jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.job_fit_memory_v4_worker_save_internal($1,$2,$3,$4,$5);
$$;
create or replace function public.job_fit_memory_v4_worker_dispatch(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_lease_token uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select private.job_fit_memory_v4_worker_dispatch_internal($1,$2,$3,$4);
$$;
create or replace function public.job_fit_memory_v4_worker_needs_user(p_user_id uuid,p_batch_id uuid,p_chunk_id uuid,p_lease_token uuid,p_error text)
returns jsonb language sql security invoker set search_path='' as $$
  select private.job_fit_memory_v4_worker_needs_user_internal($1,$2,$3,$4,$5);
$$;
create or replace function public.job_fit_memory_v4_worker_release(p_batch_id uuid,p_user_id uuid,p_lease_token uuid)
returns boolean language sql security invoker set search_path='' as $$
  select private.job_fit_memory_v4_worker_release_internal($1,$2,$3);
$$;

revoke all on function public.job_fit_memory_v4_worker_claim(integer) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_memory_v4_worker_context(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_memory_v4_worker_capture(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_memory_v4_worker_save(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_memory_v4_worker_dispatch(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_memory_v4_worker_needs_user(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_memory_v4_worker_release(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.job_fit_memory_v4_worker_claim(integer) to service_role;
grant execute on function public.job_fit_memory_v4_worker_context(uuid,uuid,uuid) to service_role;
grant execute on function public.job_fit_memory_v4_worker_capture(uuid,uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.job_fit_memory_v4_worker_save(uuid,uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.job_fit_memory_v4_worker_dispatch(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.job_fit_memory_v4_worker_needs_user(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.job_fit_memory_v4_worker_release(uuid,uuid,uuid) to service_role;

comment on column public.job_fit_memory_v4_batches.advance_lease_token is
  'Short lease shared by the authenticated page advancer and the service-only background worker; prevents duplicate group dispatches.';

commit;
