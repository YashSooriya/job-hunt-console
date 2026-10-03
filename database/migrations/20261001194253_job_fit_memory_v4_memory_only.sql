-- Memory-only fit analysis. Post-onboarding ChatGPT requests carry only saved
-- vacancy IDs and public URLs; profile data is never frozen into this workflow.

create table public.job_fit_memory_v4_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  mode text not null check (mode in ('pending','selected','outdated')),
  state text not null default 'queued' check (state in ('queued','processing','completed','partial','needs_user')),
  assessment_as_of timestamptz not null,
  testing_mode boolean not null default false,
  requested_job_ids uuid[] not null,
  requested_count integer not null check (requested_count between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,request_id),
  check (cardinality(requested_job_ids)=requested_count)
);

create table public.job_fit_memory_v4_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null references public.job_fit_memory_v4_batches(id) on delete cascade,
  ordinal integer not null check (ordinal between 1 and 100),
  job_ids uuid[] not null check (cardinality(job_ids) between 1 and 5),
  instruction text not null check (char_length(instruction) between 1 and 5800),
  idempotency_key text not null,
  state text not null default 'queued' check (state in ('queued','waiting_for_bridge','saving','completed','needs_user')),
  dispatch_id uuid,
  operation_id uuid,
  captured_response text,
  captured_response_hash text check (captured_response_hash is null or captured_response_hash ~ '^[0-9a-f]{64}$'),
  captured_response_at timestamptz,
  response_provenance jsonb,
  delivery_turn_anchor jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id,ordinal),
  unique(user_id,idempotency_key),
  unique(dispatch_id)
);

create table public.job_fit_memory_v4_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null references public.job_fit_memory_v4_batches(id) on delete cascade,
  chunk_id uuid not null references public.job_fit_memory_v4_chunks(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  listing_url text not null check (char_length(listing_url) between 8 and 2000),
  job_revision bigint not null,
  state text not null default 'queued' check (state in ('queued','saving','assessed','insufficient_memory','listing_unavailable','wrong_listing','invalid_response','missing_result')),
  result_json jsonb,
  analysis_id uuid references public.job_analyses(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id,job_id),
  unique(chunk_id,job_id),
  unique(analysis_id)
);

create index job_fit_memory_v4_batches_owner_recent on public.job_fit_memory_v4_batches(user_id,created_at desc);
create index job_fit_memory_v4_chunks_batch_order on public.job_fit_memory_v4_chunks(batch_id,ordinal);
create index job_fit_memory_v4_items_batch_state on public.job_fit_memory_v4_items(batch_id,state,created_at);

alter table public.job_fit_memory_v4_batches enable row level security;
alter table public.job_fit_memory_v4_chunks enable row level security;
alter table public.job_fit_memory_v4_items enable row level security;
revoke all on public.job_fit_memory_v4_batches,public.job_fit_memory_v4_chunks,public.job_fit_memory_v4_items from public,anon,authenticated,service_role;

create policy job_fit_memory_v4_batches_owner on public.job_fit_memory_v4_batches
  for all to authenticated using (user_id=(select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id=(select auth.uid()) and (select private.current_user_active_member()));
create policy job_fit_memory_v4_chunks_owner on public.job_fit_memory_v4_chunks
  for all to authenticated using (user_id=(select auth.uid()) and (select private.current_user_active_member())
    and exists(select 1 from public.job_fit_memory_v4_batches b where b.id=batch_id and b.user_id=(select auth.uid())))
  with check (user_id=(select auth.uid()) and (select private.current_user_active_member())
    and exists(select 1 from public.job_fit_memory_v4_batches b where b.id=batch_id and b.user_id=(select auth.uid())));
create policy job_fit_memory_v4_items_owner on public.job_fit_memory_v4_items
  for all to authenticated using (user_id=(select auth.uid()) and (select private.current_user_active_member())
    and private.owns_job(job_id)
    and exists(select 1 from public.job_fit_memory_v4_batches b where b.id=batch_id and b.user_id=(select auth.uid()))
    and exists(select 1 from public.job_fit_memory_v4_chunks c where c.id=chunk_id and c.user_id=(select auth.uid())))
  with check (user_id=(select auth.uid()) and (select private.current_user_active_member())
    and private.owns_job(job_id)
    and exists(select 1 from public.job_fit_memory_v4_batches b where b.id=batch_id and b.user_id=(select auth.uid()))
    and exists(select 1 from public.job_fit_memory_v4_chunks c where c.id=chunk_id and c.user_id=(select auth.uid())));
grant select,insert,update on public.job_fit_memory_v4_batches,public.job_fit_memory_v4_chunks,public.job_fit_memory_v4_items to authenticated;

alter table public.job_analyses
  alter column fit_score drop not null,
  alter column priority_score drop not null,
  add column fit_component_details jsonb not null default '{}'::jsonb,
  add column assessment_completeness text check (assessment_completeness is null or assessment_completeness in ('complete','partial')),
  add column assessment_limitations jsonb not null default '[]'::jsonb,
  add column job_fit_memory_v4_item_id uuid unique references public.job_fit_memory_v4_items(id) on delete set null;

create or replace function public.create_job_fit_memory_v4_batch(
  p_batch_id uuid,p_request_id uuid,p_mode text,p_assessment_as_of timestamptz,p_testing_mode boolean,p_jobs jsonb,p_chunks jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_batch public.job_fit_memory_v4_batches;
  v_job record;
  v_chunk record;
  v_ids uuid[];
  v_count integer;
  v_existing_count integer;
  v_expected_urls text[];
begin
  if v_user is null or not (select private.current_user_active_member()) then raise exception 'Active membership required'; end if;
  if p_batch_id is null or p_request_id is null or p_mode not in ('pending','selected','outdated') or p_assessment_as_of is null then raise exception 'Invalid Memory-fit batch request'; end if;
  if jsonb_typeof(p_jobs) is distinct from 'array' or jsonb_array_length(p_jobs)<1 or jsonb_array_length(p_jobs)>100 then raise exception 'Select between 1 and 100 jobs to analyse'; end if;
  if jsonb_typeof(p_chunks) is distinct from 'array' or jsonb_array_length(p_chunks)<1 or jsonb_array_length(p_chunks)>100 then raise exception 'Invalid Memory-fit message groups'; end if;
  select array_agg((x.value->>'job_id')::uuid order by x.ordinality) into v_ids from jsonb_array_elements(p_jobs) with ordinality x(value,ordinality);
  if coalesce(cardinality(v_ids),0)<>jsonb_array_length(p_jobs)
     or (select count(distinct x) from unnest(v_ids) x)<>cardinality(v_ids) then raise exception 'Memory-fit batch contains missing or duplicate job IDs'; end if;
  select * into v_batch from public.job_fit_memory_v4_batches where user_id=v_user and request_id=p_request_id;
  if found then
    if v_batch.mode is distinct from p_mode or v_batch.requested_job_ids is distinct from v_ids then raise exception 'Request ID was already used for a different Memory-fit batch'; end if;
    select count(*) into v_existing_count from public.job_fit_memory_v4_items where batch_id=v_batch.id;
    if v_existing_count<>v_batch.requested_count then raise exception 'Saved Memory-fit batch is incomplete; retry with its original request ID'; end if;
    return jsonb_build_object('batch_id',v_batch.id,'state',v_batch.state,'requested_count',v_batch.requested_count,'idempotent',true);
  end if;

  for v_job in select * from jsonb_to_recordset(p_jobs) as x(job_id uuid,listing_url text,job_revision bigint,chunk_ordinal integer) loop
    if v_job.job_id is null or v_job.listing_url is null or v_job.job_revision is null or v_job.chunk_ordinal is null
      or char_length(v_job.listing_url)>2000 or v_job.chunk_ordinal<1 or v_job.chunk_ordinal>jsonb_array_length(p_chunks) then raise exception 'A Memory-fit job identity is invalid'; end if;
    if not exists(select 1 from public.jobs j where j.id=v_job.job_id and j.user_id=v_user and j.analysis_revision=v_job.job_revision
      and coalesce(nullif(j.source_url,''),nullif(j.application_url,''))=v_job.listing_url) then raise exception 'A job URL or revision changed before dispatch'; end if;
    if (select count(*) from jsonb_array_elements(p_chunks) c(value) where (c.value->>'ordinal')::integer=v_job.chunk_ordinal)=0 then raise exception 'A Memory-fit job refers to a missing message group'; end if;
  end loop;

  insert into public.job_fit_memory_v4_batches(id,user_id,request_id,mode,state,assessment_as_of,testing_mode,requested_job_ids,requested_count)
    values(p_batch_id,v_user,p_request_id,p_mode,'queued',p_assessment_as_of,coalesce(p_testing_mode,false),v_ids,cardinality(v_ids)) returning * into v_batch;
  for v_chunk in select * from jsonb_to_recordset(p_chunks) as x(ordinal integer,job_ids uuid[],instruction text,idempotency_key text) loop
    if v_chunk.ordinal is null or v_chunk.ordinal<1 or v_chunk.ordinal>100 or cardinality(v_chunk.job_ids) not between 1 and 5
      or v_chunk.instruction is null or char_length(v_chunk.instruction)>5800
      or v_chunk.idempotency_key is distinct from 'jobfit-memory-v4:'||v_batch.id::text||':'||v_chunk.ordinal::text
      or (select count(*) from unnest(v_chunk.job_ids) j where j=any(v_ids))<>cardinality(v_chunk.job_ids)
      or (select count(*) from unnest(v_chunk.job_ids))<> (select count(distinct j) from unnest(v_chunk.job_ids) j) then raise exception 'A Memory-fit message group is invalid'; end if;
    select array_agg(x.value->>'listing_url' order by x.ordinality) into v_expected_urls
      from jsonb_array_elements(p_jobs) with ordinality x(value,ordinality)
      where (x.value->>'job_id')::uuid=any(v_chunk.job_ids);
    if cardinality(v_expected_urls)<>cardinality(v_chunk.job_ids) then raise exception 'A Memory-fit message group does not match its saved jobs'; end if;
    insert into public.job_fit_memory_v4_chunks(user_id,batch_id,ordinal,job_ids,instruction,idempotency_key)
      values(v_user,v_batch.id,v_chunk.ordinal,v_chunk.job_ids,v_chunk.instruction,v_chunk.idempotency_key);
  end loop;
  if (select count(*) from public.job_fit_memory_v4_chunks where batch_id=v_batch.id)<>jsonb_array_length(p_chunks) then raise exception 'Memory-fit message group IDs must be unique'; end if;

  insert into public.job_fit_memory_v4_items(user_id,batch_id,chunk_id,job_id,listing_url,job_revision)
    select v_user,v_batch.id,c.id,(j.value->>'job_id')::uuid,j.value->>'listing_url',(j.value->>'job_revision')::bigint
    from jsonb_array_elements(p_jobs) j(value)
    join public.job_fit_memory_v4_chunks c on c.batch_id=v_batch.id and c.ordinal=(j.value->>'chunk_ordinal')::integer
      and (j.value->>'job_id')::uuid=any(c.job_ids);
  if (select count(*) from public.job_fit_memory_v4_items where batch_id=v_batch.id)<>v_batch.requested_count then raise exception 'Every requested job must be saved to exactly one Memory-fit message group'; end if;
  return jsonb_build_object('batch_id',v_batch.id,'state','queued','requested_count',v_batch.requested_count,'idempotent',false);
end;
$$;
revoke all on function public.create_job_fit_memory_v4_batch(uuid,uuid,text,timestamptz,boolean,jsonb,jsonb) from public,anon,service_role;
grant execute on function public.create_job_fit_memory_v4_batch(uuid,uuid,text,timestamptz,boolean,jsonb,jsonb) to authenticated;

create or replace function public.capture_job_fit_memory_v4_chunk(p_chunk_id uuid,p_dispatch_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_chunk public.job_fit_memory_v4_chunks;
  v_dispatch public.chatgpt_dispatch_requests;
  v_provenance jsonb;
  v_anchor jsonb;
  v_response text;
begin
  if v_user is null or not (select private.current_user_active_member()) then raise exception 'Active membership required'; end if;
  select * into v_chunk from public.job_fit_memory_v4_chunks where id=p_chunk_id and user_id=v_user for update;
  if not found then raise exception 'Memory-fit message group not found'; end if;
  if v_chunk.state in ('saving','completed','needs_user') and v_chunk.captured_response is not null then
    if v_chunk.dispatch_id is distinct from p_dispatch_id then raise exception 'A different dispatch is already captured for this message group'; end if;
    return jsonb_build_object('state',v_chunk.state,'idempotent',true);
  end if;
  if v_chunk.state is distinct from 'waiting_for_bridge' or v_chunk.dispatch_id is distinct from p_dispatch_id then raise exception 'Memory-fit message group is not waiting for this exact dispatch'; end if;
  select * into v_dispatch from public.chatgpt_dispatch_requests where id=p_dispatch_id and user_id=v_user;
  if not found or v_dispatch.state is distinct from 'completed' or v_dispatch.action_type is distinct from 'jobs.analyse_selected'
    or v_dispatch.idempotency_key is distinct from v_chunk.idempotency_key
    or v_dispatch.subject_refs->'job_ids' is distinct from to_jsonb(v_chunk.job_ids)
    or coalesce(v_dispatch.website_instruction,v_dispatch.manual_instruction) is distinct from v_chunk.instruction
    or coalesce(v_dispatch.output_refs->>'response_provenance_recorded','false')<>'true'
    or nullif(btrim(v_dispatch.bridge_response),'') is null or v_dispatch.bridge_response_at is null then raise exception 'The dispatch is not the exact completed Memory-fit request'; end if;
  v_provenance:=v_dispatch.response_provenance;
  v_anchor:=coalesce(v_dispatch.delivery_turn_anchor,'{}'::jsonb);
  if jsonb_typeof(v_provenance) is distinct from 'object' or jsonb_typeof(v_anchor) is distinct from 'object'
    or nullif(v_provenance->>'conversationUrl','') is null or nullif(v_provenance->>'userTurnFingerprint','') is null
    or v_provenance->>'generationFinished' is distinct from 'true'
    or v_provenance->>'source' not in ('assistant_turn','assistant_artifact')
    or (v_provenance->>'source'='assistant_turn' and coalesce(nullif(v_provenance->>'assistantMessageId',''),nullif(v_provenance->>'assistantFingerprint','')) is null)
    or (v_provenance->>'source'='assistant_artifact' and nullif(v_provenance->>'artifactKey','') is null)
    or v_anchor->>'conversationUrl' is distinct from v_provenance->>'conversationUrl'
    or (v_dispatch.delivery_user_turn_fingerprint is not null and v_dispatch.delivery_user_turn_fingerprint is distinct from v_provenance->>'userTurnFingerprint')
    or (v_anchor->>'lastAssistantMessageId' is not null and v_anchor->>'lastAssistantMessageId'=v_provenance->>'assistantMessageId')
    or (v_anchor->>'lastAssistantFingerprint' is not null and v_anchor->>'lastAssistantFingerprint'=v_provenance->>'assistantFingerprint')
    or (v_provenance->>'source'='assistant_artifact' and coalesce(v_anchor->'artifactKeys','[]'::jsonb) ? (v_provenance->>'artifactKey')) then raise exception 'The dispatch lacks exact sent-user-turn and finished-assistant-turn provenance'; end if;
  v_response:=v_dispatch.bridge_response;
  update public.job_fit_memory_v4_chunks set state='saving',captured_response=v_response,
    captured_response_hash=encode(extensions.digest(convert_to(v_response,'UTF8'),'sha256'),'hex'),
    captured_response_at=v_dispatch.bridge_response_at,response_provenance=v_provenance,delivery_turn_anchor=v_anchor,
    error_message=null,updated_at=now() where id=v_chunk.id;
  update public.job_fit_memory_v4_items set state='saving',updated_at=now() where chunk_id=v_chunk.id and state='queued';
  update public.job_fit_memory_v4_batches set state='processing',updated_at=now() where id=v_chunk.batch_id;
  return jsonb_build_object('state','saving','idempotent',false);
end;
$$;
revoke all on function public.capture_job_fit_memory_v4_chunk(uuid,uuid) from public,anon,service_role;
grant execute on function public.capture_job_fit_memory_v4_chunk(uuid,uuid) to authenticated;

create or replace function public.save_job_fit_memory_v4_chunk_results(p_chunk_id uuid,p_results jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_chunk public.job_fit_memory_v4_chunks;
  v_item public.job_fit_memory_v4_items;
  v_job public.jobs;
  v_result jsonb;
  v_analysis jsonb;
  v_analysis_id uuid;
  v_seen uuid[]:='{}';
  v_status text;
begin
  if v_user is null or not (select private.current_user_active_member()) then raise exception 'Active membership required'; end if;
  select * into v_chunk from public.job_fit_memory_v4_chunks where id=p_chunk_id and user_id=v_user for update;
  if not found or v_chunk.captured_response is null then raise exception 'No exact captured Memory-fit response is ready to save'; end if;
  if jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results)<>cardinality(v_chunk.job_ids) then raise exception 'Every saved job needs one result or explicit issue'; end if;
  for v_result in select value from jsonb_array_elements(p_results) value loop
    if jsonb_typeof(v_result) is distinct from 'object' or coalesce(v_result->>'job_id','') !~* '^[0-9a-f-]{36}$' then raise exception 'A Memory-fit result identity is invalid'; end if;
    if (v_result->>'job_id')::uuid<>all(v_chunk.job_ids) or (v_result->>'job_id')::uuid=any(v_seen) then raise exception 'Memory-fit result contains an unexpected or duplicate job'; end if;
    v_seen:=array_append(v_seen,(v_result->>'job_id')::uuid);
    select * into v_item from public.job_fit_memory_v4_items where chunk_id=v_chunk.id and job_id=(v_result->>'job_id')::uuid and user_id=v_user for update;
    if not found then raise exception 'Memory-fit item does not belong to the exact captured group'; end if;
    v_status:=v_result->>'state';
    v_analysis:=v_result->'analysis';
    if v_analysis is not null and jsonb_typeof(v_analysis) is distinct from 'object' then raise exception 'Memory-fit analysis payload is invalid'; end if;
    if v_analysis is not null then
      select * into v_job from public.jobs where id=v_item.job_id and user_id=v_user for update;
      if not found or v_job.analysis_revision is distinct from v_item.job_revision
        or coalesce(nullif(v_job.source_url,''),nullif(v_job.application_url,'')) is distinct from v_item.listing_url then raise exception 'Job listing changed before its fit result was saved'; end if;
      if coalesce(v_status,'') not in ('assessed','insufficient_memory') or (v_analysis->>'engine_version') is distinct from 'job-fit-memory-v4'
        or coalesce(v_analysis->>'input_hash','') !~ '^[0-9a-f]{64}$' or (v_analysis->>'job_revision')::bigint is distinct from v_item.job_revision
        or (v_analysis->>'fit_score' is not null and (v_analysis->>'fit_score')::numeric not between 0 and 100)
        or (v_analysis->>'priority_score' is not null and (v_analysis->>'priority_score')::numeric not between 0 and 100)
        or jsonb_typeof(v_analysis->'fit_components') is distinct from 'object'
        or jsonb_typeof(v_analysis->'fit_component_details') is distinct from 'object'
        or jsonb_typeof(v_analysis->'assessment_limitations') is distinct from 'array'
        or jsonb_typeof(v_analysis->'priority_components') is distinct from 'object'
        or jsonb_typeof(v_result->'result') is distinct from 'object' then raise exception 'Memory-fit result failed persistence validation'; end if;
      if v_item.analysis_id is not null then
        v_analysis_id:=v_item.analysis_id;
      else
        insert into public.job_analyses(
          job_id,contract_version,eligibility,eligibility_notes,fit_score,priority_score,fit_components,priority_components,
          recommended_cv_family,strengths,weaknesses,application_strategy,cover_letter_value,evidence_item_ids,
          analysis_source,triage,triage_reason,engine_version,job_revision,profile_revision,input_hash,assessment_as_of,
          fit_component_details,assessment_completeness,assessment_limitations,job_fit_memory_v4_item_id
        ) values (
          v_item.job_id,'4.0.0',(v_analysis->>'eligibility')::public.eligibility_state,
          array(select jsonb_array_elements_text(coalesce(v_analysis->'eligibility_notes','[]'::jsonb))),
          (v_analysis->>'fit_score')::numeric,(v_analysis->>'priority_score')::numeric,
          v_analysis->'fit_components',v_analysis->'priority_components',(v_analysis->>'recommended_cv_family')::public.cv_family,
          coalesce(v_analysis->'strengths','[]'::jsonb),coalesce(v_analysis->'weaknesses','[]'::jsonb),
          coalesce(v_analysis->>'application_strategy',''),v_analysis->>'cover_letter_value','{}',
          'chatgpt_memory_v4',(v_analysis->>'triage')::public.job_triage,coalesce(v_analysis->>'triage_reason',''),
          'job-fit-memory-v4',v_item.job_revision,null,(v_analysis->>'input_hash'),(v_analysis->>'assessment_as_of')::timestamptz,
          v_analysis->'fit_component_details',v_analysis->>'assessment_completeness',v_analysis->'assessment_limitations',v_item.id
        ) returning id into v_analysis_id;
      end if;
      update public.job_fit_memory_v4_items set state=v_status,result_json=v_result->'result',analysis_id=v_analysis_id,error_message=null,updated_at=now() where id=v_item.id;
    else
      if v_status not in ('listing_unavailable','wrong_listing','invalid_response','missing_result') then raise exception 'An unresolved Memory-fit item has an unsupported state'; end if;
      update public.job_fit_memory_v4_items set state=v_status,error_message=left(coalesce(v_result->>'error_message',''),1000),updated_at=now() where id=v_item.id;
    end if;
  end loop;
  update public.job_fit_memory_v4_chunks set state='completed',error_message=null,updated_at=now() where id=v_chunk.id;
  update public.job_fit_memory_v4_batches b set state=case
    when exists(select 1 from public.job_fit_memory_v4_chunks c where c.batch_id=b.id and c.state in ('queued','waiting_for_bridge','saving')) then 'processing'
    when exists(select 1 from public.job_fit_memory_v4_items i where i.batch_id=b.id and i.state in ('invalid_response','missing_result','listing_unavailable','wrong_listing')) then 'partial'
    else 'completed' end,updated_at=now() where b.id=v_chunk.batch_id;
  return jsonb_build_object('state','completed','idempotent',false);
end;
$$;
revoke all on function public.save_job_fit_memory_v4_chunk_results(uuid,jsonb) from public,anon,service_role;
grant execute on function public.save_job_fit_memory_v4_chunk_results(uuid,jsonb) to authenticated;

-- Stop unsent, profile-bearing V3 work. Completed/sent requests and captured
-- data are intentionally retained; only guaranteed pre-send dispatches cancel.
update public.chatgpt_dispatch_requests d set state='cancelled',cancelled_at=now(),updated_at=now(),
  error_json=jsonb_build_object('code','legacy_profile_prompt_retired','message','This unsent profile-bearing analysis was retired. Start the Memory-only analysis; no ChatGPT message was sent.')
where d.action_type='jobs.analyse_selected' and d.idempotency_key ~ '^jobfit-[0-9a-f-]{36}:'
  and d.state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready')
  and d.sent_at is null and d.send_attempted_at is null and d.sent_confirmed_at is null
  and d.delivery_turn_anchor is null and d.response_hash is null and d.bridge_response is null;

update public.job_fit_v3_tasks t set state='needs_user',error_message='Legacy profile-bearing V3 prompts are retired. Re-run this job with Memory-based analysis; any already captured response remains saved and no original message was resent.',
  finished_at=now(),scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
where t.state='queued';
update public.job_fit_v3_tasks t set state='needs_user',error_message='Legacy profile-bearing V3 prompts are retired. An already-sent exact response may still be recovered, but no further profile-bearing message will be sent.',
  finished_at=now(),scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
where t.state='waiting_for_bridge' and exists(select 1 from public.chatgpt_dispatch_requests d where d.id=t.active_dispatch_id and d.state='cancelled'
  and d.error_json->>'code'='legacy_profile_prompt_retired');
update public.job_fit_v3_batches b set state='partial',updated_at=now()
where exists(select 1 from public.job_fit_v3_tasks t where t.batch_id=b.id and t.state='needs_user');

-- Preserve the SECURITY INVOKER application-creation contract while accepting
-- a current V4 analysis linked to its captured Memory-only item.
create or replace function public.create_application_from_job(p_job_id uuid,p_origin text default 'manual')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_job public.jobs;
  v_analysis public.job_analyses;
  v_app public.applications;
  v_cover_letter_pending boolean;
  v_salary_known boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_origin not in ('manual','auto_prepare') then raise exception 'Invalid application preparation origin'; end if;
  select * into v_job from public.jobs where id=p_job_id and user_id=v_user;
  if not found then raise exception 'Job not found'; end if;
  select * into v_app from public.applications where user_id=v_user and job_id=p_job_id;
  if found then return jsonb_build_object('application_id',v_app.id,'created',false,'state',v_app.state,'origin',v_app.preparation_origin,'selected_cv_family',v_app.selected_cv_family,'job_snapshot_id',v_app.job_snapshot_id,'job_analysis_id',v_app.job_analysis_id); end if;
  if v_job.current_snapshot_id is null then raise exception 'Job has no frozen vacancy snapshot'; end if;
  select * into v_analysis from public.job_analyses where job_id=p_job_id
    order by case when engine_version='job-fit-memory-v4' then 0 else 1 end,created_at desc,id desc limit 1;
  if not found then raise exception 'Job has no completed fit analysis'; end if;
  if v_analysis.engine_version='job-fit-memory-v4' then
    if v_analysis.job_revision is distinct from v_job.analysis_revision or v_analysis.profile_revision is not null
      or coalesce(v_analysis.input_hash,'') !~ '^[0-9a-f]{64}$' or v_analysis.assessment_as_of is null
      or v_analysis.job_fit_memory_v4_item_id is null then raise exception 'Memory-based fit analysis is outdated; refresh it against the current listing before creating an application'; end if;
    if p_origin='auto_prepare' then raise exception 'Memory-based fit analysis requires your explicit application choice'; end if;
  else
    raise exception 'This legacy analysis cannot create a new application; run Memory-based analysis first';
  end if;
  if v_analysis.eligibility='ineligible' then raise exception 'Ineligible job cannot create an application'; end if;
  if p_origin='auto_prepare' and (v_analysis.triage <> 'auto_prepare' or v_analysis.eligibility <> 'eligible') then raise exception 'Job is not eligible for automatic preparation'; end if;
  if v_analysis.recommended_cv_family is null then raise exception 'Job analysis has no CV family'; end if;
  insert into public.applications(user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,preparation_origin,preparation_metadata,next_action,notes)
  values(v_user,p_job_id,'preparing',v_job.current_snapshot_id,v_analysis.id,v_analysis.recommended_cv_family,p_origin,
    jsonb_build_object('contract_version',v_analysis.contract_version,'analysis_source',v_analysis.analysis_source,'fit_score',v_analysis.fit_score,'priority_score',v_analysis.priority_score,'triage',v_analysis.triage),
    'Complete preparation tasks and review the finished application package.',case when p_origin='auto_prepare' then 'Application created automatically from a high-confidence job match.' else null end)
  returning * into v_app;
  insert into public.application_strategies(application_id,job_analysis_id,strategy_text,evidence_item_ids)
    values(v_app.id,v_analysis.id,coalesce(v_analysis.application_strategy,''),v_analysis.evidence_item_ids);
  v_cover_letter_pending:=v_analysis.cover_letter_value in ('high','medium');
  v_salary_known:=v_job.salary_text is not null or v_job.salary_min is not null or v_job.salary_max is not null;
  insert into public.automation_tasks(user_id,task_type,state,idempotency_key,entity_type,entity_id,input_json,output_json) values
    (v_user,'freeze_job_context','completed','application:'||v_app.id||':freeze_job_context:v1','application',v_app.id,jsonb_build_object('job_id',v_job.id,'job_snapshot_id',v_job.current_snapshot_id,'job_analysis_id',v_analysis.id),jsonb_build_object('frozen',true)),
    (v_user,'lock_application_strategy','completed','application:'||v_app.id||':lock_application_strategy:v1','application',v_app.id,jsonb_build_object('job_analysis_id',v_analysis.id,'evidence_item_ids',v_analysis.evidence_item_ids),jsonb_build_object('locked',true)),
    (v_user,'select_cv_family','completed','application:'||v_app.id||':select_cv_family:v1','application',v_app.id,jsonb_build_object('cv_family',v_analysis.recommended_cv_family),jsonb_build_object('cv_family',v_analysis.recommended_cv_family)),
    (v_user,'prepare_cv','pending','application:'||v_app.id||':prepare_cv:v1','application',v_app.id,jsonb_build_object('execution_mode','chatgpt_plus_handoff','cv_family',v_analysis.recommended_cv_family,'evidence_item_ids',v_analysis.evidence_item_ids,'unsupported_claims_target',0),null),
    (v_user,'prepare_cover_letter',case when v_cover_letter_pending then 'pending'::public.task_state else 'completed'::public.task_state end,'application:'||v_app.id||':prepare_cover_letter:v1','application',v_app.id,jsonb_build_object('execution_mode','chatgpt_plus_handoff','value',coalesce(v_analysis.cover_letter_value,'low'),'conditional',v_analysis.cover_letter_value='medium','evidence_item_ids',v_analysis.evidence_item_ids),case when v_cover_letter_pending then null else jsonb_build_object('skipped',true,'reason',case when v_analysis.cover_letter_value='not_accepted' then 'Employer does not accept a cover letter.' else 'Low expected value.' end) end),
    (v_user,'prepare_screening_answers','pending','application:'||v_app.id||':prepare_screening_answers:v1','application',v_app.id,jsonb_build_object('execution_mode','chatgpt_plus_handoff','trust_policy','verified_proposed_user_required'),null),
    (v_user,'research_salary',case when v_salary_known then 'completed'::public.task_state else 'pending'::public.task_state end,'application:'||v_app.id||':research_salary:v1','application',v_app.id,jsonb_build_object('execution_mode','chatgpt_plus_handoff','advertised_salary',v_job.salary_text,'salary_min',v_job.salary_min,'salary_max',v_job.salary_max,'salary_currency',coalesce(v_job.salary_currency,'GBP'),'required_output','clearly_labelled_estimate'),case when v_salary_known then jsonb_build_object('advertised',true) else null end),
    (v_user,'assemble_review_package','pending','application:'||v_app.id||':assemble_review_package:v1','application',v_app.id,jsonb_build_object('waits_for',jsonb_build_array('prepare_cv','prepare_cover_letter','prepare_screening_answers','research_salary')),null);
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'user',v_user::text,case when p_origin='auto_prepare' then 'application.auto_prepared' else 'application.created' end,'application',v_app.id,jsonb_build_object('job_id',p_job_id,'origin',p_origin,'job_analysis_id',v_analysis.id,'cv_family',v_analysis.recommended_cv_family));
  return jsonb_build_object('application_id',v_app.id,'created',true,'state',v_app.state,'origin',v_app.preparation_origin,'selected_cv_family',v_app.selected_cv_family,'job_snapshot_id',v_app.job_snapshot_id,'job_analysis_id',v_app.job_analysis_id);
end;
$$;
revoke all on function public.create_application_from_job(uuid,text) from public,anon,service_role;
grant execute on function public.create_application_from_job(uuid,text) to authenticated;

-- Do not let an old web release or delayed cron turn a queued, profile-bearing
-- V3 fit step into a fresh ChatGPT prompt. Already-sent exact turns and captured
-- results remain claimable so the existing V3 recovery contract is preserved.
create or replace function private.job_fit_v3_worker_claim_internal(p_limit integer,p_only_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user_id uuid;
  v_task public.job_fit_v3_tasks;
  v_input public.job_fit_v3_inputs;
  v_token uuid;
  v_claims jsonb:='[]'::jsonb;
  v_batch_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_limit is null or p_limit<1 or p_limit>5 then raise exception 'Fit scheduler claim limit must be between 1 and 5'; end if;

  for v_batch_id in
    update public.job_fit_v3_tasks t
       set state='needs_user',error_message='Membership is no longer active. Sign in with an active JobHuntAI membership before resuming this fit assessment.',
           finished_at=now(),scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
     where t.state in ('queued','waiting_for_bridge','saving')
       and not exists(select 1 from private.app_memberships m where m.user_id=t.user_id and m.status='active')
     returning t.batch_id
  loop
    perform private.refresh_job_fit_v3_batch(v_batch_id);
  end loop;

  for v_user_id in
    select t.user_id
      from public.job_fit_v3_tasks t
      join private.app_memberships m on m.user_id=t.user_id and m.status='active'
     where t.state in ('waiting_for_bridge','saving')
       and (t.scheduler_lease_token is null or t.scheduler_lease_expires_at<=now())
       and (p_only_user_id is null or t.user_id=p_only_user_id)
       and not exists(select 1 from public.job_fit_v3_tasks active
         where active.user_id=t.user_id and active.id<>t.id
           and active.state in ('waiting_for_bridge','saving')
           and active.scheduler_lease_token is not null and active.scheduler_lease_expires_at>now())
     group by t.user_id
     order by min(t.created_at),t.user_id
     limit p_limit*8
  loop
    if not pg_try_advisory_xact_lock(hashtextextended('job-fit-v3:'||v_user_id::text,0)) then continue; end if;
    select * into v_task
      from public.job_fit_v3_tasks t
     where t.user_id=v_user_id and t.state in ('waiting_for_bridge','saving')
       and (p_only_user_id is null or t.user_id=p_only_user_id)
       and (t.scheduler_lease_token is null or t.scheduler_lease_expires_at<=now())
       and not exists(select 1 from public.job_fit_v3_tasks active
         where active.user_id=t.user_id and active.id<>t.id
           and active.state in ('waiting_for_bridge','saving')
           and active.scheduler_lease_token is not null and active.scheduler_lease_expires_at>now())
     order by t.created_at,t.id
     for update skip locked limit 1;
    if not found then continue; end if;
    v_token:=gen_random_uuid();
    update public.job_fit_v3_tasks set scheduler_lease_token=v_token,scheduler_lease_expires_at=now()+interval '90 seconds'
      where id=v_task.id returning * into v_task;
    select * into v_input from public.job_fit_v3_inputs where id=v_task.current_input_id and task_id=v_task.id;
    if not found then
      update public.job_fit_v3_tasks set state='needs_user',error_message='The frozen fit-analysis input is missing. Start a fresh analysis; no ChatGPT message was resent.',
        scheduler_lease_token=null,scheduler_lease_expires_at=null,finished_at=now(),updated_at=now() where id=v_task.id;
      perform private.refresh_job_fit_v3_batch(v_task.batch_id);
      continue;
    end if;
    v_claims:=v_claims||jsonb_build_array(jsonb_build_object(
      'id',v_task.id,'user_id',v_task.user_id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
      'state',v_task.state,'current_step_index',v_task.current_step_index,'attempt_count',v_task.attempt_count,
      'active_dispatch_id',v_task.active_dispatch_id,'conversation_url',v_task.conversation_url,
      'assessment_as_of',v_task.assessment_as_of,'job_revision',v_task.job_revision,'profile_revision',v_task.profile_revision,
      'testing_mode',v_task.testing_mode,'input_hash',v_task.input_hash,'input_payload',v_input.input_payload,
      'steps',v_input.steps,'lease_token',v_token
    ));
    exit when jsonb_array_length(v_claims)>=p_limit;
  end loop;
  return v_claims;
end;
$$;
revoke all on function private.job_fit_v3_worker_claim_internal(integer,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_claim_internal(integer,uuid) to service_role;

-- The scheduler can still finish/capture an exact V3 turn that was sent before
-- this migration, but stale web/Edge versions must not create a new frozen
-- profile-bearing batch or dispatch a queued V3 step after the cutover.
create or replace function private.job_fit_v3_worker_create_batch_internal(
  p_user_id uuid,p_request_id uuid,p_mode text,p_job_ids uuid[],p_tasks jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  raise exception 'Profile-bearing V3 batch creation is retired. Use Memory-only job analysis.';
end;
$$;
revoke all on function private.job_fit_v3_worker_create_batch_internal(uuid,uuid,text,uuid[],jsonb) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_create_batch_internal(uuid,uuid,text,uuid[],jsonb) to service_role;

create or replace function private.job_fit_v3_worker_dispatch_internal(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.job_fit_v3_tasks;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id for update;
  if not found then raise exception 'Fit task not found'; end if;
  if v_task.state='needs_user' then return jsonb_build_object('state','needs_user','dispatch_id',null,'retired',true); end if;
  if v_task.state is distinct from 'queued' then raise exception 'Legacy V3 task is not eligible for dispatch'; end if;
  if p_lease_token is null or v_task.scheduler_lease_token is distinct from p_lease_token
    or v_task.scheduler_lease_expires_at is null or v_task.scheduler_lease_expires_at<=now() then
    raise exception 'Fit scheduler lease expired before dispatch';
  end if;
  update public.job_fit_v3_tasks set state='needs_user',error_message='Profile-bearing V3 prompts are retired. Run a fresh Memory-only analysis; no new ChatGPT message was sent.',
    scheduler_lease_token=null,scheduler_lease_expires_at=null,finished_at=now(),updated_at=now()
   where id=v_task.id and user_id=p_user_id;
  perform private.refresh_job_fit_v3_batch(v_task.batch_id);
  return jsonb_build_object('state','needs_user','dispatch_id',null,'retired',true,
    'error','Profile-bearing V3 prompts are retired. Use Memory-only job analysis.');
end;
$$;
revoke all on function private.job_fit_v3_worker_dispatch_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_dispatch_internal(uuid,uuid,uuid) to service_role;

-- Memory-based documents retain explicit user review and all prior rendering,
-- idempotency and application ownership behavior. The legacy evidence-backed
-- branch is unchanged; only the new contract replaces database evidence IDs
-- with auditable Memory-support notes and never queries candidate facts.
create or replace function public.create_cv_document_version(
  p_application_id uuid,p_structured_content jsonb,p_latex_source text,p_evidence_links jsonb,
  p_engine text default 'deterministic_v1'
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_profile_id uuid;
  v_document public.documents;
  v_version public.document_versions;
  v_version_number integer;
  v_claim record;
  v_evidence_id_text text;
  v_evidence_id uuid;
  v_link jsonb;
  v_expected_family text;
  v_memory_only boolean := coalesce(p_structured_content->>'source_mode'='chatgpt_memory',false);
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_structured_content is null or jsonb_typeof(p_structured_content) is distinct from 'object' then raise exception 'Structured CV content is required'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user;
  if not found then raise exception 'Application not found'; end if;
  if v_app.selected_cv_family is null then raise exception 'Application has no selected CV family'; end if;
  v_expected_family := v_app.selected_cv_family::text;
  if coalesce(p_structured_content->>'base_family','') <> v_expected_family then raise exception 'CV base family does not match the application'; end if;
  if jsonb_typeof(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb)) is distinct from 'array'
     or jsonb_array_length(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb)) > 0 then raise exception 'CV contains unsupported claims'; end if;

  if v_memory_only then
    if p_structured_content->>'engine_version' is distinct from 'chatgpt-memory-v4'
      or coalesce((p_structured_content->>'memory_review_required')::boolean,false) is not true
      or jsonb_typeof(coalesce(p_evidence_links,'[]'::jsonb)) is distinct from 'array'
      or jsonb_array_length(coalesce(p_evidence_links,'[]'::jsonb))<>0
      or jsonb_typeof(p_structured_content->'headline_memory_support') is distinct from 'array'
      or jsonb_array_length(p_structured_content->'headline_memory_support')=0
      or jsonb_typeof(p_structured_content->'profile_summary') is distinct from 'object'
      or jsonb_typeof(p_structured_content->'profile_summary'->'memory_support') is distinct from 'array'
      or jsonb_array_length(p_structured_content->'profile_summary'->'memory_support')=0
      or jsonb_typeof(p_structured_content->'sections') is distinct from 'array'
      or jsonb_array_length(p_structured_content->'sections')=0 then
      raise exception 'Memory-only CV must retain review status and Memory-support notes, with no local evidence links';
    end if;
    if exists(select 1 from jsonb_array_elements_text(p_structured_content->'headline_memory_support') as x(value) where btrim(x.value)='')
      or exists(select 1 from jsonb_array_elements_text(p_structured_content->'profile_summary'->'memory_support') as x(value) where btrim(x.value)='') then
      raise exception 'A Memory-only CV support note is empty';
    end if;
    if exists(select 1 from jsonb_array_elements(p_structured_content->'sections') s(value)
      where jsonb_typeof(s.value) is distinct from 'object' or jsonb_typeof(s.value->'entries') is distinct from 'array') then
      raise exception 'Memory-only CV sections are invalid';
    end if;
    for v_claim in
      select e.value as entry, b.value as bullet
      from jsonb_array_elements(p_structured_content->'sections') s(value)
      cross join jsonb_array_elements(s.value->'entries') e(value)
      cross join jsonb_array_elements(coalesce(e.value->'bullets','[]'::jsonb)) b(value)
    loop
      if jsonb_typeof(v_claim.entry->'memory_support') is distinct from 'array'
        or jsonb_array_length(v_claim.entry->'memory_support')=0
        or jsonb_typeof(v_claim.bullet->'memory_support') is distinct from 'array'
        or jsonb_array_length(v_claim.bullet->'memory_support')=0
        or jsonb_typeof(coalesce(v_claim.bullet->'evidence_ids','[]'::jsonb)) is distinct from 'array'
        or jsonb_array_length(coalesce(v_claim.bullet->'evidence_ids','[]'::jsonb))<>0 then
        raise exception 'Every material Memory-only CV entry needs Memory support and no database evidence IDs';
      end if;
      if exists(select 1 from jsonb_array_elements_text(v_claim.entry->'memory_support') as x(value) where btrim(x.value)='')
        or exists(select 1 from jsonb_array_elements_text(v_claim.bullet->'memory_support') as x(value) where btrim(x.value)='') then
        raise exception 'A material Memory-only CV claim has an empty support note';
      end if;
    end loop;
    if coalesce(p_structured_content->'headline_evidence_ids','[]'::jsonb)<>'[]'::jsonb
      or coalesce(p_structured_content->'profile_summary'->'evidence_ids','[]'::jsonb)<>'[]'::jsonb then
      raise exception 'Memory-only CV cannot claim local evidence IDs';
    end if;
  else
    select id into v_profile_id from public.candidate_profiles where user_id=v_user limit 1;
    if v_profile_id is null then raise exception 'Candidate profile not found'; end if;
    for v_claim in
      select 'profile_summary'::text as claim_key, coalesce(p_structured_content->'profile_summary'->'evidence_ids','[]'::jsonb) as evidence_ids
      union all
      select b->>'claim_key', coalesce(b->'evidence_ids','[]'::jsonb)
      from jsonb_array_elements(coalesce(p_structured_content->'sections','[]'::jsonb)) s,
           jsonb_array_elements(coalesce(s->'entries','[]'::jsonb)) e,
           jsonb_array_elements(coalesce(e->'bullets','[]'::jsonb)) b
      where coalesce((b->>'material')::boolean,false)
    loop
      if v_claim.claim_key is null or jsonb_array_length(v_claim.evidence_ids)=0 then raise exception 'Material CV claim has no evidence'; end if;
      for v_evidence_id_text in select jsonb_array_elements_text(v_claim.evidence_ids)
      loop
        begin v_evidence_id := v_evidence_id_text::uuid;
        exception when invalid_text_representation then raise exception 'CV evidence ID is not a persistent UUID: %', v_evidence_id_text; end;
        if not exists(select 1 from public.evidence_items where id=v_evidence_id and profile_id=v_profile_id and verification_status='verified') then
          raise exception 'CV references unverified or foreign evidence: %',v_evidence_id_text;
        end if;
        if not exists(select 1 from jsonb_array_elements(coalesce(p_evidence_links,'[]'::jsonb)) x
          where x->>'claim_key'=v_claim.claim_key and x->>'evidence_id'=v_evidence_id_text) then
          raise exception 'CV evidence-link manifest is incomplete for claim %',v_claim.claim_key;
        end if;
      end loop;
    end loop;
  end if;

  select * into v_document from public.documents where application_id=p_application_id and kind='cv' for update;
  if not found then
    insert into public.documents(application_id,kind,title,cv_family)
      values(p_application_id,'cv',coalesce(v_app.selected_cv_family::text,'Tailored')||' CV',v_app.selected_cv_family) returning * into v_document;
  end if;
  select coalesce(max(version_number),0)+1 into v_version_number from public.document_versions where document_id=v_document.id;
  insert into public.document_versions(document_id,version_number,structured_content,latex_source,model,prompt_version,change_summary,approval_status)
    values(v_document.id,v_version_number,p_structured_content,p_latex_source,p_engine,
      coalesce(p_structured_content->>'contract_version','1.0.0'),coalesce(p_structured_content->'change_summary','[]'::jsonb),'needs_review') returning * into v_version;
  if not v_memory_only then
    for v_link in select value from jsonb_array_elements(coalesce(p_evidence_links,'[]'::jsonb)) loop
      insert into public.document_evidence_links(document_version_id,evidence_item_id,claim_key)
        values(v_version.id,(v_link->>'evidence_id')::uuid,v_link->>'claim_key') on conflict do nothing;
    end loop;
  end if;
  update public.automation_tasks set state='completed',updated_at=now(),output_json=jsonb_build_object(
    'document_id',v_document.id,'document_version_id',v_version.id,'version_number',v_version_number,
    'unsupported_claims_count',0,'engine',p_engine,'source_mode',case when v_memory_only then 'chatgpt_memory' else 'verified_profile_evidence' end)
   where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_cv';
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'system','cv-engine','document.cv_version_created','document_version',v_version.id,
      jsonb_build_object('application_id',p_application_id,'document_id',v_document.id,'version_number',v_version_number,'engine',p_engine,
        'cv_family',v_app.selected_cv_family,'source_mode',case when v_memory_only then 'chatgpt_memory' else 'verified_profile_evidence' end));
  return jsonb_build_object('document_id',v_document.id,'document_version_id',v_version.id,'version_number',v_version_number,'approval_status','needs_review');
end;
$$;
revoke execute on function public.create_cv_document_version(uuid,jsonb,text,jsonb,text) from public,anon,service_role;
grant execute on function public.create_cv_document_version(uuid,jsonb,text,jsonb,text) to authenticated;

create or replace function public.create_application_cover_letter_version(
  p_application_id uuid,p_structured_content jsonb,p_engine text default 'chatgpt-bridge-v1'
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_profile_id uuid;
  v_document public.documents;
  v_version public.document_versions;
  v_number integer;
  v_paragraph jsonb;
  v_key text;
  v_evidence text;
  v_memory_only boolean := coalesce(p_structured_content->>'source_mode'='chatgpt_memory',false);
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.preparation_origin<>'manual' or v_app.state not in ('preparing','ready_for_review','revision_requested') then
    raise exception 'Choose to apply and keep the application open before generating documents';
  end if;
  if jsonb_typeof(p_structured_content) is distinct from 'object'
    or jsonb_typeof(p_structured_content->'paragraphs') is distinct from 'array'
    or jsonb_array_length(p_structured_content->'paragraphs')<3 or jsonb_array_length(p_structured_content->'paragraphs')>8
    or jsonb_typeof(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb))>0 then
    raise exception 'Cover letter content did not pass structural validation';
  end if;
  if v_memory_only then
    if p_structured_content->>'engine_version' is distinct from 'chatgpt-memory-v4'
      or coalesce((p_structured_content->>'memory_review_required')::boolean,false) is not true then
      raise exception 'Memory-only cover letter must remain explicitly unverified and require user review';
    end if;
    for v_paragraph in select value from jsonb_array_elements(p_structured_content->'paragraphs') loop
      if coalesce((v_paragraph->>'material')::boolean,false) then
        if jsonb_typeof(v_paragraph->'memory_support') is distinct from 'array'
          or jsonb_array_length(v_paragraph->'memory_support')=0
          or jsonb_typeof(coalesce(v_paragraph->'evidence_ids','[]'::jsonb)) is distinct from 'array'
          or jsonb_array_length(coalesce(v_paragraph->'evidence_ids','[]'::jsonb))<>0 then
          raise exception 'Every material Memory-only cover-letter paragraph needs Memory support and no database evidence IDs';
        end if;
        if exists(select 1 from jsonb_array_elements_text(v_paragraph->'memory_support') as x(value) where btrim(x.value)='') then
          raise exception 'A Memory-only cover-letter paragraph has an empty support note';
        end if;
      end if;
    end loop;
  else
    select id into v_profile_id from public.candidate_profiles where user_id=v_user;
    if v_profile_id is null then raise exception 'Candidate profile not found'; end if;
    for v_paragraph in select value from jsonb_array_elements(p_structured_content->'paragraphs') loop
      if coalesce((v_paragraph->>'material')::boolean,false) then
        v_key:=v_paragraph->>'paragraph_key';
        if v_key is null or jsonb_array_length(coalesce(v_paragraph->'evidence_ids','[]'::jsonb))=0 then raise exception 'A material paragraph has no evidence'; end if;
        for v_evidence in select jsonb_array_elements_text(v_paragraph->'evidence_ids') loop
          if not exists(select 1 from public.evidence_items e where e.id=v_evidence::uuid and e.profile_id=v_profile_id and e.verification_status='verified') then
            raise exception 'Cover letter references unverified evidence';
          end if;
        end loop;
      end if;
    end loop;
  end if;

  select * into v_document from public.documents where application_id=p_application_id and kind='cover_letter' for update;
  if not found then insert into public.documents(application_id,kind,title) values(p_application_id,'cover_letter','Tailored Cover Letter') returning * into v_document; end if;
  select coalesce(max(version_number),0)+1 into v_number from public.document_versions where document_id=v_document.id;
  insert into public.document_versions(document_id,version_number,structured_content,model,prompt_version,change_summary,approval_status)
    values(v_document.id,v_number,p_structured_content,p_engine,coalesce(p_structured_content->>'contract_version','1.0.0'),
      coalesce(p_structured_content->'change_summary','[]'::jsonb),'needs_review') returning * into v_version;
  if not v_memory_only then
    for v_paragraph in select value from jsonb_array_elements(p_structured_content->'paragraphs') loop
      if coalesce((v_paragraph->>'material')::boolean,false) then
        for v_evidence in select jsonb_array_elements_text(v_paragraph->'evidence_ids') loop
          insert into public.document_evidence_links(document_version_id,evidence_item_id,claim_key)
            values(v_version.id,v_evidence::uuid,v_paragraph->>'paragraph_key') on conflict do nothing;
        end loop;
      end if;
    end loop;
  end if;
  update public.automation_tasks set state='completed',updated_at=now(),last_error=null,
    output_json=jsonb_build_object('document_id',v_document.id,'document_version_id',v_version.id,'engine',p_engine,
      'source_mode',case when v_memory_only then 'chatgpt_memory' else 'verified_profile_evidence' end)
   where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_cover_letter';
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'system','document-generation','document.cover_letter_version_created','document_version',v_version.id,
      jsonb_build_object('application_id',p_application_id,'document_id',v_document.id,'version_number',v_number,'engine',p_engine,
        'source_mode',case when v_memory_only then 'chatgpt_memory' else 'verified_profile_evidence' end));
  return jsonb_build_object('document_id',v_document.id,'document_version_id',v_version.id,'version_number',v_number,'approval_status','needs_review');
end;
$$;
revoke all on function public.create_application_cover_letter_version(uuid,jsonb,text) from public,anon,service_role;
grant execute on function public.create_application_cover_letter_version(uuid,jsonb,text) to authenticated;

create or replace function public.create_application_document_version(
  p_item_id uuid,p_structured_content jsonb,p_evidence_links jsonb,p_plaintext text,p_quality_report jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_item public.document_generation_items;
  v_request public.document_generation_requests;
  v_result jsonb;
  v_version_id uuid;
  v_version_number integer;
  v_engine text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document item not found'; end if;
  if v_item.document_version_id is not null then
    return jsonb_build_object('document_version_id',v_item.document_version_id,'version_number',v_item.version_number,'idempotent',true);
  end if;
  if v_item.response_hash is null or v_item.state not in ('validating','rendering','saving_drive') then raise exception 'A captured document response is required'; end if;
  if jsonb_typeof(p_structured_content) is distinct from 'object' or jsonb_typeof(p_quality_report) is distinct from 'object'
    or length(coalesce(p_plaintext,''))>300000 or jsonb_typeof(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb))>0 then
    raise exception 'Document did not pass structural or evidence validation';
  end if;
  select * into v_request from public.document_generation_requests where id=v_item.request_id and user_id=v_user for update;
  if not found or v_request.application_id<>v_item.application_id then raise exception 'Document generation request does not match its item'; end if;
  if v_request.testing_mode and v_item.response_text not ilike '%"document_kind"%' then raise exception 'Test-mode response cannot be saved as an application document'; end if;
  v_engine:=case when p_structured_content->>'source_mode'='chatgpt_memory' then 'chatgpt-memory-v4' else 'chatgpt-bridge-docx-v1' end;
  if v_item.document_kind='cv' then
    v_result:=public.create_cv_document_version(v_item.application_id,p_structured_content,
      '%% JobHuntAI PDF/DOCX rendered from validated structured content',p_evidence_links,v_engine);
  else
    v_result:=public.create_application_cover_letter_version(v_item.application_id,p_structured_content,v_engine);
  end if;
  v_version_id:=(v_result->>'document_version_id')::uuid;
  v_version_number:=(v_result->>'version_number')::integer;
  if v_version_id is null or v_version_number is null then raise exception 'Document version persistence returned no version id'; end if;
  update public.document_generation_items set document_version_id=v_version_id,version_number=v_version_number,
    structured_content=p_structured_content,plaintext=nullif(p_plaintext,''),quality_report=p_quality_report,state='rendering',updated_at=now()
    where id=p_item_id and user_id=v_user;
  update public.document_generation_requests set state='rendering',updated_at=now() where id=v_request.id and user_id=v_user;
  return v_result||jsonb_build_object('idempotent',false);
end;
$$;
revoke all on function public.create_application_document_version(uuid,jsonb,jsonb,text,jsonb) from public,anon,service_role;
grant execute on function public.create_application_document_version(uuid,jsonb,jsonb,text,jsonb) to authenticated;

comment on table public.job_fit_memory_v4_batches is 'Memory-only fit batches; post-onboarding ChatGPT inputs contain saved job IDs/URLs and no candidate profile data.';
comment on table public.job_fit_memory_v4_chunks is 'Durable URL-only generic Website Bridge dispatches and immutable exact assistant-turn captures for Memory-only fit analysis.';
