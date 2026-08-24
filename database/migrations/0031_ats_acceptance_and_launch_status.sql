-- Milestone 15: persistent no-submit ATS acceptance evidence and V1 launch qualification.

alter table public.form_agent_sessions
  add column if not exists acceptance_mode boolean not null default false,
  add column if not exists acceptance_provider_family text;

create table if not exists public.ats_acceptance_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  form_session_id uuid not null unique references public.form_agent_sessions(id) on delete cascade,
  provider_family text not null check (char_length(provider_family) between 2 and 80),
  source_url text,
  outcome text not null check (outcome in ('final_review','needs_user','authentication_pause','failed')),
  final_review_reached boolean not null default false,
  submit_clicked boolean not null default false check (submit_clicked = false),
  helper_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ats_acceptance_runs_user_created_idx
  on public.ats_acceptance_runs(user_id, created_at desc);
create index if not exists ats_acceptance_runs_user_provider_idx
  on public.ats_acceptance_runs(user_id, provider_family, final_review_reached, created_at desc);
create index if not exists ats_acceptance_runs_application_idx
  on public.ats_acceptance_runs(application_id, created_at desc);

alter table public.ats_acceptance_runs enable row level security;
revoke all on public.ats_acceptance_runs from public, anon, authenticated;
grant select, insert on public.ats_acceptance_runs to service_role;
create policy ats_acceptance_runs_no_direct_client_access on public.ats_acceptance_runs
  as restrictive for all to authenticated using (false) with check (false);

create or replace function private.block_acceptance_session_submission()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.acceptance_mode is true and new.status in ('approved_for_submission','submitting','submitted') then
    raise exception 'Acceptance sessions are hard no-submit sessions';
  end if;
  return new;
end;
$$;
revoke all on function private.block_acceptance_session_submission() from public,anon,authenticated;
drop trigger if exists block_acceptance_session_submission on public.form_agent_sessions;
create trigger block_acceptance_session_submission
  before update of status on public.form_agent_sessions
  for each row execute function private.block_acceptance_session_submission();

create or replace function private.start_form_agent_acceptance_session_for_paired_device(
  p_user uuid,
  p_application_id uuid,
  p_device_id uuid,
  p_provider_family text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_started jsonb;
  v_session uuid;
  v_family text := lower(trim(coalesce(p_provider_family,'')));
begin
  if char_length(v_family) < 2 or char_length(v_family) > 80 then
    raise exception 'A provider-family label is required for acceptance tracking';
  end if;

  v_started := private.start_form_agent_session_for_paired_device(p_user,p_application_id,p_device_id);
  v_session := (v_started->>'session_id')::uuid;
  update public.form_agent_sessions
     set acceptance_mode=true,acceptance_provider_family=v_family,updated_at=now()
   where id=v_session and user_id=p_user;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'form_agent.acceptance_started','application',p_application_id,
         jsonb_build_object('session_id',v_session,'provider_family',v_family,'mode','no_submit'));

  return v_started || jsonb_build_object('acceptance_mode',true,'provider_family',v_family,'no_submit',true);
end;
$$;
revoke all on function private.start_form_agent_acceptance_session_for_paired_device(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function private.start_form_agent_acceptance_session_for_paired_device(uuid,uuid,uuid,text) to authenticated;

create or replace function public.start_form_agent_acceptance_session_for_device(
  p_application_id uuid,
  p_device_id uuid,
  p_provider_family text
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.start_form_agent_acceptance_session_for_paired_device(v_user,p_application_id,p_device_id,p_provider_family);
end;
$$;
revoke all on function public.start_form_agent_acceptance_session_for_device(uuid,uuid,text) from public,anon;
grant execute on function public.start_form_agent_acceptance_session_for_device(uuid,uuid,text) to authenticated;

create or replace function public.record_form_agent_acceptance_result(
  p_session_id uuid,
  p_outcome text,
  p_helper_version text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_session public.form_agent_sessions;
  v_outcome text := lower(trim(coalesce(p_outcome,'')));
  v_run public.ats_acceptance_runs;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_session from public.form_agent_sessions where id=p_session_id;
  if not found then raise exception 'Form session not found'; end if;
  if v_session.acceptance_mode is not true then raise exception 'Form session is not an acceptance session'; end if;
  if v_session.acceptance_provider_family is null then raise exception 'Acceptance provider family is missing'; end if;
  if v_outcome not in ('final_review','needs_user','authentication_pause','failed') then raise exception 'Unsupported acceptance outcome'; end if;
  if v_outcome='final_review' and (v_session.status <> 'final_review' or v_session.final_observation_id is null) then
    raise exception 'Final-review acceptance may only be recorded from the exact final-review session state';
  end if;

  insert into public.ats_acceptance_runs(
    user_id,application_id,form_session_id,provider_family,source_url,outcome,final_review_reached,submit_clicked,helper_version,metadata
  ) values(
    v_session.user_id,v_session.application_id,v_session.id,v_session.acceptance_provider_family,v_session.current_url,v_outcome,
    v_outcome='final_review',false,nullif(trim(coalesce(p_helper_version,'')),''),coalesce(p_metadata,'{}'::jsonb)
  )
  on conflict (form_session_id) do nothing
  returning * into v_run;
  if v_run.id is null then
    select * into v_run from public.ats_acceptance_runs where form_session_id=v_session.id;
  end if;

  if v_outcome='final_review' then
    update public.form_agent_sessions set status='cancelled',completed_at=now(),updated_at=now() where id=v_session.id;
    update public.applications set state='content_approved',next_action='No-submit ATS acceptance completed. Application was not submitted.',updated_at=now()
      where id=v_session.application_id and user_id=v_session.user_id;
  end if;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_session.user_id,'system','browser-helper-bridge','form_agent.acceptance_recorded','application',v_session.application_id,
         jsonb_build_object('session_id',v_session.id,'provider_family',v_session.acceptance_provider_family,'outcome',v_outcome,'submit_clicked',false,'pipeline_restored',v_outcome='final_review'));

  return jsonb_build_object('recorded',true,'run_id',v_run.id,'provider_family',v_run.provider_family,'outcome',v_run.outcome,'submit_clicked',false,'application_restored',v_outcome='final_review');
end;
$$;
revoke all on function public.record_form_agent_acceptance_result(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_form_agent_acceptance_result(uuid,text,text,jsonb) to service_role;

create or replace function private.get_ats_acceptance_status_for_user(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_greenhouse boolean;
  v_lever boolean;
  v_workday boolean;
  v_additional boolean;
  v_custom boolean;
  v_total integer;
  v_families jsonb;
begin
  select count(*) into v_total from public.ats_acceptance_runs
   where user_id=p_user and final_review_reached and submit_clicked=false;
  select exists(select 1 from public.ats_acceptance_runs where user_id=p_user and final_review_reached and provider_family='greenhouse') into v_greenhouse;
  select exists(select 1 from public.ats_acceptance_runs where user_id=p_user and final_review_reached and provider_family='lever') into v_lever;
  select exists(select 1 from public.ats_acceptance_runs where user_id=p_user and final_review_reached and provider_family='workday') into v_workday;
  select exists(select 1 from public.ats_acceptance_runs where user_id=p_user and final_review_reached and provider_family in ('ashby','smartrecruiters','successfactors')) into v_additional;
  select exists(select 1 from public.ats_acceptance_runs where user_id=p_user and final_review_reached and provider_family='custom') into v_custom;
  select coalesce(jsonb_agg(distinct provider_family),'[]'::jsonb) into v_families from public.ats_acceptance_runs
   where user_id=p_user and final_review_reached and submit_clicked=false;
  return jsonb_build_object(
    'successful_live_runs',v_total,
    'provider_families',v_families,
    'greenhouse',v_greenhouse,
    'lever',v_lever,
    'workday',v_workday,
    'additional_major_ats',v_additional,
    'custom',v_custom,
    'coverage_complete',(v_greenhouse and v_lever and v_workday and v_additional and v_custom)
  );
end;
$$;
revoke all on function private.get_ats_acceptance_status_for_user(uuid) from public,anon,authenticated;
grant execute on function private.get_ats_acceptance_status_for_user(uuid) to authenticated;

create or replace function public.get_v1_launch_status()
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_cutover jsonb;
  v_helper jsonb;
  v_acceptance jsonb;
  v_cutover_ok boolean;
  v_gmail_ok boolean;
  v_helper_ok boolean;
  v_acceptance_ok boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  v_cutover := private.get_live_cutover_status();
  v_helper := private.get_browser_agent_helper_status_for_user(v_user);
  v_acceptance := private.get_ats_acceptance_status_for_user(v_user);
  v_cutover_ok := coalesce((v_cutover->>'cutover_complete')::boolean,false);
  v_gmail_ok := coalesce((v_cutover->>'gmail_refresh_credential')::boolean,false);
  v_helper_ok := coalesce((v_helper->>'paired')::boolean,false);
  v_acceptance_ok := coalesce((v_acceptance->>'coverage_complete')::boolean,false);
  return jsonb_build_object(
    'data_cutover',v_cutover,
    'browser_helper',v_helper,
    'live_ats_acceptance',v_acceptance,
    'database_launch_ready',(v_cutover_ok and v_gmail_ok and v_helper_ok and v_acceptance_ok),
    'hosted_deployment','external_check_required'
  );
end;
$$;
revoke all on function public.get_v1_launch_status() from public,anon;
grant execute on function public.get_v1_launch_status() to authenticated;

create or replace function private.get_form_agent_session_status_for_user(p_user uuid,p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_session public.form_agent_sessions;
begin
  select * into v_session from public.form_agent_sessions where application_id=p_application_id and user_id=p_user order by started_at desc limit 1;
  if not found then return jsonb_build_object('session',null); end if;
  return jsonb_build_object('session',jsonb_build_object(
    'id',v_session.id,'application_id',v_session.application_id,'status',v_session.status,'expires_at',v_session.expires_at,
    'current_url',v_session.current_url,'current_title',v_session.current_title,'pause_reasons',v_session.pause_reasons,
    'final_review',v_session.final_review_json,'submit_candidate',v_session.submit_candidate,'started_at',v_session.started_at,
    'updated_at',v_session.updated_at,'completed_at',v_session.completed_at,'acceptance_mode',v_session.acceptance_mode,
    'acceptance_provider_family',v_session.acceptance_provider_family
  ));
end $$;
revoke all on function private.get_form_agent_session_status_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.get_form_agent_session_status_for_user(uuid,uuid) to authenticated;
