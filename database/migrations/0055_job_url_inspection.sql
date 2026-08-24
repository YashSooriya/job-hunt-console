-- Milestone 26: let a user submit a public vacancy URL and have the
-- authenticated ChatGPT worker inspect it before the job is persisted.
-- The worker never submits an application or logs into an employer site.

create table if not exists public.job_url_inspection_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null check (length(source_url) between 1 and 2000),
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed','user_required')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  extraction_json jsonb,
  error_json jsonb,
  job_id uuid references public.jobs(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_url_inspection_requests_queue_idx
  on public.job_url_inspection_requests(user_id, status, created_at);
create index if not exists job_url_inspection_requests_job_idx
  on public.job_url_inspection_requests(job_id)
  where job_id is not null;

alter table public.job_url_inspection_requests enable row level security;
revoke all on public.job_url_inspection_requests from public, anon;
drop policy if exists job_url_inspection_requests_owner_select on public.job_url_inspection_requests;
drop policy if exists job_url_inspection_requests_owner_insert on public.job_url_inspection_requests;
create policy job_url_inspection_requests_owner_select
  on public.job_url_inspection_requests
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy job_url_inspection_requests_owner_insert
  on public.job_url_inspection_requests
  for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
grant select, insert on public.job_url_inspection_requests to authenticated;

create or replace function private.chatgpt_get_pending_job_url_inspections_internal(
  p_access_token text,
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 10));
  v_requests jsonb;
begin
  select * into v_token
    from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token)
     and revoked_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then
    raise exception 'OAuth scope is insufficient for job URL inspection reads';
  end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'request_id',r.id,
    'source_url',r.source_url,
    'status',r.status,
    'attempt_count',r.attempt_count,
    'submitted_at',r.created_at,
    'lease_expires_at',r.lease_expires_at
  ) order by r.created_at),'[]'::jsonb)
    into v_requests
    from (
      with candidates as (
        select id
          from public.job_url_inspection_requests
         where user_id=v_token.user_id
           and (
             status='queued'
             or (status='processing' and (lease_expires_at is null or lease_expires_at < now()))
           )
         order by created_at
         limit v_limit
         for update skip locked
      ), claimed as (
        update public.job_url_inspection_requests r
           set status='processing',
               attempt_count=r.attempt_count+1,
               lease_expires_at=now()+interval '15 minutes',
               updated_at=now()
          from candidates
         where r.id=candidates.id
        returning r.*
      )
      select * from claimed
    ) r;

  return jsonb_build_object(
    'user_id',v_token.user_id,
    'requests',v_requests,
    'contract',jsonb_build_object(
      'read_only_browsing',true,
      'never_login_or_apply',true,
      'salary_rule','Use advertised salary when present. If it is absent, only provide a clearly labelled ChatGPT estimate with confidence and evidence basis; otherwise leave salary unavailable.',
      'completion_tool','save_job_url_inspection',
      'failure_tool','fail_job_url_inspection'
    )
  );
end;
$$;
revoke all on function private.chatgpt_get_pending_job_url_inspections_internal(text,integer) from public,anon,authenticated;
grant execute on function private.chatgpt_get_pending_job_url_inspections_internal(text,integer) to anon,authenticated;

create or replace function private.chatgpt_save_job_url_inspection_internal(
  p_access_token text,
  p_request_id uuid,
  p_extraction jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_request public.job_url_inspection_requests;
  v_job_args jsonb;
  v_metadata jsonb;
  v_save_result jsonb;
  v_job_id uuid;
  v_salary_source text;
  v_salary_confidence text;
begin
  select * into v_token
    from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token)
     and revoked_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then
    raise exception 'OAuth scope is insufficient for job URL inspection writes';
  end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;

  if p_request_id is null then raise exception 'Inspection request id is required'; end if;
  if jsonb_typeof(coalesce(p_extraction,'{}'::jsonb)) <> 'object' then
    raise exception 'Job URL extraction must be an object';
  end if;
  if length(coalesce(p_extraction,'{}'::jsonb)::text) > 200000 then
    raise exception 'Job URL extraction is too large';
  end if;

  select * into v_request
    from public.job_url_inspection_requests
   where id=p_request_id and user_id=v_token.user_id
   for update;
  if not found then raise exception 'Job URL inspection request not found'; end if;
  if v_request.status='completed' then
    return jsonb_build_object('request_id',v_request.id,'status',v_request.status,'job_id',v_request.job_id,'idempotent',true);
  end if;
  if v_request.status not in ('queued','processing') then
    raise exception 'Job URL inspection request cannot be completed from its current state';
  end if;

  if nullif(btrim(p_extraction->>'company'),'') is null
     or nullif(btrim(p_extraction->>'title'),'') is null
     or nullif(btrim(p_extraction->>'description'),'') is null then
    raise exception 'ChatGPT must return company, title and description for a job URL inspection';
  end if;
  v_salary_source := coalesce(nullif(p_extraction->>'salary_source',''),'not_available');
  if v_salary_source not in ('advertised','chatgpt_estimate','not_available') then
    raise exception 'salary_source must be advertised, chatgpt_estimate or not_available';
  end if;
  v_salary_confidence := nullif(p_extraction->>'salary_confidence','');
  if v_salary_confidence is not null and v_salary_confidence not in ('high','medium','low') then
    raise exception 'salary_confidence must be high, medium or low';
  end if;
  if v_salary_source='chatgpt_estimate'
     and jsonb_array_length(coalesce(p_extraction->'salary_basis','[]'::jsonb)) = 0 then
    raise exception 'A ChatGPT salary estimate must include salary_basis';
  end if;

  v_metadata := coalesce(p_extraction->'raw_metadata','{}'::jsonb);
  if jsonb_typeof(v_metadata) <> 'object' then raise exception 'raw_metadata must be an object'; end if;
  v_metadata := v_metadata || jsonb_build_object(
    'listing_extraction',
    (p_extraction - 'description' - 'raw_metadata' - 'request_id') || jsonb_build_object(
      'source','chatgpt_url',
      'inspection_request_id',v_request.id,
      'captured_at',now(),
      'salary_source',v_salary_source,
      'salary_confidence',v_salary_confidence,
      'salary_basis',coalesce(p_extraction->'salary_basis','[]'::jsonb)
    )
  );
  v_job_args := (p_extraction - 'raw_metadata' - 'request_id') || jsonb_build_object(
    'source_url',v_request.source_url,
    'raw_metadata',v_metadata
  );

  v_save_result := private.chatgpt_mcp_call_internal(p_access_token,'save_discovered_job',v_job_args);
  v_job_id := nullif(v_save_result->>'job_id','')::uuid;
  if v_job_id is null then raise exception 'ChatGPT job persistence did not return a job id'; end if;

  -- save_discovered_job is intentionally conservative on conflict. A URL
  -- inspection is the authoritative refresh for the extracted vacancy fields.
  update public.jobs
     set title=coalesce(nullif(v_job_args->>'title',''),title),
         source_url=case when v_job_args ? 'source_url' then nullif(v_job_args->>'source_url','') else source_url end,
         application_url=case when v_job_args ? 'application_url' then nullif(v_job_args->>'application_url','') else application_url end,
         location_text=case when v_job_args ? 'location' then nullif(v_job_args->>'location','') else location_text end,
         work_mode=case when v_job_args ? 'work_mode' then nullif(v_job_args->>'work_mode','') else work_mode end,
         salary_text=case when v_job_args ? 'salary_text' then nullif(v_job_args->>'salary_text','') else salary_text end,
         salary_min=case when v_job_args ? 'salary_min' then nullif(v_job_args->>'salary_min','')::numeric else salary_min end,
         salary_max=case when v_job_args ? 'salary_max' then nullif(v_job_args->>'salary_max','')::numeric else salary_max end,
         salary_currency=case when v_job_args ? 'salary_currency' then coalesce(nullif(v_job_args->>'salary_currency',''),'GBP') else salary_currency end,
         posted_at=case when v_job_args ? 'posted_at' then nullif(v_job_args->>'posted_at','')::timestamptz else posted_at end,
         closes_at=case when v_job_args ? 'closes_at' then nullif(v_job_args->>'closes_at','')::timestamptz else closes_at end,
         employment_type=case when v_job_args ? 'employment_type' then nullif(v_job_args->>'employment_type','') else employment_type end,
         ats_provider=case when v_job_args ? 'ats_provider' then nullif(v_job_args->>'ats_provider','') else ats_provider end,
         discovery_source='chatgpt_url',
         updated_at=now()
   where id=v_job_id and user_id=v_token.user_id;
  update public.job_snapshots
     set raw_metadata=v_metadata,source_url=v_request.source_url
   where id=(select current_snapshot_id from public.jobs where id=v_job_id and user_id=v_token.user_id);

  update public.job_url_inspection_requests
     set status='completed',
         extraction_json=v_job_args,
         error_json=null,
         job_id=v_job_id,
         lease_expires_at=null,
         completed_at=now(),
         updated_at=now()
   where id=v_request.id and user_id=v_token.user_id;

  return v_save_result || jsonb_build_object('request_id',v_request.id,'status','completed','salary_source',v_salary_source,'salary_confidence',v_salary_confidence);
end;
$$;
revoke all on function private.chatgpt_save_job_url_inspection_internal(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.chatgpt_save_job_url_inspection_internal(text,uuid,jsonb) to anon,authenticated;

create or replace function private.chatgpt_fail_job_url_inspection_internal(
  p_access_token text,
  p_request_id uuid,
  p_message text,
  p_user_required boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_request public.job_url_inspection_requests;
  v_state text := case when coalesce(p_user_required,true) then 'user_required' else 'failed' end;
begin
  select * into v_token
    from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token)
     and revoked_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then
    raise exception 'OAuth scope is insufficient for job URL inspection writes';
  end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;
  select * into v_request from public.job_url_inspection_requests where id=p_request_id and user_id=v_token.user_id for update;
  if not found then raise exception 'Job URL inspection request not found'; end if;
  if v_request.status='completed' then
    return jsonb_build_object('request_id',v_request.id,'status',v_request.status,'job_id',v_request.job_id,'idempotent',true);
  end if;
  update public.job_url_inspection_requests
     set status=v_state,
         error_json=jsonb_build_object('message',left(coalesce(nullif(btrim(p_message),''),'ChatGPT could not read the listing.'),2000)),
         lease_expires_at=null,
         updated_at=now()
   where id=v_request.id and user_id=v_token.user_id;
  return jsonb_build_object('request_id',v_request.id,'status',v_state);
end;
$$;
revoke all on function private.chatgpt_fail_job_url_inspection_internal(text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function private.chatgpt_fail_job_url_inspection_internal(text,uuid,text,boolean) to anon,authenticated;

create or replace function chatgpt_internal.get_pending_job_url_inspections(p_access_token text,p_limit integer default 5)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_pending_job_url_inspections_internal(p_access_token,p_limit); $$;
create or replace function chatgpt_internal.save_job_url_inspection(p_access_token text,p_request_id uuid,p_extraction jsonb)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_save_job_url_inspection_internal(p_access_token,p_request_id,p_extraction); $$;
create or replace function chatgpt_internal.fail_job_url_inspection(p_access_token text,p_request_id uuid,p_message text,p_user_required boolean default true)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_fail_job_url_inspection_internal(p_access_token,p_request_id,p_message,p_user_required); $$;

revoke all on function chatgpt_internal.get_pending_job_url_inspections(text,integer) from public,anon,authenticated;
revoke all on function chatgpt_internal.save_job_url_inspection(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function chatgpt_internal.fail_job_url_inspection(text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function chatgpt_internal.get_pending_job_url_inspections(text,integer) to anon,authenticated;
grant execute on function chatgpt_internal.save_job_url_inspection(text,uuid,jsonb) to anon,authenticated;
grant execute on function chatgpt_internal.fail_job_url_inspection(text,uuid,text,boolean) to anon,authenticated;

create or replace function public.chatgpt_get_pending_job_url_inspections(p_access_token text,p_limit integer default 5)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_pending_job_url_inspections(p_access_token,p_limit); $$;
create or replace function public.chatgpt_save_job_url_inspection(p_access_token text,p_request_id uuid,p_extraction jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.save_job_url_inspection(p_access_token,p_request_id,p_extraction); $$;
create or replace function public.chatgpt_fail_job_url_inspection(p_access_token text,p_request_id uuid,p_message text,p_user_required boolean default true)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.fail_job_url_inspection(p_access_token,p_request_id,p_message,p_user_required); $$;

revoke all on function public.chatgpt_get_pending_job_url_inspections(text,integer) from public;
revoke all on function public.chatgpt_save_job_url_inspection(text,uuid,jsonb) from public;
revoke all on function public.chatgpt_fail_job_url_inspection(text,uuid,text,boolean) from public;
grant execute on function public.chatgpt_get_pending_job_url_inspections(text,integer) to anon,authenticated;
grant execute on function public.chatgpt_save_job_url_inspection(text,uuid,jsonb) to anon,authenticated;
grant execute on function public.chatgpt_fail_job_url_inspection(text,uuid,text,boolean) to anon,authenticated;

comment on table public.job_url_inspection_requests is 'Per-user public vacancy URLs queued for read-only ChatGPT extraction; employer authentication and submission are prohibited.';
