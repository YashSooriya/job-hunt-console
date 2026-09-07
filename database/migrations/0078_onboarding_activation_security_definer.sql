-- M35: onboarding activation wrappers need a narrowly scoped membership guard.
-- The previous migration left these public wrappers as SECURITY INVOKER while
-- calling the private helper that is intentionally unavailable to callers.
-- Keep the wrappers invoker-secure and grant only a self-scoped helper.

create or replace function private.assert_current_user_active_app_membership()
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1
      from private.app_memberships
     where user_id=v_user
       and status='active'
  ) then
    raise exception 'Active Job Hunt Console membership required';
  end if;
end;
$$;

revoke all on function private.assert_current_user_active_app_membership() from public, anon;
grant execute on function private.assert_current_user_active_app_membership() to authenticated;

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
  v_profile_complete boolean := false;
  v_activation_ready boolean := false;
  v_families int := 0;
  v_source_documents int := 0;
  v_status text;
  v_score int := 0;
  v_preferences jsonb := '{}'::jsonb;
  v_search_mode text := 'keywords_and_profile';
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_current_user_active_app_membership();

  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then
    return jsonb_build_object('ready',false,'activation_ready',false,'profile_complete',false,'score',0,'reason','profile_missing');
  end if;

  select coalesce(preferences,'{}'::jsonb) into v_preferences
    from public.candidate_preferences where profile_id=v_profile;
  v_search_mode := case
    when v_preferences->>'search_mode' in ('keywords','profile','keywords_and_profile') then v_preferences->>'search_mode'
    else 'keywords_and_profile'
  end;
  v_locations := jsonb_typeof(v_preferences->'locations')='array' and jsonb_array_length(v_preferences->'locations')>0;
  v_target_roles := jsonb_typeof(v_preferences->'target_roles')='array' and jsonb_array_length(v_preferences->'target_roles')>0;
  v_work_modes := jsonb_typeof(v_preferences->'work_modes')='array' and jsonb_array_length(v_preferences->'work_modes')>0;
  v_role_families := jsonb_typeof(v_preferences->'role_families')='array' and jsonb_array_length(v_preferences->'role_families')>0;
  v_seniority := nullif(btrim(coalesce(v_preferences->>'target_seniority','')),'') is not null;
  v_preferences_complete := v_locations and v_work_modes and (
    v_search_mode='profile' or (v_target_roles and v_role_families and v_seniority)
  );

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
  select count(*) into v_source_documents from public.candidate_source_documents where profile_id=v_profile and extraction_status in ('stored','extracted');
  select status into v_status from public.candidate_onboarding where profile_id=v_profile;

  v_profile_complete := v_history > 0 and v_work_auth > 0;
  v_activation_ready := v_profile_complete and v_preferences_complete and v_pending = 0;
  v_score := (case when v_profile_complete then 60 else 0 end)
    +(case when v_preferences_complete then 30 else 0 end)
    +(case when v_pending=0 then 10 else 0 end);

  return jsonb_build_object(
    'ready',v_activation_ready,
    'activation_ready',v_activation_ready,
    'profile_complete',v_profile_complete,
    'score',v_score,
    'status',coalesce(v_status,'in_progress'),
    'pending_review',v_pending,
    'history',v_history,
    'skills',v_skills,
    'verified_evidence',v_evidence,
    'work_authorisation',v_work_auth>0,
    'locations',v_locations,
    'target_roles',v_target_roles,
    'search_mode',v_search_mode,
    'work_modes',v_work_modes,
    'role_families',v_role_families,
    'target_seniority',v_seniority,
    'preferences_complete',v_preferences_complete,
    'cv_families',v_families,
    'source_document_extracted',v_source_documents>0,
    'external_connections_required',false
  );
end;
$$;

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
  perform private.assert_current_user_active_app_membership();
  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  v_ready := public.get_onboarding_readiness();
  if coalesce((v_ready->>'activation_ready')::boolean,false) is not true then
    raise exception 'Complete the editable profile and job-search preferences before activation';
  end if;
  insert into public.candidate_onboarding(profile_id,status,completed_steps,ready_at,updated_at)
  values(v_profile,'ready',array['profile','preferences','memory_update'],now(),now())
  on conflict(profile_id) do update set
    status='ready',completed_steps=excluded.completed_steps,ready_at=coalesce(public.candidate_onboarding.ready_at,now()),updated_at=now();
  return v_ready||jsonb_build_object('status','ready');
end;
$$;

revoke all on function public.get_onboarding_readiness() from public, anon;
grant execute on function public.get_onboarding_readiness() to authenticated;

revoke all on function public.complete_candidate_onboarding() from public, anon;
grant execute on function public.complete_candidate_onboarding() to authenticated;
