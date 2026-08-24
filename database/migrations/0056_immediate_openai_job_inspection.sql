-- Milestone 27: start a direct OpenAI Responses API inspection from the
-- signed-in webapp. The functions below keep all writes bound to auth.uid();
-- the OpenAI API key remains a server-only Worker secret.

alter table public.job_url_inspection_requests
  add column if not exists provider text,
  add column if not exists provider_response_id text;

create index if not exists job_url_inspection_requests_provider_idx
  on public.job_url_inspection_requests(provider, provider_response_id)
  where provider_response_id is not null;

create or replace function private.start_job_url_inspection_for_user(
  p_user_id uuid,
  p_request_id uuid,
  p_provider text default 'openai_responses'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.job_url_inspection_requests;
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid()) then
    raise exception 'Authenticated user does not own this inspection request';
  end if;
  perform private.assert_active_app_membership(p_user_id);
  if p_request_id is null then raise exception 'Inspection request id is required'; end if;
  if coalesce(nullif(btrim(p_provider),''),'openai_responses') <> 'openai_responses' then
    raise exception 'Unsupported direct inspection provider';
  end if;

  update public.job_url_inspection_requests
     set status='processing',
         provider='openai_responses',
         attempt_count=attempt_count+1,
         lease_expires_at=now()+interval '15 minutes',
         error_json=null,
         updated_at=now()
   where id=p_request_id
     and user_id=p_user_id
     and status='queued'
   returning * into v_request;
  if not found then
    raise exception 'Inspection request is no longer queued';
  end if;

  return jsonb_build_object(
    'id',v_request.id,
    'source_url',v_request.source_url,
    'status',v_request.status,
    'attempt_count',v_request.attempt_count,
    'provider',v_request.provider,
    'provider_response_id',v_request.provider_response_id,
    'created_at',v_request.created_at,
    'updated_at',v_request.updated_at
  );
end;
$$;

create or replace function private.set_job_url_inspection_response_for_user(
  p_user_id uuid,
  p_request_id uuid,
  p_provider_response_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.job_url_inspection_requests;
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid()) then
    raise exception 'Authenticated user does not own this inspection request';
  end if;
  perform private.assert_active_app_membership(p_user_id);
  if nullif(btrim(p_provider_response_id),'') is null then raise exception 'OpenAI response id is required'; end if;
  if length(p_provider_response_id) > 200 then raise exception 'OpenAI response id is too long'; end if;

  update public.job_url_inspection_requests
     set provider_response_id=btrim(p_provider_response_id),
         updated_at=now()
   where id=p_request_id
     and user_id=p_user_id
     and status='processing'
     and provider='openai_responses'
   returning * into v_request;
  if not found then raise exception 'Direct inspection request is not processing'; end if;

  return jsonb_build_object(
    'id',v_request.id,
    'source_url',v_request.source_url,
    'status',v_request.status,
    'attempt_count',v_request.attempt_count,
    'provider',v_request.provider,
    'provider_response_id',v_request.provider_response_id,
    'created_at',v_request.created_at,
    'updated_at',v_request.updated_at
  );
end;
$$;

create or replace function private.mark_job_url_inspection_failed_for_user(
  p_user_id uuid,
  p_request_id uuid,
  p_message text,
  p_user_required boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.job_url_inspection_requests;
  v_status text := case when coalesce(p_user_required,false) then 'user_required' else 'failed' end;
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid()) then
    raise exception 'Authenticated user does not own this inspection request';
  end if;
  perform private.assert_active_app_membership(p_user_id);
  select * into v_request
    from public.job_url_inspection_requests
   where id=p_request_id and user_id=p_user_id
   for update;
  if not found then raise exception 'Inspection request not found'; end if;
  if v_request.status='completed' then
    return jsonb_build_object('id',v_request.id,'status',v_request.status,'job_id',v_request.job_id,'idempotent',true);
  end if;

  update public.job_url_inspection_requests
     set status=v_status,
         error_json=jsonb_build_object('message',left(coalesce(nullif(btrim(p_message),''),'OpenAI could not read the listing.'),2000)),
         lease_expires_at=null,
         updated_at=now()
   where id=v_request.id and user_id=p_user_id
   returning * into v_request;

  return jsonb_build_object('id',v_request.id,'status',v_request.status,'error_json',v_request.error_json);
end;
$$;

create or replace function private.complete_job_url_inspection_for_user(
  p_user_id uuid,
  p_request_id uuid,
  p_extraction jsonb,
  p_provider text default 'openai_responses',
  p_provider_response_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.job_url_inspection_requests;
  v_company text;
  v_title text;
  v_description text;
  v_company_id uuid;
  v_job public.jobs;
  v_snapshot_id uuid;
  v_dedupe text;
  v_content_hash text;
  v_metadata jsonb;
  v_listing jsonb;
  v_job_args jsonb;
  v_salary_source text;
  v_salary_confidence text;
  v_provider text := coalesce(nullif(btrim(p_provider),''),'openai_responses');
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid()) then
    raise exception 'Authenticated user does not own this inspection request';
  end if;
  perform private.assert_active_app_membership(p_user_id);
  if p_request_id is null then raise exception 'Inspection request id is required'; end if;
  if jsonb_typeof(coalesce(p_extraction,'{}'::jsonb)) <> 'object' then
    raise exception 'Job URL extraction must be an object';
  end if;
  if length(coalesce(p_extraction,'{}'::jsonb)::text) > 200000 then
    raise exception 'Job URL extraction is too large';
  end if;
  if v_provider not in ('openai_responses','chatgpt_direct') then
    raise exception 'Unsupported job URL inspection provider';
  end if;
  if p_provider_response_id is not null and length(p_provider_response_id) > 200 then
    raise exception 'OpenAI response id is too long';
  end if;

  select * into v_request
    from public.job_url_inspection_requests
   where id=p_request_id and user_id=p_user_id
   for update;
  if not found then raise exception 'Inspection request not found'; end if;
  if v_request.status='completed' then
    return jsonb_build_object('request_id',v_request.id,'status',v_request.status,'job_id',v_request.job_id,'idempotent',true);
  end if;
  if v_request.status not in ('queued','processing') then
    raise exception 'Inspection request cannot be completed from its current state';
  end if;

  v_company := nullif(btrim(p_extraction->>'company'),'');
  v_title := nullif(btrim(p_extraction->>'title'),'');
  v_description := nullif(btrim(p_extraction->>'description'),'');
  if v_company is null or v_title is null or v_description is null then
    raise exception 'OpenAI must return company, title and description for a job URL inspection';
  end if;
  v_salary_source := coalesce(nullif(p_extraction->>'salary_source',''),'not_available');
  if v_salary_source not in ('advertised','chatgpt_estimate','not_available') then
    raise exception 'salary_source must be advertised, chatgpt_estimate or not_available';
  end if;
  v_salary_confidence := nullif(p_extraction->>'salary_confidence','');
  if v_salary_confidence is not null and v_salary_confidence not in ('high','medium','low') then
    raise exception 'salary_confidence must be high, medium or low';
  end if;
  if jsonb_typeof(coalesce(p_extraction->'salary_basis','[]'::jsonb)) <> 'array' then
    raise exception 'salary_basis must be an array';
  end if;
  if v_salary_source='chatgpt_estimate' and jsonb_array_length(coalesce(p_extraction->'salary_basis','[]'::jsonb)) = 0 then
    raise exception 'An OpenAI salary estimate must include salary_basis';
  end if;

  v_metadata := coalesce(p_extraction->'raw_metadata','{}'::jsonb);
  if jsonb_typeof(v_metadata) <> 'object' then raise exception 'raw_metadata must be an object'; end if;
  v_listing := (p_extraction - 'description' - 'raw_metadata' - 'request_id') || jsonb_build_object(
    'source',v_provider,
    'inspection_request_id',v_request.id,
    'captured_at',now(),
    'salary_source',v_salary_source,
    'salary_confidence',v_salary_confidence,
    'salary_basis',coalesce(p_extraction->'salary_basis','[]'::jsonb)
  );
  if p_provider_response_id is not null then
    v_listing := v_listing || jsonb_build_object('provider_response_id',p_provider_response_id);
  end if;
  v_metadata := v_metadata || jsonb_build_object('listing_extraction',v_listing);
  if length(v_metadata::text) > 200000 then raise exception 'Job listing metadata is too large'; end if;
  v_job_args := (p_extraction - 'raw_metadata' - 'request_id') || jsonb_build_object(
    'source_url',v_request.source_url,
    'raw_metadata',v_metadata
  );

  insert into public.companies(user_id,canonical_name,website)
  values(p_user_id,v_company,nullif(btrim(p_extraction->>'company_website'),''))
  on conflict(user_id,canonical_name) do update set
    website=coalesce(excluded.website,public.companies.website)
  returning id into v_company_id;

  v_dedupe := lower(encode(extensions.digest(convert_to(
    v_company||'|'||v_title||'|'||coalesce(p_extraction->>'application_url',v_request.source_url,''),'utf8'),'sha256'),'hex'));
  select * into v_job
    from public.jobs
   where user_id=p_user_id and dedupe_key=v_dedupe
   for update;
  if not found then
    insert into public.jobs(
      user_id,company_id,title,external_job_id,source_url,application_url,location_text,work_mode,
      salary_text,salary_min,salary_max,salary_currency,posted_at,closes_at,employment_type,ats_provider,
      discovery_source,dedupe_key,triage_reason
    ) values (
      p_user_id,v_company_id,v_title,nullif(p_extraction->>'external_job_id',''),v_request.source_url,
      nullif(p_extraction->>'application_url',''),nullif(p_extraction->>'location',''),nullif(p_extraction->>'work_mode',''),
      nullif(p_extraction->>'salary_text',''),nullif(p_extraction->>'salary_min','')::numeric,
      nullif(p_extraction->>'salary_max','')::numeric,coalesce(nullif(p_extraction->>'salary_currency',''),'GBP'),
      nullif(p_extraction->>'posted_at','')::timestamptz,nullif(p_extraction->>'closes_at','')::timestamptz,
      nullif(p_extraction->>'employment_type',''),nullif(p_extraction->>'ats_provider',''),v_provider,v_dedupe,
      'Imported by the immediate OpenAI listing inspection; job fit analysis is still required.'
    ) returning * into v_job;
  else
    update public.jobs
       set company_id=v_company_id,
           title=v_title,
           external_job_id=coalesce(nullif(p_extraction->>'external_job_id',''),external_job_id),
           source_url=v_request.source_url,
           application_url=coalesce(nullif(p_extraction->>'application_url',''),application_url),
           location_text=coalesce(nullif(p_extraction->>'location',''),location_text),
           work_mode=coalesce(nullif(p_extraction->>'work_mode',''),work_mode),
           salary_text=coalesce(nullif(p_extraction->>'salary_text',''),salary_text),
           salary_min=coalesce(nullif(p_extraction->>'salary_min','')::numeric,salary_min),
           salary_max=coalesce(nullif(p_extraction->>'salary_max','')::numeric,salary_max),
           salary_currency=coalesce(nullif(p_extraction->>'salary_currency',''),salary_currency,'GBP'),
           posted_at=coalesce(nullif(p_extraction->>'posted_at','')::timestamptz,posted_at),
           closes_at=coalesce(nullif(p_extraction->>'closes_at','')::timestamptz,closes_at),
           employment_type=coalesce(nullif(p_extraction->>'employment_type',''),employment_type),
           ats_provider=coalesce(nullif(p_extraction->>'ats_provider',''),ats_provider),
           discovery_source=v_provider,
           updated_at=now()
     where id=v_job.id and user_id=p_user_id
     returning * into v_job;
  end if;

  v_content_hash := encode(extensions.digest(convert_to(v_description,'utf8'),'sha256'),'hex');
  select id into v_snapshot_id
    from public.job_snapshots
   where job_id=v_job.id and content_hash=v_content_hash
   for update;
  if not found then
    insert into public.job_snapshots(job_id,title,company_name,description_text,source_url,raw_metadata,content_hash)
    values(v_job.id,v_title,v_company,v_description,v_request.source_url,v_metadata,v_content_hash)
    returning id into v_snapshot_id;
  else
    update public.job_snapshots
       set title=v_title,
           company_name=v_company,
           description_text=v_description,
           source_url=v_request.source_url,
           raw_metadata=v_metadata,
           captured_at=now()
     where id=v_snapshot_id;
  end if;
  update public.jobs set current_snapshot_id=v_snapshot_id,updated_at=now() where id=v_job.id and user_id=p_user_id;

  update public.job_url_inspection_requests
     set status='completed',
         provider=v_provider,
         provider_response_id=coalesce(p_provider_response_id,provider_response_id),
         extraction_json=v_job_args,
         error_json=null,
         job_id=v_job.id,
         lease_expires_at=null,
         completed_at=now(),
         updated_at=now()
   where id=v_request.id and user_id=p_user_id;

  return jsonb_build_object(
    'request_id',v_request.id,
    'status','completed',
    'job_id',v_job.id,
    'snapshot_id',v_snapshot_id,
    'provider',v_provider,
    'salary_source',v_salary_source,
    'salary_confidence',v_salary_confidence
  );
end;
$$;

create or replace function public.start_job_url_inspection(p_request_id uuid,p_provider text default 'openai_responses')
returns jsonb language sql security invoker set search_path=''
as $$ select private.start_job_url_inspection_for_user((select auth.uid()),p_request_id,p_provider); $$;

create or replace function public.set_job_url_inspection_response(p_request_id uuid,p_provider_response_id text)
returns jsonb language sql security invoker set search_path=''
as $$ select private.set_job_url_inspection_response_for_user((select auth.uid()),p_request_id,p_provider_response_id); $$;

create or replace function public.mark_job_url_inspection_failed(p_request_id uuid,p_message text,p_user_required boolean default false)
returns jsonb language sql security invoker set search_path=''
as $$ select private.mark_job_url_inspection_failed_for_user((select auth.uid()),p_request_id,p_message,p_user_required); $$;

create or replace function public.complete_job_url_inspection(
  p_request_id uuid,
  p_extraction jsonb,
  p_provider text default 'openai_responses',
  p_provider_response_id text default null
)
returns jsonb language sql security invoker set search_path=''
as $$ select private.complete_job_url_inspection_for_user((select auth.uid()),p_request_id,p_extraction,p_provider,p_provider_response_id); $$;

revoke all on function public.start_job_url_inspection(uuid,text) from public,anon;
revoke all on function public.set_job_url_inspection_response(uuid,text) from public,anon;
revoke all on function public.mark_job_url_inspection_failed(uuid,text,boolean) from public,anon;
revoke all on function public.complete_job_url_inspection(uuid,jsonb,text,text) from public,anon;
grant execute on function public.start_job_url_inspection(uuid,text) to authenticated;
grant execute on function public.set_job_url_inspection_response(uuid,text) to authenticated;
grant execute on function public.mark_job_url_inspection_failed(uuid,text,boolean) to authenticated;
grant execute on function public.complete_job_url_inspection(uuid,jsonb,text,text) to authenticated;

revoke all on function private.start_job_url_inspection_for_user(uuid,uuid,text) from public,anon,authenticated;
revoke all on function private.set_job_url_inspection_response_for_user(uuid,uuid,text) from public,anon,authenticated;
revoke all on function private.mark_job_url_inspection_failed_for_user(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function private.complete_job_url_inspection_for_user(uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function private.start_job_url_inspection_for_user(uuid,uuid,text) to authenticated;
grant execute on function private.set_job_url_inspection_response_for_user(uuid,uuid,text) to authenticated;
grant execute on function private.mark_job_url_inspection_failed_for_user(uuid,uuid,text,boolean) to authenticated;
grant execute on function private.complete_job_url_inspection_for_user(uuid,uuid,jsonb,text,text) to authenticated;

comment on column public.job_url_inspection_requests.provider is 'Execution provider for this inspection, such as openai_responses or the connected ChatGPT MCP worker.';
comment on column public.job_url_inspection_requests.provider_response_id is 'Server-side provider response identifier; never exposed as a user credential.';
