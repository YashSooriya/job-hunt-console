-- M04: preserve the submitted URL, correlate a combined extraction/fit turn,
-- and persist fit results through the existing Memory-fit v4 analysis tables.
alter table public.job_url_inspection_requests
  add column original_source_url text,
  add column initial_fit_status text,
  add column initial_fit_error text,
  add column initial_fit_analysis_id uuid references public.job_analyses(id) on delete set null,
  add column initial_fit_response_hash text,
  add column initial_fit_assessment_as_of timestamptz,
  add column initial_fit_testing_mode boolean not null default false;

update public.job_url_inspection_requests
   set original_source_url=source_url
 where original_source_url is null;

alter table public.job_url_inspection_requests
  alter column original_source_url set not null,
  add constraint job_url_inspection_original_url_check
    check (char_length(original_source_url) between 1 and 2000),
  add constraint job_url_inspection_initial_fit_status_check
    check (initial_fit_status is null or initial_fit_status in (
      'pending','assessed','insufficient_memory','incomplete','listing_unavailable','wrong_listing',
      'invalid_response','missing_result','needs_user'
    )),
  add constraint job_url_inspection_initial_fit_hash_check
    check (initial_fit_response_hash is null or initial_fit_response_hash ~ '^[0-9a-f]{64}$');

create index job_url_inspection_initial_fit_analysis_idx
  on public.job_url_inspection_requests(initial_fit_analysis_id)
  where initial_fit_analysis_id is not null;

-- Prefer an ATS identifier, otherwise hash the canonical exact listing URL.
-- This prevents different vacancies with the same employer/title/host from
-- collapsing into one record. Existing exact-URL imports are still reused.
do $migration$
declare
  v_signature regprocedure := 'private.complete_job_url_inspection_for_user(uuid,uuid,jsonb,text,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), E'\r\n', E'\n');
  v_lookup text := $old$
  v_company_key := btrim(regexp_replace(regexp_replace(lower(v_company), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_title_key := btrim(regexp_replace(regexp_replace(lower(v_title), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_external_id_key := btrim(regexp_replace(regexp_replace(lower(coalesce(p_extraction->>'external_job_id','')), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_host_key := lower(split_part(split_part(split_part(v_request.source_url, '://', 2), '/', 1), '?', 1));
  v_host_key := regexp_replace(v_host_key, ':[0-9]+$', '');
  if left(v_host_key,4)='www.' then v_host_key := substr(v_host_key,5); end if;
  if v_external_id_key <> '' then
    v_dedupe := v_company_key||'|external:'||v_external_id_key;
  else
    v_dedupe := v_company_key||'|'||v_title_key||'|'||coalesce(nullif(v_host_key,''),'no-host');
  end if;
  v_legacy_dedupe := lower(encode(extensions.digest(convert_to(
    v_company||'|'||v_title||'|'||coalesce(p_extraction->>'application_url',v_request.source_url,''),'utf8'),'sha256'),'hex'));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_dedupe,0));
  select * into v_job
    from public.jobs
   where user_id=p_user_id and dedupe_key=v_dedupe
   for update;
  if not found then
    select * into v_job
      from public.jobs
     where user_id=p_user_id and dedupe_key=v_legacy_dedupe
     for update;
    if found then
      update public.jobs set dedupe_key=v_dedupe,updated_at=now()
       where id=v_job.id and user_id=p_user_id
       returning * into v_job;
    end if;
  end if;
$old$;
  v_lookup_replacement text := $new$
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
$new$;
  v_hash_old text := $old$  v_content_hash := encode(extensions.digest(convert_to(v_description,'utf8'),'sha256'),'hex');$old$;
  v_hash_new text := $new$  v_content_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('extraction',p_extraction-'raw_metadata'-'request_id',
      'evidence',coalesce(p_extraction->'raw_metadata','{}'::jsonb)-'retrieved_at')::text,'utf8'),'sha256'),'hex');$new$;
  v_snapshot_old text := $old$
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
$old$;
  v_snapshot_new text := $new$
  else
    -- Identical content keeps its original provenance timestamp and metadata.
    null;
  end if;
$new$;
begin
  if position(v_lookup in v_definition)=0 or position(v_hash_old in v_definition)=0 or position(v_snapshot_old in v_definition)=0 then
    raise exception 'The installed URL completion function no longer matches the reviewed M04 snapshot and dedupe patches';
  end if;
  v_definition:=replace(v_definition,v_lookup,v_lookup_replacement);
  v_definition:=replace(v_definition,v_hash_old,v_hash_new);
  v_definition:=replace(v_definition,v_snapshot_old,v_snapshot_new);
  if position(v_lookup in v_definition)>0 or position(v_hash_old in v_definition)>0 or position(v_snapshot_old in v_definition)>0 then
    raise exception 'The M04 URL completion patch did not replace every reviewed fragment';
  end if;
  execute v_definition;
end;
$migration$;

create or replace function private.save_job_url_inspection_initial_fit_for_user(
  p_user_id uuid,p_request_id uuid,p_dispatch_id uuid,p_response_hash text,
  p_fit_status text,p_fit_error text,p_analysis_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request public.job_url_inspection_requests;
  v_dispatch public.chatgpt_dispatch_requests;
  v_item public.job_fit_memory_v4_items;
  v_analysis public.job_analyses;
  v_job public.jobs;
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid()) then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if p_request_id is null or p_dispatch_id is null or coalesce(p_response_hash,'') !~ '^[0-9a-f]{64}$' then raise exception 'The exact combined-import response identity is required'; end if;
  if p_fit_status not in ('assessed','insufficient_memory','incomplete','listing_unavailable','wrong_listing','invalid_response','missing_result','needs_user') then
    raise exception 'The initial Memory-fit status is unsupported';
  end if;
  if length(coalesce(p_fit_error,''))>1800 then raise exception 'The initial fit explanation is too long'; end if;

  select * into v_request from public.job_url_inspection_requests
   where id=p_request_id and user_id=p_user_id for update;
  if not found or v_request.status<>'completed' or v_request.job_id is null
     or v_request.dispatch_request_id is distinct from p_dispatch_id or v_request.batch_id is null then
    raise exception 'The completed listing is not linked to this exact URL-import batch';
  end if;
  select * into v_dispatch from public.chatgpt_dispatch_requests
   where id=p_dispatch_id and user_id=p_user_id for share;
  if not found or v_dispatch.action_type<>'job.inspect_url' or v_dispatch.state<>'completed'
     or v_dispatch.response_hash is distinct from p_response_hash or v_dispatch.bridge_response is null
     or encode(extensions.digest(convert_to(btrim(v_dispatch.bridge_response),'utf8'),'sha256'),'hex') is distinct from p_response_hash
     or v_dispatch.output_refs->>'response_provenance_recorded' is distinct from 'true'
     or v_dispatch.response_provenance is null then
    raise exception 'The initial fit does not match the exact captured Website Bridge response';
  end if;
  perform private.chatgpt_validate_response_provenance(v_dispatch.response_provenance,v_dispatch);

  if v_request.initial_fit_response_hash is not null then
    if v_request.initial_fit_response_hash=p_response_hash
       and v_request.initial_fit_status=p_fit_status
       and v_request.initial_fit_analysis_id is not distinct from p_analysis_id then
      return jsonb_build_object('request_id',v_request.id,'fit_status',v_request.initial_fit_status,'analysis_id',v_request.initial_fit_analysis_id,'idempotent',true);
    end if;
    raise exception 'The initial fit result is already final for this captured response';
  end if;

  if p_analysis_id is not null then
    if p_fit_status not in ('assessed','insufficient_memory','incomplete') then raise exception 'Only assessed or explicitly incomplete fits may link an analysis'; end if;
    select * into v_item from public.job_fit_memory_v4_items
     where user_id=p_user_id and batch_id=v_request.batch_id and job_id=v_request.job_id and analysis_id=p_analysis_id for share;
    if not found or v_item.state not in ('assessed','insufficient_memory') then raise exception 'The fit analysis is not part of this exact URL-import fit batch'; end if;
    select * into v_analysis from public.job_analyses where id=p_analysis_id and job_id=v_request.job_id for share;
    if not found then raise exception 'The linked initial fit analysis no longer exists'; end if;
    select * into v_job from public.jobs where id=v_request.job_id and user_id=p_user_id for share;
    if not found then raise exception 'The imported job no longer belongs to this user'; end if;
    if v_analysis.engine_version<>'job-fit-memory-v4' or v_analysis.profile_revision is not null
       or v_analysis.job_revision is distinct from v_job.analysis_revision or v_analysis.input_hash !~ '^[0-9a-f]{64}$'
       or v_analysis.assessment_as_of is null or v_analysis.fit_score is not null and v_analysis.fit_score not between 0 and 100 then
      raise exception 'The saved initial fit is incomplete or outdated for this listing';
    end if;
    if p_fit_status='incomplete' and v_analysis.assessment_completeness<>'partial' then raise exception 'An incomplete fit must be explicitly stored as partial'; end if;
    if p_fit_status='assessed' and v_analysis.assessment_completeness<>'complete' then raise exception 'A partial fit cannot be marked assessed'; end if;
    if p_fit_status='insufficient_memory' and (v_analysis.assessment_completeness<>'partial' or v_analysis.fit_score is not null) then raise exception 'Insufficient Memory must keep the overall fit unknown'; end if;
  elsif p_fit_status in ('assessed','insufficient_memory','incomplete') then
    raise exception 'A fit assessment cannot be marked complete without its saved Memory-fit analysis';
  end if;

  update public.job_url_inspection_requests
     set initial_fit_status=p_fit_status,
         initial_fit_error=nullif(left(coalesce(p_fit_error,''),1000),''),
         initial_fit_analysis_id=p_analysis_id,
         initial_fit_response_hash=p_response_hash,
         updated_at=now()
   where id=v_request.id and user_id=p_user_id;
  return jsonb_build_object('request_id',v_request.id,'fit_status',p_fit_status,'analysis_id',p_analysis_id,'idempotent',false);
end;
$$;
revoke all on function private.save_job_url_inspection_initial_fit_for_user(uuid,uuid,uuid,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function private.save_job_url_inspection_initial_fit_for_user(uuid,uuid,uuid,text,text,text,uuid) to authenticated;

create or replace function public.save_job_url_inspection_initial_fit(
  p_request_id uuid,p_dispatch_id uuid,p_response_hash text,p_fit_status text,p_fit_error text default null,p_analysis_id uuid default null
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.save_job_url_inspection_initial_fit_for_user((select auth.uid()),p_request_id,p_dispatch_id,p_response_hash,p_fit_status,p_fit_error,p_analysis_id);
$$;
revoke all on function public.save_job_url_inspection_initial_fit(uuid,uuid,text,text,text,uuid) from public,anon,service_role;
grant execute on function public.save_job_url_inspection_initial_fit(uuid,uuid,text,text,text,uuid) to authenticated;

comment on column public.job_url_inspection_requests.original_source_url is 'Exact user-submitted URL before canonical tracking-parameter removal.';
comment on column public.job_url_inspection_requests.initial_fit_status is 'Per-listing result of the same correlated Bridge response that extracted the listing.';
comment on function public.save_job_url_inspection_initial_fit(uuid,uuid,text,text,text,uuid) is 'Owner-scoped, exact-turn, idempotent link from combined URL import to its existing Memory-fit v4 analysis.';
