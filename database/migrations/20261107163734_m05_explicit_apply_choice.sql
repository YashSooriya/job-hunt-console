-- M05: make the user's explicit Choose to apply action the only path that
-- creates/adopts an application, while retaining legacy application history.

alter table public.applications
  add column if not exists chosen_to_apply_at timestamptz;

comment on column public.applications.chosen_to_apply_at is
  'Timestamp when the user explicitly chose to apply. Existing manual-origin rows are backfilled; legacy automatic and imported rows require a new explicit choice.';

-- Historical manual creation was already an explicit user action. Preserve
-- its origin and all records while distinguishing legacy automatic/imported
-- rows that still require a current choice.
update public.applications
   set chosen_to_apply_at=created_at
 where preparation_origin='manual' and chosen_to_apply_at is null;

-- Keep task rows and their attempt history, but stop any queued legacy work
-- from being consumed without an explicit choice.
update public.automation_tasks t
   set state='needs_user',
       output_json=coalesce(t.output_json,'{}'::jsonb)||jsonb_build_object(
         'm05_gate','explicit_application_choice_required'),
       updated_at=now()
  from public.applications a
 where t.entity_type='application' and t.entity_id=a.id
   and a.chosen_to_apply_at is null
   and t.task_type in ('prepare_cv','prepare_cover_letter','prepare_screening_answers','research_salary','assemble_review_package')
   and t.state in ('pending','running','retrying');

-- A pending document request is a durable request to create documents. Keep
-- its rows for audit, but cancel work for records that never had apply consent.
update public.document_generation_items i
   set state='cancelled', error_code='explicit_choice_required',
       error_message='The application needs an explicit Choose to apply decision before document work can continue.',
       updated_at=now()
  from public.document_generation_requests r
  join public.applications a on a.id=r.application_id
 where i.request_id=r.id and i.user_id=r.user_id
   and a.chosen_to_apply_at is null
   and r.state in ('queued','preparing_context','writing','validating','rendering','saving_drive');

update public.document_generation_requests r
   set state='cancelled', error_code='explicit_choice_required',
       error_message='The application needs an explicit Choose to apply decision before document work can continue.',
       updated_at=now()
  from public.applications a
 where a.id=r.application_id and a.chosen_to_apply_at is null
   and r.state in ('queued','preparing_context','writing','validating','rendering','saving_drive');

-- Preserve active employer-session history while stopping sessions attached
-- to legacy records that have no explicit application choice.
update public.form_agent_sessions s
   set status='cancelled', completed_at=coalesce(s.completed_at,now()), updated_at=now()
  from public.applications a
 where a.id=s.application_id and a.user_id=s.user_id
   and a.chosen_to_apply_at is null
   and s.status in ('active','needs_user','final_review');

-- M22 requests are historical records, not authorization. Park any queued
-- request that has no chosen application; later calls return user_required.
update public.application_preparation_requests r
   set state='user_required',
       decision_json=coalesce(r.decision_json,'{}'::jsonb)||jsonb_build_object(
         'm05_reason','explicit_application_choice_required'),
       updated_at=now()
 where r.state in ('awaiting_content','ready_for_gate1')
   and not exists (
     select 1 from public.applications a
      where a.id=r.application_id and a.user_id=r.user_id
        and a.chosen_to_apply_at is not null
   );

-- A legacy M22 ChatGPT task may report a user-required state, but it can no
-- longer create an application, preparation tasks, or a package.
create or replace function private.prepare_application_for_user(
  p_user uuid,
  p_job_id uuid,
  p_source text default 'chatgpt_task',
  p_package jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.jobs;
  v_analysis public.job_analyses;
  v_app public.applications;
  v_request public.application_preparation_requests;
  v_request_key text;
  v_decision jsonb := jsonb_build_object(
    'reason','explicit_application_choice_required',
    'message','Use Choose to apply in the Job Pool before requesting any preparation.'
  );
begin
  perform private.assert_active_app_membership(p_user);
  if coalesce(p_source,'') not in ('chatgpt_task','manual','system') then raise exception 'Invalid preparation source'; end if;

  select * into v_job from public.jobs where id=p_job_id and user_id=p_user;
  if not found then raise exception 'Job not found'; end if;
  select * into v_analysis from public.job_analyses where job_id=p_job_id
   order by case when engine_version='job-fit-memory-v4' then 0 else 1 end,created_at desc,id desc limit 1;
  if not found then raise exception 'Job has no completed analysis'; end if;
  select * into v_app from public.applications where user_id=p_user and job_id=p_job_id;

  v_request_key:='m05-choice-required:'||p_source||':'||p_job_id::text||':'||v_analysis.id::text;
  insert into public.application_preparation_requests as current_request(
    user_id,job_id,application_id,analysis_id,source,state,idempotency_key,selected_cv_family,decision_json
  ) values (
    p_user,p_job_id,v_app.id,v_analysis.id,p_source,'user_required',v_request_key,
    v_analysis.recommended_cv_family,v_decision
  ) on conflict(user_id,idempotency_key) do update set
    state='user_required',
    application_id=coalesce(current_request.application_id,excluded.application_id),
    decision_json=current_request.decision_json||excluded.decision_json,
    updated_at=now()
  returning * into v_request;

  return jsonb_build_object(
    'prepared',false,'state','user_required','reason','explicit_application_choice_required',
    'preparation_request_id',v_request.id,'application_id',null,'submission_allowed',false
  );
end;
$$;
revoke all on function private.prepare_application_for_user(uuid,uuid,text,jsonb) from public,anon,authenticated;

-- Serialize by the owned job row so repeated and concurrent apply attempts
-- either create one application or adopt exactly the same legacy row.
create or replace function public.create_application_from_job(p_job_id uuid,p_origin text default 'manual')
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_job public.jobs;
  v_analysis public.job_analyses;
  v_app public.applications;
  v_cover_letter_pending boolean;
  v_salary_known boolean;
  v_now timestamptz := now();
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_origin is distinct from 'manual' then raise exception 'An explicit Choose to apply action is required'; end if;

  select * into v_job from public.jobs where id=p_job_id and user_id=v_user for update;
  if not found then raise exception 'Job not found'; end if;
  if v_job.archived_at is not null then raise exception 'Restore this vacancy before choosing to apply'; end if;

  select * into v_app from public.applications where user_id=v_user and job_id=p_job_id for update;
  if found then
    if v_app.chosen_to_apply_at is null then
      update public.applications
         set chosen_to_apply_at=v_now,updated_at=v_now
       where id=v_app.id and user_id=v_user
       returning * into v_app;
      insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
      values(v_user,'user',v_user::text,'application.user_chose_to_apply','application',v_app.id,
        jsonb_build_object('job_id',p_job_id,'source','job_pool','legacy_application_adopted',true,
          'preserved_origin',v_app.preparation_origin,'chosen_to_apply_at',v_app.chosen_to_apply_at));
    end if;
    return jsonb_build_object('application_id',v_app.id,'created',false,'state',v_app.state,
      'origin',v_app.preparation_origin,'chosen_to_apply_at',v_app.chosen_to_apply_at,
      'selected_cv_family',v_app.selected_cv_family,'job_snapshot_id',v_app.job_snapshot_id,
      'job_analysis_id',v_app.job_analysis_id);
  end if;

  if v_job.current_snapshot_id is null then raise exception 'Job has no frozen vacancy snapshot'; end if;
  select * into v_analysis from public.job_analyses where job_id=p_job_id
    order by case when engine_version='job-fit-memory-v4' then 0 else 1 end,created_at desc,id desc limit 1;
  if not found then raise exception 'Job has no completed fit analysis'; end if;
  if v_analysis.engine_version='job-fit-memory-v4' then
    if v_analysis.job_revision is distinct from v_job.analysis_revision or v_analysis.profile_revision is not null
      or coalesce(v_analysis.input_hash,'') !~ '^[0-9a-f]{64}$' or v_analysis.assessment_as_of is null
      or v_analysis.job_fit_memory_v4_item_id is null then
      raise exception 'Memory-based fit analysis is outdated; refresh it against the current listing before creating an application';
    end if;
  else
    raise exception 'This legacy analysis cannot create a new application; run Memory-based analysis first';
  end if;
  if v_analysis.eligibility='ineligible' then raise exception 'Ineligible job cannot create an application'; end if;
  if v_analysis.recommended_cv_family is null then raise exception 'Job analysis has no CV family'; end if;

  insert into public.applications(
    user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,preparation_origin,
    preparation_metadata,next_action,notes,chosen_to_apply_at
  ) values (
    v_user,p_job_id,'preparing',v_job.current_snapshot_id,v_analysis.id,v_analysis.recommended_cv_family,'manual',
    jsonb_build_object('contract_version',v_analysis.contract_version,'analysis_source',v_analysis.analysis_source,
      'fit_score',v_analysis.fit_score,'priority_score',v_analysis.priority_score,'triage',v_analysis.triage),
    'Review this application choice. Request any documents separately when ready.',null,v_now
  ) returning * into v_app;

  insert into public.application_strategies(application_id,job_analysis_id,strategy_text,evidence_item_ids)
  values(v_app.id,v_analysis.id,coalesce(v_analysis.application_strategy,''),v_analysis.evidence_item_ids);

  v_cover_letter_pending:=v_analysis.cover_letter_value in ('high','medium');
  v_salary_known:=v_job.salary_text is not null or v_job.salary_min is not null or v_job.salary_max is not null;
  insert into public.automation_tasks(user_id,task_type,state,idempotency_key,entity_type,entity_id,input_json,output_json) values
    (v_user,'freeze_job_context','completed','application:'||v_app.id||':freeze_job_context:v1','application',v_app.id,
      jsonb_build_object('job_id',v_job.id,'job_snapshot_id',v_job.current_snapshot_id,'job_analysis_id',v_analysis.id),jsonb_build_object('frozen',true)),
    (v_user,'lock_application_strategy','completed','application:'||v_app.id||':lock_application_strategy:v1','application',v_app.id,
      jsonb_build_object('job_analysis_id',v_analysis.id,'evidence_item_ids',v_analysis.evidence_item_ids),jsonb_build_object('locked',true)),
    (v_user,'select_cv_family','completed','application:'||v_app.id||':select_cv_family:v1','application',v_app.id,
      jsonb_build_object('cv_family',v_analysis.recommended_cv_family),jsonb_build_object('cv_family',v_analysis.recommended_cv_family)),
    (v_user,'prepare_cv','needs_user','application:'||v_app.id||':prepare_cv:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','cv_family',v_analysis.recommended_cv_family,
        'evidence_item_ids',v_analysis.evidence_item_ids,'unsupported_claims_target',0),
      jsonb_build_object('m05_gate','separate_explicit_document_request_required')),
    (v_user,'prepare_cover_letter',case when v_cover_letter_pending then 'needs_user'::public.task_state else 'completed'::public.task_state end,
      'application:'||v_app.id||':prepare_cover_letter:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','value',coalesce(v_analysis.cover_letter_value,'low'),
        'conditional',v_analysis.cover_letter_value='medium','evidence_item_ids',v_analysis.evidence_item_ids),
      case when v_cover_letter_pending then jsonb_build_object('m05_gate','separate_explicit_document_request_required')
        else jsonb_build_object('skipped',true,'reason',case when v_analysis.cover_letter_value='not_accepted'
          then 'Employer does not accept a cover letter.' else 'Low expected value.' end) end),
    (v_user,'prepare_screening_answers','needs_user','application:'||v_app.id||':prepare_screening_answers:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','trust_policy','verified_proposed_user_required'),
      jsonb_build_object('m05_gate','separate_explicit_preparation_request_required')),
    (v_user,'research_salary',case when v_salary_known then 'completed'::public.task_state else 'needs_user'::public.task_state end,
      'application:'||v_app.id||':research_salary:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','advertised_salary',v_job.salary_text,
        'salary_min',v_job.salary_min,'salary_max',v_job.salary_max,'salary_currency',coalesce(v_job.salary_currency,'GBP'),
        'required_output','clearly_labelled_estimate'),
      case when v_salary_known then jsonb_build_object('advertised',true)
        else jsonb_build_object('m05_gate','separate_explicit_preparation_request_required') end),
    (v_user,'assemble_review_package','needs_user','application:'||v_app.id||':assemble_review_package:v1','application',v_app.id,
      jsonb_build_object('waits_for',jsonb_build_array('prepare_cv','prepare_cover_letter','prepare_screening_answers','research_salary')),
      jsonb_build_object('m05_gate','separate_explicit_preparation_request_required'));

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'application.created','application',v_app.id,
    jsonb_build_object('job_id',p_job_id,'origin','manual','job_analysis_id',v_analysis.id,'cv_family',v_analysis.recommended_cv_family)),
    (v_user,'user',v_user::text,'application.user_chose_to_apply','application',v_app.id,
    jsonb_build_object('job_id',p_job_id,'source','job_pool','legacy_application_adopted',false,'chosen_to_apply_at',v_now));

  return jsonb_build_object('application_id',v_app.id,'created',true,'state',v_app.state,'origin',v_app.preparation_origin,
    'chosen_to_apply_at',v_app.chosen_to_apply_at,'selected_cv_family',v_app.selected_cv_family,
    'job_snapshot_id',v_app.job_snapshot_id,'job_analysis_id',v_app.job_analysis_id);
end;
$$;
revoke all on function public.create_application_from_job(uuid,text) from public,anon,service_role;
grant execute on function public.create_application_from_job(uuid,text) to authenticated;

-- Custom-document creation remains a distinct user request. This RPC checks
-- the durable choice marker so adopting a legacy row works without rewriting
-- its historical preparation_origin.
create or replace function public.create_application_document_generation(
  p_application_id uuid,p_request_key uuid,p_requested_kinds text[],p_template_id text,
  p_input_snapshot jsonb,p_input_hash text,p_context_chunks jsonb,p_testing_mode boolean default false
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_application public.applications;
  v_request public.document_generation_requests;
  v_active_request public.document_generation_requests;
  v_kind text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_request_key is null or p_application_id is null then raise exception 'A valid application and request key are required'; end if;
  if p_template_id not in ('classic-navy','clean-charcoal','technical-slate','research-classic','modern-teal','engineering-blue','quiet-olive','minimal-black') then raise exception 'Choose a valid document theme'; end if;
  if p_requested_kinds is null or cardinality(p_requested_kinds) not between 1 and 2
    or exists(select 1 from unnest(p_requested_kinds) k where k not in ('cv','cover_letter'))
    or (select count(distinct k) from unnest(p_requested_kinds) k)<>cardinality(p_requested_kinds) then
    raise exception 'Choose a CV, cover letter, or both';
  end if;
  if coalesce(p_input_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input_snapshot)<>'object'
    or jsonb_typeof(p_context_chunks)<>'array' or jsonb_array_length(p_context_chunks)=0
    or octet_length(p_input_snapshot::text)>1000000 or octet_length(p_context_chunks::text)>1000000 then
    raise exception 'Document generation context is incomplete or too large';
  end if;
  if exists(select 1 from jsonb_array_elements(p_context_chunks) x
    where coalesce(x->>'kind','') not in ('cv','cover_letter')
      or coalesce(x->>'phase','') not in ('context','final')
      or coalesce(x->>'text','')=''
      or length(x->>'text')>5600
      or coalesce(x->>'sha256','') !~ '^[0-9a-f]{64}$') then
    raise exception 'Document context contains an invalid or oversized Website Bridge step';
  end if;
  select * into v_application from public.applications a
    where a.id=p_application_id and a.user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_application.chosen_to_apply_at is null then raise exception 'Choose to apply to this job before requesting custom documents'; end if;
  if v_application.state not in ('preparing','ready_for_review','revision_requested') then raise exception 'Documents cannot be generated after application review has been locked'; end if;

  select * into v_request from public.document_generation_requests r where r.user_id=v_user and r.request_key=p_request_key;
  if found then
    if v_request.application_id is distinct from p_application_id
      or v_request.requested_kinds is distinct from p_requested_kinds
      or v_request.template_id is distinct from p_template_id
      or v_request.input_hash is distinct from p_input_hash then
      raise exception 'Request id was already used for different document inputs';
    end if;
    return jsonb_build_object('request_id',v_request.id,'state',v_request.state,'idempotent',true);
  end if;

  select * into v_active_request from public.document_generation_requests r
    where r.user_id=v_user and r.application_id=p_application_id
      and r.state in ('queued','preparing_context','writing','validating','rendering','saving_drive')
    order by r.created_at desc limit 1;
  if found then raise exception 'A document request is already in progress for this application. Resume it before starting another.'; end if;

  insert into public.document_generation_requests(
    user_id,application_id,request_key,requested_kinds,template_id,input_snapshot,input_hash,context_chunks,testing_mode,
    state,current_kind
  ) values (
    v_user,p_application_id,p_request_key,p_requested_kinds,p_template_id,p_input_snapshot,p_input_hash,p_context_chunks,coalesce(p_testing_mode,false),
    'preparing_context',p_context_chunks->0->>'kind'
  ) returning * into v_request;
  foreach v_kind in array p_requested_kinds loop
    insert into public.document_generation_items(user_id,request_id,application_id,document_kind)
    values(v_user,v_request.id,p_application_id,v_kind);
  end loop;
  return jsonb_build_object('request_id',v_request.id,'state',v_request.state,'idempotent',false);
end;
$$;
revoke all on function public.create_application_document_generation(uuid,uuid,text[],text,jsonb,text,jsonb,boolean) from public,anon,service_role;
grant execute on function public.create_application_document_generation(uuid,uuid,text[],text,jsonb,text,jsonb,boolean) to authenticated;

-- Keep the established Gate 1 and paired-device boundaries, adding the
-- explicit application-choice prerequisite before any employer-form session.
create or replace function private.start_form_agent_session_for_user(p_user uuid,p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_app public.applications; v_package public.application_review_packages; v_token text; v_session public.form_agent_sessions;
begin
  perform private.assert_active_app_membership(p_user);
  select * into v_app from public.applications where id=p_application_id and user_id=p_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.chosen_to_apply_at is null then raise exception 'Choose to apply before starting employer form work'; end if;
  if v_app.state not in ('content_approved','form_in_progress','form_needs_user','final_review') then raise exception 'Application must have passed Gate 1 before form completion'; end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id and approved_at is not null;
  if not found then raise exception 'Approved Gate 1 package not found'; end if;
  update public.form_agent_sessions set status='cancelled',updated_at=now(),completed_at=now()
   where user_id=p_user and application_id=p_application_id and status in ('active','needs_user','final_review');
  v_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.form_agent_sessions(user_id,application_id,status,token_hash,expires_at)
  values(p_user,p_application_id,'active',encode(extensions.digest(v_token,'sha256'),'hex'),now()+interval '8 hours') returning * into v_session;
  update public.applications set state='form_in_progress',next_action='Complete and review the employer form.',updated_at=now() where id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'form_agent.session_started','application',p_application_id,
    jsonb_build_object('session_id',v_session.id,'expires_at',v_session.expires_at));
  return jsonb_build_object('session_id',v_session.id,'token',v_token,'expires_at',v_session.expires_at,'status',v_session.status);
end $$;
revoke all on function private.start_form_agent_session_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.start_form_agent_session_for_user(uuid,uuid) to authenticated;

-- Defense in depth for direct RPCs that persist generated content or versions.
-- The app creation choice itself writes none of these rows.
create or replace function private.require_explicit_application_choice_for_content()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_application_id uuid;
  v_chosen_at timestamptz;
begin
  if tg_table_name='document_versions' then
    select d.application_id into v_application_id from public.documents d where d.id=new.document_id;
  else
    v_application_id:=new.application_id;
  end if;
  if v_application_id is null then return new; end if;
  select a.chosen_to_apply_at into v_chosen_at from public.applications a where a.id=v_application_id;
  if not found then raise exception 'Application not found'; end if;
  if v_chosen_at is null then raise exception 'Choose to apply before preparing application content'; end if;
  return new;
end;
$$;
revoke all on function private.require_explicit_application_choice_for_content() from public,anon,authenticated,service_role;

drop trigger if exists documents_require_application_choice on public.documents;
create trigger documents_require_application_choice before insert or update on public.documents
for each row execute function private.require_explicit_application_choice_for_content();
drop trigger if exists document_versions_require_application_choice on public.document_versions;
create trigger document_versions_require_application_choice before insert or update on public.document_versions
for each row execute function private.require_explicit_application_choice_for_content();
drop trigger if exists application_answers_require_application_choice on public.application_answers;
create trigger application_answers_require_application_choice before insert or update on public.application_answers
for each row execute function private.require_explicit_application_choice_for_content();
drop trigger if exists application_salary_contexts_require_application_choice on public.application_salary_contexts;
create trigger application_salary_contexts_require_application_choice before insert or update on public.application_salary_contexts
for each row execute function private.require_explicit_application_choice_for_content();

-- Prevent a stale or manually re-queued task from becoming runnable while the
-- application is still unchosen. Keep the row and attempt history intact.
create or replace function private.require_choice_before_application_task()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_chosen_at timestamptz;
begin
  if new.entity_type<>'application'
    or new.task_type not in ('prepare_cv','prepare_cover_letter','prepare_screening_answers','research_salary','assemble_review_package')
    or new.state not in ('pending','running','retrying') then return new; end if;
  select a.chosen_to_apply_at into v_chosen_at from public.applications a where a.id=new.entity_id;
  if found and v_chosen_at is null then
    new.state:='needs_user';
    new.output_json:=coalesce(new.output_json,'{}'::jsonb)||jsonb_build_object('m05_gate','explicit_application_choice_required');
    new.updated_at:=now();
  end if;
  return new;
end;
$$;
revoke all on function private.require_choice_before_application_task() from public,anon,authenticated,service_role;
drop trigger if exists application_tasks_require_application_choice on public.automation_tasks;
create trigger application_tasks_require_application_choice before insert or update of state,entity_type,entity_id,task_type on public.automation_tasks
for each row execute function private.require_choice_before_application_task();

-- The document-response consumer must honor the separate durable choice
-- marker too, while retaining all existing quality, evidence, and Gate 1 rules.
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
  if v_app.chosen_to_apply_at is null or v_app.state not in ('preparing','ready_for_review','revision_requested') then
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
