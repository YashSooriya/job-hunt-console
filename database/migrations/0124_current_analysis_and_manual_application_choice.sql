-- Keep low fit as advice rather than a block on the user's explicit choice.
-- Application context must still be based on a current, provenance-bound fit result.

create or replace function public.create_application_from_job(
  p_job_id uuid,
  p_origin text default 'manual'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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

  -- Repeated create calls remain a strict no-op and retain the original frozen
  -- snapshot and analysis, even if the latest profile later changes.
  select * into v_app from public.applications where user_id=v_user and job_id=p_job_id;
  if found then
    return jsonb_build_object('application_id',v_app.id,'created',false,'state',v_app.state,
      'origin',v_app.preparation_origin,'selected_cv_family',v_app.selected_cv_family,
      'job_snapshot_id',v_app.job_snapshot_id,'job_analysis_id',v_app.job_analysis_id);
  end if;

  if v_job.current_snapshot_id is null then raise exception 'Job has no frozen vacancy snapshot'; end if;
  select * into v_analysis from public.job_analyses
   where job_id=p_job_id order by created_at desc,id desc limit 1;
  if not found then raise exception 'Job has no completed fit analysis'; end if;
  select p.analysis_revision into v_profile_revision from public.candidate_profiles p where p.user_id=v_user;
  if v_analysis.engine_version is distinct from 'job-fit-v2'
     or v_analysis.job_revision is distinct from v_job.analysis_revision
     or v_analysis.profile_revision is distinct from v_profile_revision
     or coalesce(v_analysis.input_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Job fit analysis is outdated; refresh the analysis against your current profile before creating an application';
  end if;
  if v_analysis.eligibility='ineligible' then raise exception 'Ineligible job cannot create an application'; end if;
  -- A low fit score is advice, not a restriction on the user's manual decision.
  if p_origin='auto_prepare' and (v_analysis.triage <> 'auto_prepare' or v_analysis.eligibility <> 'eligible') then
    raise exception 'Job is not eligible for automatic preparation';
  end if;
  if v_analysis.recommended_cv_family is null then raise exception 'Job analysis has no CV family'; end if;

  insert into public.applications(
    user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,preparation_origin,
    preparation_metadata,next_action,notes
  ) values (
    v_user,p_job_id,'preparing',v_job.current_snapshot_id,v_analysis.id,v_analysis.recommended_cv_family,p_origin,
    jsonb_build_object('contract_version','1.0.0','analysis_source',v_analysis.analysis_source,
      'fit_score',v_analysis.fit_score,'priority_score',v_analysis.priority_score,'triage',v_analysis.triage),
    'Complete preparation tasks and review the finished application package.',
    case when p_origin='auto_prepare' then 'Application created automatically from a high-confidence job match.' else null end
  ) returning * into v_app;

  insert into public.application_strategies(application_id,job_analysis_id,strategy_text,evidence_item_ids)
  values(v_app.id,v_analysis.id,coalesce(v_analysis.application_strategy,''),v_analysis.evidence_item_ids);
  v_cover_letter_pending := v_analysis.cover_letter_value in ('high','medium');
  v_salary_known := v_job.salary_text is not null or v_job.salary_min is not null or v_job.salary_max is not null;

  insert into public.automation_tasks(user_id,task_type,state,idempotency_key,entity_type,entity_id,input_json,output_json)
  values
    (v_user,'freeze_job_context','completed','application:'||v_app.id||':freeze_job_context:v1','application',v_app.id,
      jsonb_build_object('job_id',v_job.id,'job_snapshot_id',v_job.current_snapshot_id,'job_analysis_id',v_analysis.id),jsonb_build_object('frozen',true)),
    (v_user,'lock_application_strategy','completed','application:'||v_app.id||':lock_application_strategy:v1','application',v_app.id,
      jsonb_build_object('job_analysis_id',v_analysis.id,'evidence_item_ids',v_analysis.evidence_item_ids),jsonb_build_object('locked',true)),
    (v_user,'select_cv_family','completed','application:'||v_app.id||':select_cv_family:v1','application',v_app.id,
      jsonb_build_object('cv_family',v_analysis.recommended_cv_family),jsonb_build_object('cv_family',v_analysis.recommended_cv_family)),
    (v_user,'prepare_cv','pending','application:'||v_app.id||':prepare_cv:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','cv_family',v_analysis.recommended_cv_family,'evidence_item_ids',v_analysis.evidence_item_ids,'unsupported_claims_target',0),null),
    (v_user,'prepare_cover_letter',case when v_cover_letter_pending then 'pending'::public.task_state else 'completed'::public.task_state end,
      'application:'||v_app.id||':prepare_cover_letter:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','value',coalesce(v_analysis.cover_letter_value,'low'),'conditional',v_analysis.cover_letter_value='medium','evidence_item_ids',v_analysis.evidence_item_ids),
      case when v_cover_letter_pending then null else jsonb_build_object('skipped',true,'reason',case when v_analysis.cover_letter_value='not_accepted' then 'Employer does not accept a cover letter.' else 'Low expected value.' end) end),
    (v_user,'prepare_screening_answers','pending','application:'||v_app.id||':prepare_screening_answers:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','trust_policy','verified_proposed_user_required'),null),
    (v_user,'research_salary',case when v_salary_known then 'completed'::public.task_state else 'pending'::public.task_state end,
      'application:'||v_app.id||':research_salary:v1','application',v_app.id,
      jsonb_build_object('execution_mode','chatgpt_plus_handoff','advertised_salary',v_job.salary_text,'salary_min',v_job.salary_min,'salary_max',v_job.salary_max,'salary_currency',coalesce(v_job.salary_currency,'GBP'),'required_output','clearly_labelled_estimate'),
      case when v_salary_known then jsonb_build_object('advertised',true) else null end),
    (v_user,'assemble_review_package','pending','application:'||v_app.id||':assemble_review_package:v1','application',v_app.id,
      jsonb_build_object('waits_for',jsonb_build_array('prepare_cv','prepare_cover_letter','prepare_screening_answers','research_salary')),null);

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,case when p_origin='auto_prepare' then 'application.auto_prepared' else 'application.created' end,
    'application',v_app.id,jsonb_build_object('job_id',p_job_id,'origin',p_origin,'job_analysis_id',v_analysis.id,'cv_family',v_analysis.recommended_cv_family));
  return jsonb_build_object('application_id',v_app.id,'created',true,'state',v_app.state,'origin',v_app.preparation_origin,
    'selected_cv_family',v_app.selected_cv_family,'job_snapshot_id',v_app.job_snapshot_id,'job_analysis_id',v_app.job_analysis_id);
end;
$$;

revoke all on function public.create_application_from_job(uuid,text) from public,anon,service_role;
grant execute on function public.create_application_from_job(uuid,text) to authenticated;
