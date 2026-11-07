-- M04 correction: keep pre-M04 URL writers compatible, make one batch's
-- dispatch/link transition atomic, serialize idempotent fit-batch creation,
-- and use verified ATS identity without merging similar vacancies by title.

create or replace function private.preserve_job_url_inspection_submitted_url()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if new.original_source_url is null then
    new.original_source_url:=new.source_url;
  end if;
  return new;
end;
$$;
revoke all on function private.preserve_job_url_inspection_submitted_url() from public,anon,authenticated,service_role;
drop trigger if exists job_url_inspection_preserve_submitted_url on public.job_url_inspection_requests;
create trigger job_url_inspection_preserve_submitted_url
before insert on public.job_url_inspection_requests
for each row execute function private.preserve_job_url_inspection_submitted_url();

create or replace function public.create_job_url_inspection_batch_dispatch(
  p_batch_id uuid,
  p_website_instruction text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_count integer;
  v_ids uuid[];
  v_all_testing boolean;
  v_any_testing boolean;
  v_assessment_min timestamptz;
  v_assessment_max timestamptz;
  v_assessment_label text;
  v_instruction text := p_website_instruction;
  v_expected_header text;
  v_request record;
  v_existing public.chatgpt_dispatch_requests;
  v_dispatch jsonb;
  v_dispatch_id uuid;
  v_linked_count integer;
  v_marker_count integer;
  v_test_prefix text := 'TEST ONLY — The following message is a test. Do not add, save, or update anything from it to ChatGPT Memory or long-term memory. Treat the request below as a test and answer it without changing Memory.';
  v_idempotency_key text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_batch_id is null or v_instruction is null or length(v_instruction) not between 1 and 6000 then
    raise exception 'The URL-import batch identity or Website Bridge instruction is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user::text||':job-url-inspection-batch:'||p_batch_id::text,0)
  );
  perform 1 from public.job_url_inspection_requests
   where user_id=v_user and batch_id=p_batch_id
   order by batch_position
   for update;
  select count(*),array_agg(id order by batch_position),bool_and(initial_fit_testing_mode),
         bool_or(initial_fit_testing_mode),min(initial_fit_assessment_as_of),max(initial_fit_assessment_as_of)
    into v_count,v_ids,v_all_testing,v_any_testing,v_assessment_min,v_assessment_max
    from public.job_url_inspection_requests
   where user_id=v_user and batch_id=p_batch_id;
  if v_count not between 1 and 10 or cardinality(v_ids)<>v_count then
    raise exception 'The saved URL-import batch must contain one to ten unique entries';
  end if;
  if v_assessment_min is null or v_assessment_min is distinct from v_assessment_max
     or v_all_testing is distinct from v_any_testing then
    raise exception 'The saved URL-import batch has inconsistent fit or Testing Mode state';
  end if;
  if v_all_testing and left(v_instruction,length(v_test_prefix)) is distinct from v_test_prefix then
    raise exception 'Testing Mode must use its complete warning prefix';
  end if;
  v_assessment_label:=to_char(v_assessment_min at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_expected_header:='Combined job URL import v1. Batch ID: '||p_batch_id::text||'. Assessment time: '||v_assessment_label||'.';
  if position(v_expected_header in v_instruction)=0 then
    raise exception 'The Website Bridge instruction does not match the saved batch and assessment time';
  end if;
  -- Count the prompt delimiter instead of the raw request_id= token because a
  -- valid source URL may itself contain that query parameter.
  v_marker_count:=(length(v_instruction)-length(replace(v_instruction,'; exact source_url=','')))/length('; exact source_url=');
  if v_marker_count<>v_count then raise exception 'The Website Bridge instruction does not contain exactly the saved batch entries'; end if;
  for v_request in
    select id,source_url,dispatch_request_id
      from public.job_url_inspection_requests
     where user_id=v_user and batch_id=p_batch_id
     order by batch_position
  loop
    if position('request_id='||v_request.id::text||'; exact source_url='||v_request.source_url in v_instruction)=0 then
      raise exception 'The Website Bridge instruction is missing an exact saved request ID and URL';
    end if;
  end loop;

  v_idempotency_key:='job.inspect_url.batch:'||p_batch_id::text;
  select * into v_existing from public.chatgpt_dispatch_requests
   where user_id=v_user and idempotency_key=v_idempotency_key
   for update;
  if found and (v_existing.action_type is distinct from 'job.inspect_url'
      or v_existing.website_instruction is distinct from v_instruction) then
    raise exception 'The saved batch is already bound to a different Website Bridge dispatch';
  end if;

  v_dispatch:=public.create_chatgpt_dispatch_request_with_website_instruction(
    p_action_type=>'job.inspect_url',
    p_subject_refs=>jsonb_build_object('inspection_id',v_ids[1]),
    p_origin=>'user_click',
    p_display_title=>'Inspect '||v_count::text||' job listing'||case when v_count=1 then '' else 's' end,
    p_idempotency_key=>v_idempotency_key,
    p_priority=>70,
    p_website_instruction=>v_instruction
  );
  if jsonb_typeof(v_dispatch) is distinct from 'object' or coalesce(v_dispatch->>'id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'The generic Website Bridge did not return a valid dispatch identity';
  end if;
  v_dispatch_id:=(v_dispatch->>'id')::uuid;
  if exists(
    select 1 from public.job_url_inspection_requests
     where user_id=v_user and batch_id=p_batch_id
       and dispatch_request_id is not null and dispatch_request_id is distinct from v_dispatch_id
  ) then raise exception 'A URL-import entry is already linked to a different dispatch'; end if;

  -- Recover rows left terminal by the pre-transaction M04 route. That route
  -- could mark rows failed after a dispatch had been created but before its
  -- links were saved. Reopen only that exact known error and use the durable
  -- dispatch state to choose queued versus processing.
  if coalesce(v_dispatch->>'state','') not in ('failed','user_required','expired','cancelled') then
    update public.job_url_inspection_requests
       set status=case when v_dispatch->>'state'='queued' then 'queued' else 'processing' end,
           error_json=null,
           lease_expires_at=null,
           initial_fit_status=case when initial_fit_response_hash is null and initial_fit_status='needs_user' then 'pending' else initial_fit_status end,
           initial_fit_error=case when initial_fit_response_hash is null and initial_fit_status='needs_user' then null else initial_fit_error end,
           updated_at=now()
     where user_id=v_user and batch_id=p_batch_id
       and dispatch_request_id is null
       and status in ('failed','user_required')
       and job_id is null
       and initial_fit_response_hash is null
       and error_json->>'message' like '%No ChatGPT message was sent for this batch.%';
  end if;

  update public.job_url_inspection_requests
     set dispatch_request_id=v_dispatch_id
   where user_id=v_user and batch_id=p_batch_id and dispatch_request_id is null;
  select count(*) into v_linked_count from public.job_url_inspection_requests
   where user_id=v_user and batch_id=p_batch_id and dispatch_request_id=v_dispatch_id;
  if v_linked_count<>v_count then raise exception 'The Website Bridge dispatch could not be linked to every saved listing'; end if;
  return v_dispatch;
end;
$$;
revoke all on function public.create_job_url_inspection_batch_dispatch(uuid,text) from public,anon,service_role;
grant execute on function public.create_job_url_inspection_batch_dispatch(uuid,text) to authenticated;
comment on function public.create_job_url_inspection_batch_dispatch(uuid,text) is
  'Owner-scoped atomic creation or idempotent recovery of one combined URL-import dispatch and its links.';

-- A duplicate refresh can race the initial v4 batch lookup. The transaction
-- lock serializes requests with the same owner and stable request ID; the
-- existing idempotent-return path then prevents duplicate fit analyses.
do $migration$
declare
  v_signature regprocedure := 'public.create_job_fit_memory_v4_batch(uuid,uuid,text,timestamptz,boolean,jsonb,jsonb)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature),E'\r\n',E'\n');
  v_old text := $old$
  select * into v_batch from public.job_fit_memory_v4_batches where user_id=v_user and request_id=p_request_id;
$old$;
  v_new text := $new$
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text||':job-fit-memory-v4:'||p_request_id::text,0));
  select * into v_batch from public.job_fit_memory_v4_batches where user_id=v_user and request_id=p_request_id;
$new$;
begin
  if position(v_old in v_definition)=0 then
    raise exception 'The installed Memory-fit v4 batch function no longer matches the reviewed idempotency boundary';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  if position('pg_advisory_xact_lock' in v_definition)=0 or position('job-fit-memory-v4:' in v_definition)=0 then
    raise exception 'The Memory-fit v4 batch serialization lock was not installed';
  end if;
  execute v_definition;
end;
$migration$;

-- Replace M04's title/host fallback with an exact verified listing identity.
-- An ATS identifier is scoped to its provider; without one, only the requested
-- URL or parser-verified resolved listing URL is used. Similar company/title
-- values alone never collapse distinct vacancies.
do $migration$
declare
  v_signature regprocedure := 'private.complete_job_url_inspection_for_user(uuid,uuid,jsonb,text,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature),E'\r\n',E'\n');
  v_declaration text := '  v_host_key text;';
  v_declaration_replacement text := E'  v_identity_url text;\n  v_ats_key text;';
  v_old text := $old$
  v_company_key := btrim(regexp_replace(regexp_replace(lower(v_company), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_title_key := btrim(regexp_replace(regexp_replace(lower(v_title), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_external_id_key := btrim(regexp_replace(regexp_replace(lower(coalesce(p_extraction->>'external_job_id','')), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_host_key := lower(split_part(split_part(split_part(v_request.source_url, '://', 2), '/', 1), '?', 1));
  v_host_key := regexp_replace(v_host_key, ':[0-9]+$', '');
  if left(v_host_key,4)='www.' then v_host_key := substr(v_host_key,5); end if;
  if v_external_id_key <> '' then
    v_dedupe := v_company_key||'|external:'||v_external_id_key;
  else
    v_dedupe := v_company_key||'|url:'||lower(encode(extensions.digest(convert_to(v_request.source_url,'utf8'),'sha256'),'hex'));
  end if;
  v_legacy_dedupe := lower(encode(extensions.digest(convert_to(
    v_company||'|'||v_title||'|'||coalesce(p_extraction->>'application_url',v_request.source_url,''),'utf8'),'sha256'),'hex'));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_dedupe,0));
  select * into v_job from public.jobs where user_id=p_user_id and dedupe_key=v_dedupe for update;
  if not found then
    select * into v_job from public.jobs
     where user_id=p_user_id and company_id=v_company_id and source_url=v_request.source_url
       and (v_external_id_key='' or external_job_id is null
         or btrim(regexp_replace(regexp_replace(lower(external_job_id), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'))=v_external_id_key)
     order by created_at,id limit 1 for update;
    if found then
      update public.jobs set dedupe_key=v_dedupe,updated_at=now()
       where id=v_job.id and user_id=p_user_id
       returning * into v_job;
    end if;
  end if;
$old$;
  v_new text := $new$
  v_company_key := btrim(regexp_replace(regexp_replace(lower(v_company), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_title_key := btrim(regexp_replace(regexp_replace(lower(v_title), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_external_id_key := btrim(regexp_replace(regexp_replace(lower(coalesce(p_extraction->>'external_job_id','')), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_identity_url := coalesce(nullif(p_extraction->>'resolved_listing_url',''),v_request.source_url);
  v_ats_key := btrim(regexp_replace(regexp_replace(lower(coalesce(p_extraction->>'ats_provider','')), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  if v_external_id_key <> '' then
    v_dedupe := v_company_key||'|ats:'||coalesce(nullif(v_ats_key,''),'no-ats')||'|external:'||v_external_id_key;
  else
    v_dedupe := v_company_key||'|url:'||lower(encode(extensions.digest(convert_to(v_identity_url,'utf8'),'sha256'),'hex'));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_dedupe,0));
  select * into v_job from public.jobs where user_id=p_user_id and dedupe_key=v_dedupe for update;
  if not found then
    select * into v_job from public.jobs
     where user_id=p_user_id and company_id=v_company_id
       and source_url in (v_request.source_url,v_identity_url)
       and (v_external_id_key='' or external_job_id is null
         or btrim(regexp_replace(regexp_replace(lower(external_job_id), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'))=v_external_id_key)
       and (nullif(ats_provider,'') is null or v_ats_key='' or lower(ats_provider)=v_ats_key)
     order by case when source_url in (v_request.source_url,v_identity_url) then 0 else 1 end,created_at,id
     limit 1 for update;
    if found then
      update public.jobs set dedupe_key=v_dedupe,updated_at=now()
       where id=v_job.id and user_id=p_user_id
       returning * into v_job;
    end if;
  end if;
$new$;
begin
  if position(v_declaration in v_definition)=0 or position(v_old in v_definition)=0 then
    raise exception 'The installed M04 URL-completion function no longer matches the reviewed identity patch';
  end if;
  v_definition:=replace(v_definition,v_declaration,v_declaration_replacement);
  v_definition:=replace(v_definition,v_old,v_new);
  if position(v_declaration in v_definition)>0 or position(v_old in v_definition)>0
     or position('v_identity_url := coalesce' in v_definition)=0 then
    raise exception 'The M04 verified-identity dedupe patch was not completely installed';
  end if;
  execute v_definition;
end;
$migration$;

comment on column public.job_url_inspection_requests.original_source_url is
  'Exact user-submitted URL; legacy writers that omit the column are backfilled from source_url by a compatibility trigger.';
