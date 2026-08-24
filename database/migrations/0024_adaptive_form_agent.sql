-- Milestone 10: website-agnostic adaptive browser form sessions and Approval Gate 2.

create table if not exists public.form_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  status text not null default 'active' check (status in ('active','needs_user','final_review','approved_for_submission','submitting','submitted','cancelled','expired','failed')),
  token_hash text not null,
  expires_at timestamptz not null,
  provider_hint text,
  current_url text,
  current_title text,
  last_fingerprint text,
  final_observation_id uuid,
  final_review_json jsonb,
  submit_candidate jsonb,
  pause_reasons jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.form_agent_observations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.form_agent_sessions(id) on delete cascade,
  sequence_number integer not null,
  url text not null,
  title text,
  page_purpose text,
  fingerprint text not null,
  observation_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(session_id, sequence_number)
);

alter table public.form_agent_sessions
  add constraint form_agent_sessions_final_observation_fk
  foreign key (final_observation_id) references public.form_agent_observations(id) on delete set null;

create table if not exists public.form_agent_plans (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.form_agent_sessions(id) on delete cascade,
  observation_id uuid not null references public.form_agent_observations(id) on delete cascade,
  contract_version text not null default '1.0.0',
  planner_source text not null,
  plan_json jsonb not null,
  status text not null default 'validated' check (status in ('validated','action_executed','paused','superseded','failed')),
  action_result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists form_agent_sessions_user_application_idx on public.form_agent_sessions(user_id, application_id, started_at desc);
create index if not exists form_agent_sessions_status_idx on public.form_agent_sessions(user_id, status, updated_at desc);
create index if not exists form_agent_observations_session_idx on public.form_agent_observations(session_id, sequence_number desc);
create index if not exists form_agent_plans_session_idx on public.form_agent_plans(session_id, created_at desc);
create index if not exists form_agent_plans_observation_idx on public.form_agent_plans(observation_id);

alter table public.form_agent_sessions enable row level security;
alter table public.form_agent_observations enable row level security;
alter table public.form_agent_plans enable row level security;

-- Session rows are read through a narrow RPC to avoid exposing token hashes.
revoke all on public.form_agent_sessions from anon, authenticated, public;
revoke all on public.form_agent_observations from anon, authenticated, public;
revoke all on public.form_agent_plans from anon, authenticated, public;
grant select, insert, update, delete on public.form_agent_sessions to service_role;
grant select, insert, update, delete on public.form_agent_observations to service_role;
grant select, insert, update, delete on public.form_agent_plans to service_role;

create or replace function private.form_agent_owner(p_session_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.form_agent_sessions s where s.id=p_session_id and s.user_id=p_user);
$$;
revoke all on function private.form_agent_owner(uuid,uuid) from public, anon, authenticated;

create or replace function public.start_form_agent_session(p_application_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_package public.application_review_packages;
  v_token text;
  v_session public.form_agent_sessions;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state not in ('content_approved','form_in_progress','form_needs_user','final_review') then
    raise exception 'Application must have passed Gate 1 before form completion';
  end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id and approved_at is not null;
  if not found then raise exception 'Approved Gate 1 package not found'; end if;

  update public.form_agent_sessions set status='cancelled',updated_at=now(),completed_at=now()
    where user_id=v_user and application_id=p_application_id and status in ('active','needs_user','final_review');

  v_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.form_agent_sessions(user_id,application_id,status,token_hash,expires_at)
  values(v_user,p_application_id,'active',encode(extensions.digest(v_token,'sha256'),'hex'),now()+interval '8 hours')
  returning * into v_session;

  update public.applications set state='form_in_progress',next_action='Complete and review the employer form.',updated_at=now() where id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'form_agent.session_started','application',p_application_id,jsonb_build_object('session_id',v_session.id,'expires_at',v_session.expires_at));

  return jsonb_build_object('session_id',v_session.id,'token',v_token,'expires_at',v_session.expires_at,'status',v_session.status);
end;
$$;
revoke all on function public.start_form_agent_session(uuid) from public, anon;
grant execute on function public.start_form_agent_session(uuid) to authenticated;

create or replace function public.get_form_agent_session_status(p_application_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session public.form_agent_sessions;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_session from public.form_agent_sessions
    where application_id=p_application_id and user_id=v_user
    order by started_at desc limit 1;
  if not found then return jsonb_build_object('session',null); end if;
  return jsonb_build_object('session',jsonb_build_object(
    'id',v_session.id,'application_id',v_session.application_id,'status',v_session.status,'expires_at',v_session.expires_at,
    'current_url',v_session.current_url,'current_title',v_session.current_title,'pause_reasons',v_session.pause_reasons,
    'final_review',v_session.final_review_json,'submit_candidate',v_session.submit_candidate,'started_at',v_session.started_at,
    'updated_at',v_session.updated_at,'completed_at',v_session.completed_at
  ));
end;
$$;
revoke all on function public.get_form_agent_session_status(uuid) from public, anon;
grant execute on function public.get_form_agent_session_status(uuid) to authenticated;

create or replace function public.approve_form_agent_final_review(p_session_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session public.form_agent_sessions;
  v_unresolved integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_session from public.form_agent_sessions where id=p_session_id and user_id=v_user for update;
  if not found then raise exception 'Form session not found'; end if;
  if v_session.status <> 'final_review' then raise exception 'Form session is not at Final Review'; end if;
  if v_session.expires_at <= now() then raise exception 'Form session has expired'; end if;
  if v_session.final_observation_id is null or v_session.final_review_json is null then raise exception 'Final employer-form observation is missing'; end if;
  v_unresolved := coalesce((v_session.final_review_json->'summary'->>'unresolved')::integer,0);
  if v_unresolved > 0 then raise exception 'Final review still contains unresolved fields'; end if;
  if not exists(select 1 from public.applications where id=v_session.application_id and user_id=v_user and state='final_review') then
    raise exception 'Application is not at Final Review';
  end if;

  update public.form_agent_sessions set status='approved_for_submission',updated_at=now() where id=p_session_id;
  update public.applications set state='approved_for_submission',next_action='Approved for exact final submission.',updated_at=now() where id=v_session.application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'form_agent.gate2_approved','application',v_session.application_id,jsonb_build_object('session_id',p_session_id,'final_observation_id',v_session.final_observation_id));
  return jsonb_build_object('application_id',v_session.application_id,'session_id',p_session_id,'state','approved_for_submission');
end;
$$;
revoke all on function public.approve_form_agent_final_review(uuid) from public, anon;
grant execute on function public.approve_form_agent_final_review(uuid) to authenticated;

create or replace function private.lock_application_submission_context(
  p_application_id uuid,
  p_submitted_at timestamptz,
  p_submission_source text,
  p_final_review jsonb
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_app public.applications;
  v_pkg public.application_review_packages;
  v_strategy public.application_strategies;
  v_salary jsonb;
  v_answers jsonb;
  v_context jsonb;
begin
  select * into v_app from public.applications where id=p_application_id;
  if not found then raise exception 'Application not found'; end if;
  select * into v_pkg from public.application_review_packages where application_id=p_application_id and approved_at is not null;
  if not found then raise exception 'Approved review package missing'; end if;
  select * into v_strategy from public.application_strategies where application_id=p_application_id order by created_at desc limit 1;
  select to_jsonb(s) into v_salary from public.application_salary_contexts s where application_id=p_application_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'question_key',a.question_key,'question_text',a.question_text,'answer_text',a.answer_text,
    'trust',a.trust,'required',a.required,'approved_at',a.approved_at
  ) order by a.created_at),'[]'::jsonb) into v_answers from public.application_answers a where application_id=p_application_id;
  v_context := jsonb_build_object(
    'submission_source',p_submission_source,
    'final_form_review',coalesce(p_final_review,'{}'::jsonb),
    'gate1_review_package_application_id',v_pkg.application_id,
    'cover_letter_decision',v_pkg.cover_letter_decision
  );
  insert into public.application_submission_contexts(application_id,submitted_at,cv_version_id,cover_letter_version_id,screening_answers,salary_context,job_snapshot_id,job_analysis_id,strategy_id,context_snapshot)
  values(p_application_id,p_submitted_at,v_pkg.cv_version_id,case when v_pkg.cover_letter_decision='use' then v_pkg.cover_letter_version_id else null end,v_answers,v_salary,v_app.job_snapshot_id,v_app.job_analysis_id,v_strategy.id,v_context)
  on conflict (application_id) do nothing;

  update public.document_versions set submission_locked_at=coalesce(submission_locked_at,p_submitted_at),approval_status='submitted'
    where id in (v_pkg.cv_version_id,v_pkg.cover_letter_version_id) and id is not null;
end;
$$;
revoke all on function private.lock_application_submission_context(uuid,timestamptz,text,jsonb) from public, anon, authenticated;

create or replace function public.form_agent_service_transition(p_session_id uuid, p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_session public.form_agent_sessions;
  v_obs uuid;
  v_now timestamptz := now();
begin
  select * into v_session from public.form_agent_sessions where id=p_session_id for update;
  if not found then raise exception 'Form session not found'; end if;
  if v_session.expires_at <= now() and v_session.status not in ('submitted','cancelled') then
    update public.form_agent_sessions set status='expired',updated_at=now(),completed_at=now() where id=p_session_id;
    raise exception 'Form session expired';
  end if;

  if p_operation='needs_user' then
    update public.form_agent_sessions set status='needs_user',pause_reasons=coalesce(p_payload->'reasons','[]'::jsonb),updated_at=v_now where id=p_session_id;
    update public.applications set state='form_needs_user',next_action='Resolve the browser form item that needs you.',updated_at=v_now where id=v_session.application_id;
  elsif p_operation='resume' then
    if v_session.status not in ('needs_user','active') then raise exception 'Session cannot resume from current state'; end if;
    update public.form_agent_sessions set status='active',pause_reasons='[]'::jsonb,updated_at=v_now where id=p_session_id;
    update public.applications set state='form_in_progress',next_action='Continue employer-form completion.',updated_at=v_now where id=v_session.application_id;
  elsif p_operation='final_review' then
    v_obs := nullif(p_payload->>'observation_id','')::uuid;
    if v_obs is null or not exists(select 1 from public.form_agent_observations where id=v_obs and session_id=p_session_id) then raise exception 'Final observation is invalid'; end if;
    if coalesce((p_payload->'diff'->'summary'->>'unresolved')::integer,0) > 0 then raise exception 'Cannot enter Final Review with unresolved fields'; end if;
    update public.form_agent_sessions set status='final_review',final_observation_id=v_obs,final_review_json=p_payload->'diff',submit_candidate=p_payload->'submit_candidate',updated_at=v_now where id=p_session_id;
    update public.applications set state='final_review',next_action='Review the completed employer form before submission.',updated_at=v_now where id=v_session.application_id;
  elsif p_operation='submission_clicked' then
    if v_session.status <> 'approved_for_submission' then raise exception 'Gate 2 approval is required'; end if;
    update public.form_agent_sessions set status='submitting',updated_at=v_now where id=p_session_id;
  elsif p_operation='submitted' then
    if v_session.status not in ('approved_for_submission','submitting') then raise exception 'Gate 2 approval is required before recording submission'; end if;
    perform private.lock_application_submission_context(v_session.application_id,v_now,coalesce(p_payload->>'submission_source','helper'),v_session.final_review_json);
    update public.form_agent_sessions set status='submitted',updated_at=v_now,completed_at=v_now where id=p_session_id;
    update public.applications set state='submitted',submitted_at=coalesce(submitted_at,v_now),applied_at=coalesce(applied_at,v_now),next_action='Await employer confirmation or next-stage communication.',updated_at=v_now where id=v_session.application_id;
  else
    raise exception 'Unsupported form-agent operation';
  end if;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_session.user_id,'system','form-agent','form_agent.'||p_operation,'application',v_session.application_id,jsonb_build_object('session_id',p_session_id,'payload',p_payload));
  return jsonb_build_object('session_id',p_session_id,'application_id',v_session.application_id,'operation',p_operation);
end;
$$;
revoke all on function public.form_agent_service_transition(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.form_agent_service_transition(uuid,text,jsonb) to service_role;

create or replace function public.record_form_agent_manual_submission(p_session_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session public.form_agent_sessions;
  v_now timestamptz := now();
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_session from public.form_agent_sessions where id=p_session_id and user_id=v_user for update;
  if not found then raise exception 'Form session not found'; end if;
  if v_session.status not in ('final_review','approved_for_submission') then raise exception 'Final Review is required before manual submission recording'; end if;
  if coalesce((v_session.final_review_json->'summary'->>'unresolved')::integer,0) > 0 then raise exception 'Final review contains unresolved fields'; end if;
  perform private.lock_application_submission_context(v_session.application_id,v_now,'manual',v_session.final_review_json);
  update public.form_agent_sessions set status='submitted',updated_at=v_now,completed_at=v_now where id=p_session_id;
  update public.applications set state='submitted',submitted_at=coalesce(submitted_at,v_now),applied_at=coalesce(applied_at,v_now),next_action='Await employer confirmation or next-stage communication.',updated_at=v_now where id=v_session.application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'form_agent.manual_submission_recorded','application',v_session.application_id,jsonb_build_object('session_id',p_session_id));
  return jsonb_build_object('application_id',v_session.application_id,'session_id',p_session_id,'state','submitted');
end;
$$;
revoke all on function public.record_form_agent_manual_submission(uuid) from public, anon;
grant execute on function public.record_form_agent_manual_submission(uuid) to authenticated;

-- Reserve all employer-form and submission states for Gate 2-specific RPCs.
create or replace function public.transition_application_state(p_application_id uuid,p_to_state public.application_state,p_metadata jsonb default '{}'::jsonb)
returns public.applications
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_from public.application_state;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_to_state in ('ready_for_review','content_approved','form_in_progress','form_needs_user','final_review','approved_for_submission','submitted') then
    raise exception 'Target state % is reserved for its validated workflow',p_to_state;
  end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  v_from := v_app.state;
  if not exists(select 1 from public.application_state_transitions where from_state=v_from and to_state=p_to_state) then raise exception 'Invalid application transition: % -> %',v_from,p_to_state; end if;
  update public.applications set state=p_to_state,updated_at=now() where id=p_application_id returning * into v_app;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'application.state_transition','application',p_application_id,jsonb_build_object('from',v_from,'to',p_to_state,'metadata',p_metadata));
  return v_app;
end;
$$;
revoke all on function public.transition_application_state(uuid,public.application_state,jsonb) from public, anon;
grant execute on function public.transition_application_state(uuid,public.application_state,jsonb) to authenticated;
