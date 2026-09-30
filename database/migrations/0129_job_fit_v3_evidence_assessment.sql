-- V3 fit assessment records are owner-scoped and advance through the existing
-- Website Bridge. This migration leaves all Bridge dispatch and provenance
-- wrappers, including the 0101 security boundary, untouched.

create table public.job_fit_v3_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  mode text not null check (mode in ('pending','selected','outdated','retry')),
  state text not null default 'queued' check (state in ('queued','processing','completed','partial','cancelled')),
  requested_job_ids uuid[] not null default '{}',
  requested_count integer not null default 0 check (requested_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id,request_id)
);

create table public.job_fit_v3_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null references public.job_fit_v3_batches(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  assessment_request_id text not null,
  semantic_key text not null check (semantic_key ~ '^[0-9a-f]{64}$'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  job_revision bigint not null,
  profile_revision bigint not null,
  assessment_as_of timestamptz not null,
  testing_mode boolean not null default false,
  input_payload jsonb not null check (jsonb_typeof(input_payload)='object' and octet_length(input_payload::text)<=1000000),
  steps jsonb not null check (jsonb_typeof(steps)='array' and jsonb_array_length(steps) between 1 and 200 and octet_length(steps::text)<=1000000),
  current_step_index integer not null default 0 check (current_step_index >= 0),
  attempt_count integer not null default 1 check (attempt_count > 0),
  state text not null default 'queued' check (state in ('queued','waiting_for_bridge','saving','completed','needs_user','failed','cancelled')),
  active_dispatch_id uuid,
  captured_responses jsonb not null default '[]'::jsonb check (jsonb_typeof(captured_responses)='array'),
  result_json jsonb check (result_json is null or jsonb_typeof(result_json)='object'),
  analysis_id uuid references public.job_analyses(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (batch_id,job_id),
  unique (assessment_request_id)
);

create index job_fit_v3_batches_owner_recent on public.job_fit_v3_batches(user_id,created_at desc);
create index job_fit_v3_tasks_owner_recent on public.job_fit_v3_tasks(user_id,created_at desc);
create index job_fit_v3_tasks_batch_order on public.job_fit_v3_tasks(batch_id,created_at,id);
create unique index job_fit_v3_tasks_one_active_per_job
  on public.job_fit_v3_tasks(user_id,job_id)
  where state in ('queued','waiting_for_bridge','saving');

alter table public.job_fit_v3_batches enable row level security;
alter table public.job_fit_v3_tasks enable row level security;
revoke all on public.job_fit_v3_batches,public.job_fit_v3_tasks from public,anon,authenticated,service_role;

create policy job_fit_v3_batches_owner_select on public.job_fit_v3_batches
  for select to authenticated using (user_id=(select auth.uid()) and (select private.current_user_active_member()));
create policy job_fit_v3_batches_owner_insert on public.job_fit_v3_batches
  for insert to authenticated with check (user_id=(select auth.uid()) and (select private.current_user_active_member()));
create policy job_fit_v3_batches_owner_update on public.job_fit_v3_batches
  for update to authenticated using (user_id=(select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id=(select auth.uid()) and (select private.current_user_active_member()));

create policy job_fit_v3_tasks_owner_select on public.job_fit_v3_tasks
  for select to authenticated using (user_id=(select auth.uid()) and (select private.current_user_active_member()) and private.owns_job(job_id)
    and exists(select 1 from public.job_fit_v3_batches b where b.id=batch_id and b.user_id=(select auth.uid())));
create policy job_fit_v3_tasks_owner_insert on public.job_fit_v3_tasks
  for insert to authenticated with check (user_id=(select auth.uid()) and (select private.current_user_active_member()) and private.owns_job(job_id)
    and exists(select 1 from public.job_fit_v3_batches b where b.id=batch_id and b.user_id=(select auth.uid())));
create policy job_fit_v3_tasks_owner_update on public.job_fit_v3_tasks
  for update to authenticated using (user_id=(select auth.uid()) and (select private.current_user_active_member()) and private.owns_job(job_id)
    and exists(select 1 from public.job_fit_v3_batches b where b.id=batch_id and b.user_id=(select auth.uid())))
  with check (user_id=(select auth.uid()) and (select private.current_user_active_member()) and private.owns_job(job_id)
    and exists(select 1 from public.job_fit_v3_batches b where b.id=batch_id and b.user_id=(select auth.uid())));
grant select,insert,update on public.job_fit_v3_batches,public.job_fit_v3_tasks to authenticated;

alter table public.job_analyses
  add column job_fit_v3_task_id uuid unique references public.job_fit_v3_tasks(id) on delete set null;

-- A V3 result must remain honest when a required dimension is unassessable.
-- Persist NULL rather than fabricating a numeric score for incomplete evidence.
alter table public.job_analyses
  alter column fit_score drop not null,
  alter column priority_score drop not null;

alter table public.job_requirements
  add column analysis_reference text,
  add column match_label text,
  add column evidence_quotes jsonb not null default '[]'::jsonb,
  add column match_explanation text,
  add constraint job_requirements_evidence_quotes_array check (jsonb_typeof(evidence_quotes)='array');
create unique index job_requirements_analysis_reference_unique
  on public.job_requirements(analysis_id,analysis_reference)
  where analysis_id is not null and analysis_reference is not null;

create or replace function public.create_job_fit_v3_batch(
  p_request_id uuid,p_mode text,p_job_ids uuid[],p_tasks jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_profile public.candidate_profiles;
  v_batch public.job_fit_v3_batches;
  v_ids uuid[];
  v_spec record;
  v_existing_count integer;
begin
  if v_user is null or not (select private.current_user_active_member()) then raise exception 'Active membership required'; end if;
  if p_request_id is null or p_mode is null or p_mode not in ('pending','selected','outdated','retry') then raise exception 'Invalid job fit batch request'; end if;
  if jsonb_typeof(p_tasks) is distinct from 'array' or jsonb_array_length(p_tasks)<1 or jsonb_array_length(p_tasks)>100 then
    raise exception 'Select between 1 and 100 jobs to analyse';
  end if;
  select * into v_profile from public.candidate_profiles where user_id=v_user;
  if not found then raise exception 'Complete your profile before analysing jobs'; end if;
  select array_agg((x.value->>'job_id')::uuid order by x.ordinality) into v_ids
    from jsonb_array_elements(p_tasks) with ordinality as x(value,ordinality);
  if coalesce(cardinality(v_ids),0)<>jsonb_array_length(p_tasks)
     or (select count(distinct x) from unnest(v_ids) x)<>cardinality(v_ids)
     or p_job_ids is distinct from v_ids then raise exception 'Job fit batch contains missing, duplicate or mismatched jobs'; end if;

  select * into v_batch from public.job_fit_v3_batches where user_id=v_user and request_id=p_request_id;
  if found then
    if v_batch.mode is distinct from p_mode or v_batch.requested_job_ids is distinct from v_ids then
      raise exception 'Request id was already used for a different fit batch';
    end if;
    select count(*) into v_existing_count from public.job_fit_v3_tasks where batch_id=v_batch.id;
    if v_existing_count<>v_batch.requested_count then raise exception 'The saved fit batch is incomplete; retry with its original request id'; end if;
    return jsonb_build_object('batch_id',v_batch.id,'state',v_batch.state,'requested_count',v_batch.requested_count,'idempotent',true);
  end if;

  for v_spec in
    select * from jsonb_to_recordset(p_tasks) as x(
      job_id uuid,assessment_request_id text,semantic_key text,input_hash text,job_revision bigint,
      profile_revision bigint,assessment_as_of timestamptz,testing_mode boolean,input_payload jsonb,steps jsonb
    )
  loop
    if v_spec.job_id is null or v_spec.assessment_request_id is null or v_spec.semantic_key is null or v_spec.semantic_key !~ '^[0-9a-f]{64}$'
       or v_spec.input_hash is null or v_spec.input_hash !~ '^[0-9a-f]{64}$' or v_spec.job_revision is null
       or v_spec.profile_revision is distinct from v_profile.analysis_revision
       or v_spec.assessment_as_of is null or jsonb_typeof(v_spec.input_payload)<>'object'
       or jsonb_typeof(v_spec.steps)<>'array' or jsonb_array_length(v_spec.steps)<1 then
      raise exception 'A frozen fit input is incomplete or no longer current';
    end if;
    if not exists(select 1 from public.jobs j where j.id=v_spec.job_id and j.user_id=v_user
      and j.analysis_revision=v_spec.job_revision and j.current_snapshot_id=(v_spec.input_payload->'fit_input'->>'job_snapshot_id')::uuid)
      or v_spec.profile_revision is distinct from (v_spec.input_payload->'fit_input'->>'profile_revision')::bigint
      or v_spec.job_revision is distinct from (v_spec.input_payload->'fit_input'->>'job_revision')::bigint
      or v_spec.job_id::text is distinct from v_spec.input_payload->'fit_input'->>'job_id'
      or v_spec.assessment_request_id is distinct from v_spec.input_payload->'fit_input'->>'assessment_request_id' then
      raise exception 'A job or profile changed while the fit batch was being prepared';
    end if;
    if exists(select 1 from public.job_fit_v3_tasks t where t.user_id=v_user and t.job_id=v_spec.job_id
      and t.state in ('queued','waiting_for_bridge','saving')) then raise exception 'One or more selected jobs already have an active fit assessment'; end if;
  end loop;

  insert into public.job_fit_v3_batches(user_id,request_id,mode,requested_job_ids,requested_count)
  values(v_user,p_request_id,p_mode,v_ids,cardinality(v_ids)) returning * into v_batch;
  insert into public.job_fit_v3_tasks(
    user_id,batch_id,job_id,assessment_request_id,semantic_key,input_hash,job_revision,profile_revision,
    assessment_as_of,testing_mode,input_payload,steps
  )
  select v_user,v_batch.id,x.job_id,x.assessment_request_id,x.semantic_key,x.input_hash,x.job_revision,x.profile_revision,
    x.assessment_as_of,coalesce(x.testing_mode,false),x.input_payload,x.steps
  from jsonb_to_recordset(p_tasks) as x(
    job_id uuid,assessment_request_id text,semantic_key text,input_hash text,job_revision bigint,
    profile_revision bigint,assessment_as_of timestamptz,testing_mode boolean,input_payload jsonb,steps jsonb
  );
  return jsonb_build_object('batch_id',v_batch.id,'state','queued','requested_count',cardinality(v_ids),'idempotent',false);
end;
$$;
revoke all on function public.create_job_fit_v3_batch(uuid,text,uuid[],jsonb) from public,anon,service_role;
grant execute on function public.create_job_fit_v3_batch(uuid,text,uuid[],jsonb) to authenticated;

create or replace function public.save_job_fit_v3_result(p_task_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_task public.job_fit_v3_tasks;
  v_job public.jobs;
  v_profile public.candidate_profiles;
  v_analysis_id uuid;
  v_requirement jsonb;
  v_result jsonb;
begin
  if v_user is null or not (select private.current_user_active_member()) then raise exception 'Active membership required'; end if;
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=v_user for update;
  if not found then raise exception 'Fit task not found'; end if;
  if v_task.state='completed' and v_task.analysis_id is not null then
    return jsonb_build_object('analysis_id',v_task.analysis_id,'state','completed','idempotent',true);
  end if;
  if v_task.state is distinct from 'saving' or jsonb_typeof(v_task.result_json)<>'object' then raise exception 'No captured fit result is ready to save'; end if;
  select * into v_job from public.jobs where id=v_task.job_id and user_id=v_user for update;
  if not found then v_job.id := null; end if;
  select * into v_profile from public.candidate_profiles where user_id=v_user for update;
  if v_job.id is null or v_profile.id is null or v_job.analysis_revision is distinct from v_task.job_revision
    or v_profile.analysis_revision is distinct from v_task.profile_revision then
    update public.job_fit_v3_tasks set state='needs_user',error_message='Your profile or this listing changed during assessment. Refresh the fit assessment to use the latest information.',finished_at=now(),updated_at=now()
      where id=v_task.id;
    return jsonb_build_object('state','needs_user','error','The job or verified profile changed while ChatGPT was responding.');
  end if;
  v_result := v_task.result_json;
  if jsonb_typeof(v_result->'analysis') is distinct from 'object'
     or not (v_result->'analysis' ? 'fit_score')
     or ((v_result->'analysis'->>'fit_score') is not null and (v_result->'analysis'->>'fit_score')::numeric not between 0 and 100)
     or not (v_result->'analysis' ? 'priority_score')
     or ((v_result->'analysis'->>'priority_score') is not null and (v_result->'analysis'->>'priority_score')::numeric not between 0 and 100)
     or jsonb_typeof(v_result->'requirements') is distinct from 'array' then raise exception 'The captured fit result is incomplete'; end if;

  insert into public.job_analyses(
    job_id,contract_version,eligibility,eligibility_notes,fit_score,priority_score,fit_components,priority_components,
    recommended_cv_family,strengths,weaknesses,application_strategy,cover_letter_value,evidence_item_ids,
    analysis_source,triage,triage_reason,engine_version,job_revision,profile_revision,input_hash,assessment_as_of,job_fit_v3_task_id
  ) values (
    v_task.job_id,'3.0.0',(v_result->'analysis'->>'eligibility')::public.eligibility_state,
    array(select jsonb_array_elements_text(v_result->'analysis'->'eligibility_notes')),
    (v_result->'analysis'->>'fit_score')::numeric,(v_result->'analysis'->>'priority_score')::numeric,
    v_result->'analysis'->'fit_components',v_result->'analysis'->'priority_components',
    (v_result->'analysis'->>'recommended_cv_family')::public.cv_family,
    coalesce(v_result->'analysis'->'strengths','[]'::jsonb),coalesce(v_result->'analysis'->'weaknesses','[]'::jsonb),
    coalesce(v_result->'analysis'->>'application_strategy',''),(v_result->'analysis'->>'cover_letter_value'),
    array(select value::uuid from jsonb_array_elements_text(coalesce(v_result->'analysis'->'evidence_item_ids','[]'::jsonb)) value),
    'chatgpt_grounded_v3',(v_result->'analysis'->>'triage')::public.job_triage,
    coalesce(v_result->'analysis'->>'triage_reason',''), 'job-fit-v3',v_task.job_revision,v_task.profile_revision,
    v_task.input_hash,v_task.assessment_as_of,v_task.id
  ) returning id into v_analysis_id;

  for v_requirement in select value from jsonb_array_elements(v_result->'requirements') value loop
    insert into public.job_requirements(
      job_id,analysis_id,requirement_text,requirement_type,category,evidence_item_ids,match_score,
      analysis_reference,match_label,evidence_quotes,match_explanation
    ) values (
      v_task.job_id,v_analysis_id,v_requirement->>'requirement_text',(v_requirement->>'requirement_type'),
      v_requirement->>'category',
      array(select value::uuid from jsonb_array_elements_text(coalesce(v_requirement->'evidence_item_ids','[]'::jsonb)) value),
      nullif(v_requirement->>'match_score','')::smallint,v_requirement->>'analysis_reference',v_requirement->>'match_label',
      coalesce(v_requirement->'evidence_quotes','[]'::jsonb),coalesce(v_requirement->>'match_explanation','')
    ) on conflict (analysis_id,analysis_reference) where analysis_id is not null and analysis_reference is not null do nothing;
  end loop;

  update public.job_fit_v3_tasks set state='completed',analysis_id=v_analysis_id,active_dispatch_id=null,error_message=null,finished_at=now(),updated_at=now()
    where id=v_task.id;
  update public.job_fit_v3_batches b set state=case
      when exists(select 1 from public.job_fit_v3_tasks t where t.batch_id=b.id and t.state in ('queued','waiting_for_bridge','saving')) then 'processing'
      when exists(select 1 from public.job_fit_v3_tasks t where t.batch_id=b.id and t.state in ('failed','needs_user')) then 'partial'
      else 'completed' end,updated_at=now()
    where b.id=v_task.batch_id;
  return jsonb_build_object('analysis_id',v_analysis_id,'state','completed','idempotent',false);
end;
$$;
revoke all on function public.save_job_fit_v3_result(uuid) from public,anon,service_role;
grant execute on function public.save_job_fit_v3_result(uuid) to authenticated;

-- Application creation now requires the exact current v3 analysis. The original
-- SECURITY INVOKER behavior, explicit user choice and narrow grant are retained.
create or replace function public.create_application_from_job(p_job_id uuid,p_origin text default 'manual')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_job public.jobs;
  v_analysis public.job_analyses;
  v_app public.applications;
  v_profile_revision bigint;
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
   order by case when engine_version='job-fit-v3' then 0 else 1 end,created_at desc,id desc limit 1;
  if not found then raise exception 'Job has no completed fit analysis'; end if;
  select p.analysis_revision into v_profile_revision from public.candidate_profiles p where p.user_id=v_user;
  if v_analysis.engine_version is distinct from 'job-fit-v3' or v_analysis.job_revision is distinct from v_job.analysis_revision
     or v_analysis.profile_revision is distinct from v_profile_revision or coalesce(v_analysis.input_hash,'') !~ '^[0-9a-f]{64}$'
     or v_analysis.job_fit_v3_task_id is null then
    raise exception 'Job fit analysis is outdated; refresh the analysis against your current profile before creating an application';
  end if;
  if v_analysis.eligibility='ineligible' then raise exception 'Ineligible job cannot create an application'; end if;
  if p_origin='auto_prepare' and (v_analysis.triage <> 'auto_prepare' or v_analysis.eligibility <> 'eligible') then raise exception 'Job is not eligible for automatic preparation'; end if;
  if v_analysis.recommended_cv_family is null then raise exception 'Job analysis has no CV family'; end if;
  insert into public.applications(user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,preparation_origin,preparation_metadata,next_action,notes)
  values(v_user,p_job_id,'preparing',v_job.current_snapshot_id,v_analysis.id,v_analysis.recommended_cv_family,p_origin,
    jsonb_build_object('contract_version','3.0.0','analysis_source',v_analysis.analysis_source,'fit_score',v_analysis.fit_score,'priority_score',v_analysis.priority_score,'triage',v_analysis.triage),
    'Complete preparation tasks and review the finished application package.',case when p_origin='auto_prepare' then 'Application created automatically from a high-confidence job match.' else null end)
  returning * into v_app;
  insert into public.application_strategies(application_id,job_analysis_id,strategy_text,evidence_item_ids)
  values(v_app.id,v_analysis.id,coalesce(v_analysis.application_strategy,''),v_analysis.evidence_item_ids);
  v_cover_letter_pending := v_analysis.cover_letter_value in ('high','medium');
  v_salary_known := v_job.salary_text is not null or v_job.salary_min is not null or v_job.salary_max is not null;
  insert into public.automation_tasks(user_id,task_type,state,idempotency_key,entity_type,entity_id,input_json,output_json)
  values
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
