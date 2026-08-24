-- ChatGPT Memory setup is user-controlled in ChatGPT Settings > Personalization.
-- This table records the user's confirmation and keeps previous-knowledge use on
-- by default without pretending the MCP server can inspect ChatGPT settings.

create table if not exists public.candidate_chatgpt_memory (
  profile_id uuid primary key references public.candidate_profiles(id) on delete cascade,
  memory_enabled_user_confirmed boolean not null default false,
  use_previous_knowledge boolean not null default true,
  memory_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.candidate_chatgpt_memory enable row level security;
drop policy if exists candidate_chatgpt_memory_owner on public.candidate_chatgpt_memory;
create policy candidate_chatgpt_memory_owner on public.candidate_chatgpt_memory
  for all to authenticated
  using (private.owns_profile(profile_id))
  with check (private.owns_profile(profile_id));
grant select, insert, update on public.candidate_chatgpt_memory to authenticated;

create or replace function public.get_onboarding_readiness()
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_profile uuid;
  v_pending int := 0;
  v_history int := 0;
  v_skills int := 0;
  v_evidence int := 0;
  v_work_auth int := 0;
  v_locations boolean := false;
  v_target_roles boolean := false;
  v_work_modes boolean := false;
  v_role_families boolean := false;
  v_seniority boolean := false;
  v_preferences_complete boolean := false;
  v_families int := 0;
  v_source_documents int := 0;
  v_status text;
  v_score int := 0;
  v_preferences jsonb := '{}'::jsonb;
  v_gmail boolean := false;
  v_chatgpt boolean := false;
  v_helper boolean := false;
  v_memory boolean := false;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);

  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then
    return jsonb_build_object('ready',false,'score',0,'reason','profile_missing');
  end if;

  select coalesce(preferences,'{}'::jsonb) into v_preferences
    from public.candidate_preferences where profile_id=v_profile;
  v_locations := jsonb_typeof(v_preferences->'locations')='array' and jsonb_array_length(v_preferences->'locations')>0;
  v_target_roles := jsonb_typeof(v_preferences->'target_roles')='array' and jsonb_array_length(v_preferences->'target_roles')>0;
  v_work_modes := jsonb_typeof(v_preferences->'work_modes')='array' and jsonb_array_length(v_preferences->'work_modes')>0;
  v_role_families := jsonb_typeof(v_preferences->'role_families')='array' and jsonb_array_length(v_preferences->'role_families')>0;
  v_seniority := nullif(btrim(coalesce(v_preferences->>'target_seniority','')),'') is not null;
  v_preferences_complete := v_locations and v_target_roles and v_work_modes and v_role_families and v_seniority;

  select count(*) into v_pending from (
    select id from public.candidate_facts where profile_id=v_profile and verification_status='needs_review'
    union all select id from public.evidence_items where profile_id=v_profile and verification_status='needs_review'
    union all select id from public.candidate_extraction_proposals where profile_id=v_profile and verification_status='needs_review'
  ) q;
  select (select count(*) from public.candidate_education where profile_id=v_profile and verification_status='verified')+
         (select count(*) from public.candidate_employment where profile_id=v_profile and verification_status='verified') into v_history;
  select count(*) into v_skills from public.candidate_skills where profile_id=v_profile and verification_status='verified';
  select count(*) into v_evidence from public.evidence_items where profile_id=v_profile and verification_status='verified';
  select count(*) into v_work_auth from public.candidate_facts where profile_id=v_profile and fact_key='work_authorisation' and verification_status='verified';
  select count(*) into v_families from public.candidate_cv_families where profile_id=v_profile and enabled;
  select count(*) into v_source_documents from public.candidate_source_documents where profile_id=v_profile and extraction_status='extracted';
  select status into v_status from public.candidate_onboarding where profile_id=v_profile;
  select (coalesce(memory_enabled_user_confirmed,false) and coalesce(use_previous_knowledge,true)) into v_memory
    from public.candidate_chatgpt_memory where profile_id=v_profile;

  begin
    v_gmail := coalesce((public.get_live_cutover_status()->>'gmail_refresh_credential')::boolean,false);
  exception when others then v_gmail := false;
  end;
  begin
    v_chatgpt := coalesce((public.chatgpt_connection_status()->>'connected')::boolean,false);
  exception when others then v_chatgpt := false;
  end;
  begin
    v_helper := coalesce((public.get_browser_agent_helper_status()->>'paired')::boolean,false);
  exception when others then v_helper := false;
  end;

  -- Keep the readiness score at 100 while reserving five points for the
  -- explicit ChatGPT Memory confirmation.
  v_score := (case when v_history>0 then 10 else 0 end)
    +(case when v_skills>0 then 8 else 0 end)
    +(case when v_evidence>0 then 10 else 0 end)
    +(case when v_work_auth>0 then 8 else 0 end)
    +(case when v_locations then 7 else 0 end)
    +(case when v_target_roles then 7 else 0 end)
    +(case when v_preferences_complete then 10 else 0 end)
    +(case when v_families>0 then 7 else 0 end)
    +(case when v_source_documents>0 then 8 else 0 end)
    +(case when v_pending=0 then 7 else 0 end)
    +(case when v_gmail then 4 else 0 end)
    +(case when v_chatgpt then 4 else 0 end)
    +(case when v_helper then 5 else 0 end)
    +(case when v_memory then 5 else 0 end);

  return jsonb_build_object(
    'ready',v_score=100,
    'score',v_score,
    'status',coalesce(v_status,'in_progress'),
    'pending_review',v_pending,
    'history',v_history,
    'skills',v_skills,
    'verified_evidence',v_evidence,
    'work_authorisation',v_work_auth>0,
    'locations',v_locations,
    'target_roles',v_target_roles,
    'work_modes',v_work_modes,
    'role_families',v_role_families,
    'target_seniority',v_seniority,
    'preferences_complete',v_preferences_complete,
    'cv_families',v_families,
    'source_document_extracted',v_source_documents>0,
    'gmail_connected',v_gmail,
    'chatgpt_connected',v_chatgpt,
    'chatgpt_memory_confirmed',v_memory,
    'browser_helper_paired',v_helper
  );
end;
$$;
revoke all on function public.get_onboarding_readiness() from public, anon;
grant execute on function public.get_onboarding_readiness() to authenticated;

create or replace function public.complete_candidate_onboarding()
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_profile uuid;
  v_ready jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  v_ready := public.get_onboarding_readiness();
  if coalesce((v_ready->>'ready')::boolean,false) is not true then
    raise exception 'Finish the activation checklist before marking Job Hunt Console ready';
  end if;
  insert into public.candidate_onboarding(profile_id,status,completed_steps,ready_at,updated_at)
  values(v_profile,'ready',array['welcome','cv','review','personal','history','preferences','cv_strategy','gmail','chatgpt','chatgpt_memory','browser_helper'],now(),now())
  on conflict(profile_id) do update set
    status='ready',completed_steps=excluded.completed_steps,ready_at=coalesce(public.candidate_onboarding.ready_at,now()),updated_at=now();
  return v_ready||jsonb_build_object('status','ready');
end;
$$;
revoke all on function public.complete_candidate_onboarding() from public, anon;
grant execute on function public.complete_candidate_onboarding() to authenticated;

comment on table public.candidate_chatgpt_memory is
  'Per-user confirmation that ChatGPT Memory was enabled in ChatGPT Settings > Personalization; previous knowledge is used by default when available.';
