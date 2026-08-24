-- Milestone 22: automatic application preparation with a hard Gate 1 boundary.

create table if not exists public.application_preparation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  analysis_id uuid references public.job_analyses(id) on delete restrict,
  source text not null check (source in ('chatgpt_task','manual','system')),
  state text not null default 'awaiting_content' check (state in ('blocked','awaiting_content','ready_for_gate1','user_required','failed')),
  idempotency_key text not null,
  selected_cv_family public.cv_family,
  package_json jsonb not null default '{}'::jsonb,
  decision_json jsonb not null default '{}'::jsonb,
  error_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key)
);

create index if not exists application_preparation_requests_user_idx
  on public.application_preparation_requests(user_id, created_at desc);
create index if not exists application_preparation_requests_job_idx
  on public.application_preparation_requests(job_id, created_at desc);
create index if not exists application_preparation_requests_application_idx
  on public.application_preparation_requests(application_id);

alter table public.application_preparation_requests enable row level security;
revoke all on public.application_preparation_requests from public, anon;
grant select on public.application_preparation_requests to authenticated;
drop policy if exists application_preparation_requests_owner on public.application_preparation_requests;
create policy application_preparation_requests_owner on public.application_preparation_requests
  for select to authenticated using (user_id=(select auth.uid()));

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
  v_profile uuid;
  v_preferences jsonb := '{}'::jsonb;
  v_preference text := 'prepare_and_fill_after_gate1';
  v_threshold numeric := 80;
  v_job public.jobs;
  v_analysis public.job_analyses;
  v_app public.applications;
  v_request public.application_preparation_requests;
  v_request_key text;
  v_package jsonb := coalesce(p_package,'{}'::jsonb);
begin
  perform private.assert_active_app_membership(p_user);
  if p_source not in ('chatgpt_task','manual','system') then raise exception 'Invalid preparation source'; end if;
  if length(v_package::text)>200000 then raise exception 'Application preparation package is too large'; end if;

  select id into v_profile from public.candidate_profiles where user_id=p_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  select coalesce(cp.preferences,'{}'::jsonb) into v_preferences
    from public.candidate_preferences cp where cp.profile_id=v_profile;
  v_preference := coalesce(nullif(v_preferences->>'application_automation_preference',''),'prepare_and_fill_after_gate1');
  if coalesce(v_preferences->>'auto_prepare_threshold','') ~ '^[0-9]+(\\.[0-9]+)?$' then
    v_threshold := greatest(0,least(100,(v_preferences->>'auto_prepare_threshold')::numeric));
  end if;

  select * into v_job from public.jobs where id=p_job_id and user_id=p_user;
  if not found then raise exception 'Job not found'; end if;
  select * into v_analysis from public.job_analyses where job_id=p_job_id order by created_at desc limit 1;
  if not found then raise exception 'Job has no completed analysis'; end if;

  v_request_key := 'm22:'||p_source||':'||p_job_id::text||':'||v_analysis.id::text;
  if p_source='chatgpt_task' and v_preference='manual' then
    insert into public.application_preparation_requests(user_id,job_id,analysis_id,source,state,idempotency_key,selected_cv_family,package_json,decision_json)
    values(p_user,p_job_id,v_analysis.id,p_source,'blocked',v_request_key,v_analysis.recommended_cv_family,v_package,
      jsonb_build_object('reason','manual_preference','message','The member selected manual application handling.'))
    on conflict(user_id,idempotency_key) do update set updated_at=now(),decision_json=excluded.decision_json
    returning * into v_request;
    return jsonb_build_object('prepared',false,'state',v_request.state,'reason','manual_preference','preparation_request_id',v_request.id);
  end if;
  if v_job.current_snapshot_id is null then raise exception 'Job has no frozen vacancy snapshot'; end if;
  if v_analysis.eligibility <> 'eligible' or v_analysis.triage <> 'auto_prepare' then
    raise exception 'Job is not eligible for automatic preparation';
  end if;
  if v_analysis.fit_score < v_threshold or v_analysis.priority_score < v_threshold then
    raise exception 'Job is below the member auto-prepare threshold';
  end if;
  if v_analysis.recommended_cv_family is null then raise exception 'Job analysis has no recommended CV family'; end if;
  if exists (
    select 1
    from unnest(coalesce(v_analysis.evidence_item_ids,'{}'::uuid[])) as ids(id)
    left join public.evidence_items e on e.id=ids.id and e.profile_id=v_profile
    where e.id is null or e.verification_status <> 'verified'
  ) then
    raise exception 'Automatic preparation requires verified evidence only';
  end if;

  select * into v_app from public.applications where user_id=p_user and job_id=p_job_id for update;
  if found then
    if v_app.job_snapshot_id is not null and v_app.job_snapshot_id is distinct from v_job.current_snapshot_id then raise exception 'Application vacancy context is already frozen'; end if;
    if v_app.job_analysis_id is not null and v_app.job_analysis_id is distinct from v_analysis.id then raise exception 'Application analysis context is already frozen'; end if;
  else
    insert into public.applications(
      user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,preparation_origin,preparation_metadata,next_action,notes
    ) values (
      p_user,p_job_id,'preparing',v_job.current_snapshot_id,v_analysis.id,v_analysis.recommended_cv_family,'auto_prepare',
      jsonb_build_object('contract_version','m22.1','source',p_source,'fit_score',v_analysis.fit_score,'priority_score',v_analysis.priority_score,'auto_prepare_threshold',v_threshold,'package',v_package),
      'Complete and review the automatically prepared application package.',
      'Created by the bounded automatic-preparation path; Gate 1 remains mandatory.'
    ) returning * into v_app;
  end if;

  update public.applications set
    preparation_metadata=coalesce(preparation_metadata,'{}'::jsonb)||jsonb_build_object('m22_source',p_source,'package',v_package,'auto_prepare_threshold',v_threshold),
    next_action=case when v_app.state in ('discovered','triaged','shortlisted','preparing') then 'Complete and review the automatically prepared application package.' else next_action end,
    updated_at=now()
  where id=v_app.id and user_id=p_user and v_app.state in ('discovered','triaged','shortlisted','preparing');

  insert into public.application_strategies(application_id,job_analysis_id,strategy_text,evidence_item_ids)
  values(v_app.id,v_analysis.id,coalesce(nullif(v_package->>'strategy_text',''),v_analysis.application_strategy,''),v_analysis.evidence_item_ids)
  on conflict do nothing;

  insert into public.automation_tasks(user_id,task_type,state,idempotency_key,entity_type,entity_id,input_json,output_json)
  values
    (p_user,'freeze_job_context','completed','application:'||v_app.id||':freeze_job_context:v1','application',v_app.id,jsonb_build_object('job_id',p_job_id,'job_snapshot_id',v_job.current_snapshot_id,'job_analysis_id',v_analysis.id),jsonb_build_object('frozen',true)),
    (p_user,'lock_application_strategy','completed','application:'||v_app.id||':lock_application_strategy:v1','application',v_app.id,jsonb_build_object('job_analysis_id',v_analysis.id,'evidence_item_ids',v_analysis.evidence_item_ids),jsonb_build_object('locked',true)),
    (p_user,'select_cv_family','completed','application:'||v_app.id||':select_cv_family:v1','application',v_app.id,jsonb_build_object('cv_family',v_analysis.recommended_cv_family),jsonb_build_object('cv_family',v_analysis.recommended_cv_family)),
    (p_user,'prepare_cv','pending','application:'||v_app.id||':prepare_cv:v1','application',v_app.id,jsonb_build_object('execution_mode','chatgpt_plus_handoff','cv_family',v_analysis.recommended_cv_family,'evidence_item_ids',v_analysis.evidence_item_ids,'package',v_package),null),
    (p_user,'prepare_screening_answers','pending','application:'||v_app.id||':prepare_screening_answers:v1','application',v_app.id,jsonb_build_object('execution_mode','chatgpt_plus_handoff','trust_policy','verified_proposed_user_required','package',v_package),null),
    (p_user,'assemble_review_package','pending','application:'||v_app.id||':assemble_review_package:v1','application',v_app.id,jsonb_build_object('waits_for',jsonb_build_array('prepare_cv','prepare_cover_letter','prepare_screening_answers','research_salary')),null)
  on conflict (user_id,idempotency_key) do update set input_json=public.automation_tasks.input_json||excluded.input_json,updated_at=now();

  insert into public.application_preparation_requests(user_id,job_id,application_id,analysis_id,source,state,idempotency_key,selected_cv_family,package_json,decision_json)
  values(p_user,p_job_id,v_app.id,v_analysis.id,p_source,'awaiting_content',v_request_key,v_analysis.recommended_cv_family,v_package,
    jsonb_build_object('fit_score',v_analysis.fit_score,'priority_score',v_analysis.priority_score,'threshold',v_threshold,'gate1_required',true,'preference',v_preference))
  on conflict(user_id,idempotency_key) do update set application_id=excluded.application_id,package_json=excluded.package_json,decision_json=excluded.decision_json,updated_at=now()
  returning * into v_request;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,case when p_source='chatgpt_task' then 'chatgpt' else 'system' end,p_user::text,'application.auto_preparation_requested','application',v_app.id,
    jsonb_build_object('preparation_request_id',v_request.id,'job_id',p_job_id,'analysis_id',v_analysis.id,'gate1_required',true,'threshold',v_threshold));

  return jsonb_build_object('prepared',true,'state',v_request.state,'application_id',v_app.id,'preparation_request_id',v_request.id,
    'selected_cv_family',v_analysis.recommended_cv_family,'gate1_required',true,'submission_allowed',false,
    'next_action','Generate and review the evidence-backed package before Gate 1.');
end;
$$;
revoke all on function private.prepare_application_for_user(uuid,uuid,text,jsonb) from public,anon,authenticated;

create or replace function private.chatgpt_prepare_application_internal(p_access_token text,p_job_id uuid,p_package jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_result jsonb;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for application preparation'; end if;
  v_result := private.prepare_application_for_user(v_token.user_id,p_job_id,'chatgpt_task',coalesce(p_package,'{}'::jsonb));
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_token.user_id,'chatgpt',v_token.client_id,'chatgpt.application_preparation_requested','job',p_job_id,jsonb_build_object('result',v_result));
  return v_result;
end;
$$;
revoke all on function private.chatgpt_prepare_application_internal(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.chatgpt_prepare_application_internal(text,uuid,jsonb) to anon,authenticated;

create or replace function public.chatgpt_prepare_application(p_access_token text,p_job_id uuid,p_package jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_prepare_application_internal($1,$2,$3); $$;
revoke all on function public.chatgpt_prepare_application(text,uuid,jsonb) from public,authenticated;
grant execute on function public.chatgpt_prepare_application(text,uuid,jsonb) to anon;

create or replace function private.chatgpt_get_application_preparation_status_internal(p_access_token text,p_application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_app public.applications; v_requests jsonb;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for application status'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_token.user_id;
  if not found then raise exception 'Application not found'; end if;
  select coalesce(jsonb_agg(to_jsonb(r)-'user_id' order by r.created_at desc),'[]'::jsonb) into v_requests
    from public.application_preparation_requests r where r.user_id=v_token.user_id and r.application_id=p_application_id;
  return jsonb_build_object('application',to_jsonb(v_app)-'user_id','preparation_requests',v_requests,'gate1_required',v_app.state<>'content_approved','submission_allowed',false);
end;
$$;
revoke all on function private.chatgpt_get_application_preparation_status_internal(text,uuid) from public,anon,authenticated;
grant execute on function private.chatgpt_get_application_preparation_status_internal(text,uuid) to anon,authenticated;

create or replace function public.chatgpt_get_application_preparation_status(p_access_token text,p_application_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_get_application_preparation_status_internal($1,$2); $$;
revoke all on function public.chatgpt_get_application_preparation_status(text,uuid) from public,authenticated;
grant execute on function public.chatgpt_get_application_preparation_status(text,uuid) to anon;

comment on table public.application_preparation_requests is 'M22 per-user automatic preparation requests. Gate 1 and employer submission remain human-controlled.';
