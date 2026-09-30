-- App-owned schedules create ordinary Website Bridge requests. The existing
-- bridge dispatch and v3 completion/provenance boundary remain the only
-- ChatGPT transport and response contract.

-- pg_cron owns the `cron` schema; install it there so cron.schedule and its
-- job history tables are available under their documented names.
create extension if not exists pg_cron;

alter table public.job_search_controls
  add column if not exists search_schedule_enabled boolean not null default false,
  add column if not exists search_schedule_timezone text not null default 'Europe/London',
  add column if not exists search_schedule_time time not null default time '09:00',
  add column if not exists next_scheduled_search_at timestamptz,
  add column if not exists last_scheduled_search_at timestamptz,
  add column if not exists last_scheduled_window_key text,
  add column if not exists last_scheduled_search_error text;

-- The authenticated role only edits the two Diagnostics switches. Manual
-- cooldown timestamps and scheduler leases are writable only through their
-- owner-checked database functions.
revoke update on public.job_search_controls from authenticated;
grant update(manual_search_cooldown_disabled,testing_mode_enabled,updated_at)
  on public.job_search_controls to authenticated;
revoke insert on public.job_search_controls from authenticated;
grant insert(user_id,manual_search_cooldown_disabled,testing_mode_enabled,updated_at)
  on public.job_search_controls to authenticated;

create or replace function private.next_job_search_due_at(
  p_cadence text,
  p_local_time time,
  p_timezone text,
  p_after timestamptz
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_day date;
  v_candidate timestamptz;
  v_offset integer;
begin
  if p_cadence = 'manual' then return null; end if;
  if p_cadence not in ('daily','weekdays','weekly') then raise exception 'Invalid job-search cadence'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then
    raise exception 'Choose a valid IANA timezone';
  end if;
  if p_local_time is null or p_after is null then raise exception 'A local time and current timestamp are required'; end if;

  for v_offset in 0..8 loop
    v_day := (p_after at time zone p_timezone)::date + v_offset;
    if p_cadence = 'weekdays' and extract(isodow from v_day) in (6,7) then continue; end if;
    if p_cadence = 'weekly' and extract(isodow from v_day) <> 1 then continue; end if;
    v_candidate := (v_day + p_local_time) at time zone p_timezone;
    if v_candidate > p_after then return v_candidate; end if;
  end loop;
  raise exception 'Unable to calculate the next job-search run';
end;
$$;
revoke all on function private.next_job_search_due_at(text,time,text,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.save_job_search_preferences(
  p_profile_id uuid,
  p_preferences jsonb,
  p_schedule_enabled boolean,
  p_timezone text,
  p_local_time time
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_cadence text;
  v_enabled boolean;
  v_next timestamptz;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_preferences) <> 'object' then raise exception 'Preferences must be a JSON object'; end if;
  if length(p_preferences::text) > 200000 then raise exception 'Preferences are too large'; end if;
  if not exists(select 1 from public.candidate_profiles where id=p_profile_id and user_id=v_user) then
    raise exception 'Profile not found';
  end if;
  perform private.assert_active_app_membership(v_user);
  v_cadence := p_preferences->>'search_cadence';
  if v_cadence is null or v_cadence not in ('daily','weekdays','weekly','manual') then raise exception 'Invalid job-search cadence'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'Choose a valid IANA timezone'; end if;
  if p_local_time is null then raise exception 'Choose a valid local search time'; end if;
  v_enabled := coalesce(p_schedule_enabled,false) and v_cadence <> 'manual';
  if v_enabled then
    v_next := private.next_job_search_due_at(v_cadence,p_local_time,p_timezone,now());
  end if;

  insert into public.candidate_preferences(profile_id,preferences,updated_at)
  values(p_profile_id,p_preferences,now())
  on conflict(profile_id) do update set preferences=excluded.preferences,updated_at=excluded.updated_at;

  insert into public.job_search_controls(user_id)
  values(v_user)
  on conflict(user_id) do nothing;

  update public.job_search_controls
     set search_schedule_enabled=v_enabled,
         search_schedule_timezone=p_timezone,
         search_schedule_time=p_local_time,
         next_scheduled_search_at=v_next,
         last_scheduled_search_error=null,
         updated_at=now()
   where user_id=v_user;

  insert into public.job_search_sources(user_id,source_key,label,source_type,base_url)
  values
    (v_user,'employer_careers','Employer career sites','employer_careers',null),
    (v_user,'live_ats','Live ATS pages','live_ats',null),
    (v_user,'quality_boards','High-quality job boards','quality_board',null)
  on conflict(user_id,source_key) do nothing;

  return jsonb_build_object(
    'enabled',v_enabled,'cadence',v_cadence,'timezone',p_timezone,
    'local_time',to_char(p_local_time,'HH24:MI'),'next_run_at',v_next
  );
end;
$$;
revoke all on function public.save_job_search_preferences(uuid,jsonb,boolean,text,time) from public,anon,service_role;
grant execute on function public.save_job_search_preferences(uuid,jsonb,boolean,text,time) to authenticated;

-- Keep the user-callable wrapper SECURITY INVOKER and narrowly granted. A
-- private owner-checked helper owns only the row lock and protected cooldown
-- timestamps, so authenticated clients cannot reset their own rate limit via
-- direct table updates.
create or replace function private.reserve_manual_job_search_window(
  p_run_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_control public.job_search_controls;
  v_existing public.job_search_runs;
  v_active record;
  v_now timestamptz := now();
  v_next timestamptz;
  v_existing_run boolean := false;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_run_id is null or nullif(btrim(coalesce(p_idempotency_key,'')),'') is null
     or length(p_idempotency_key)>200 or p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'Invalid manual-search identity';
  end if;
  insert into public.job_search_controls(user_id) values(v_user) on conflict(user_id) do nothing;
  select * into v_control from public.job_search_controls where user_id=v_user for update;
  select * into v_existing from public.job_search_runs where user_id=v_user and idempotency_key=p_idempotency_key;
  v_existing_run := found;
  if v_existing_run and v_existing.id is distinct from p_run_id then raise exception 'This idempotency key belongs to another search'; end if;

  if not v_existing_run then
    select r.id as run_id,d.id as dispatch_id,d.state as dispatch_state into v_active
      from public.job_search_runs r
      join public.chatgpt_dispatch_requests d on d.id=r.dispatch_request_id and d.user_id=r.user_id
     where r.user_id=v_user and r.state in ('queued','running')
       and d.state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','sent','acknowledged_by_mcp','running')
     order by r.requested_at desc limit 1;
    if found then
      return jsonb_build_object('ok',false,'reason','active_search','active_run_id',v_active.run_id,'active_dispatch_id',v_active.dispatch_id,
        'dispatch_state',v_active.dispatch_state,'server_now',v_now);
    end if;
  end if;

  if not v_existing_run and v_control.last_manual_idempotency_key is distinct from p_idempotency_key
     and not coalesce(v_control.manual_search_cooldown_disabled,false)
     and v_control.last_manual_search_at is not null
     and v_control.last_manual_search_at>v_now-interval '1 hour' then
    v_next := v_control.last_manual_search_at+interval '1 hour';
    return jsonb_build_object('ok',false,'reason','manual_search_cooldown','last_triggered_at',v_control.last_manual_search_at,
      'next_allowed_at',v_next,'server_now',v_now,'remaining_seconds',greatest(0,ceil(extract(epoch from (v_next-v_now))))::integer,
      'cooldown_disabled',coalesce(v_control.manual_search_cooldown_disabled,false));
  end if;
  if not v_existing_run and v_control.last_manual_idempotency_key is distinct from p_idempotency_key then
    update public.job_search_controls set last_manual_search_at=v_now,last_manual_idempotency_key=p_idempotency_key,updated_at=v_now
     where user_id=v_user returning * into v_control;
  end if;
  return jsonb_build_object('ok',true,'server_now',v_now,'cooldown_disabled',coalesce(v_control.manual_search_cooldown_disabled,false));
end;
$$;
revoke all on function private.reserve_manual_job_search_window(uuid,text) from public,anon,service_role;
grant execute on function private.reserve_manual_job_search_window(uuid,text) to authenticated;

-- Preserve the existing manual-search RPC signatures while adding the enabled
-- source snapshot to durable runs. The invoker wrapper continues to use the
-- same generic Website Bridge dispatch creator.
create or replace function public.create_manual_job_search_dispatch(
  p_run_id uuid,
  p_idempotency_key text,
  p_website_instruction text,
  p_source_keys text[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_existing public.job_search_runs;
  v_run public.job_search_runs;
  v_window jsonb;
  v_dispatch jsonb;
  v_dispatch_id uuid;
  v_source_keys text[] := '{}'::text[];
  v_existing_run boolean := false;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_run_id is null then raise exception 'A manual-search run id is required'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null
     or length(p_idempotency_key) > 200
     or p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'Invalid manual-search idempotency key';
  end if;
  if nullif(btrim(coalesce(p_website_instruction,'')),'') is null then raise exception 'A manual search instruction is required'; end if;
  if length(p_website_instruction) > 6000 then raise exception 'Website Bridge instruction is too long'; end if;

  select * into v_existing from public.job_search_runs where user_id=v_user and idempotency_key=p_idempotency_key;
  v_existing_run := found;
  if v_existing_run and v_existing.id is distinct from p_run_id then
    raise exception 'This manual-search idempotency key belongs to another run';
  end if;

  if not v_existing_run then
    select coalesce(array_agg(distinct s.source_key order by s.source_key),'{}'::text[])
      into v_source_keys
      from public.job_search_sources s
     where s.user_id=v_user and s.enabled=true
       and s.source_key=any(coalesce(p_source_keys,'{}'::text[]));
    if cardinality(v_source_keys)=0 then raise exception 'Enable at least one discovery source before searching'; end if;
    if cardinality(v_source_keys) <> (select count(distinct source_key) from unnest(coalesce(p_source_keys,'{}'::text[])) as requested(source_key)) then
      raise exception 'One or more requested discovery sources are no longer enabled';
    end if;
  else
    v_source_keys := v_existing.source_keys;
  end if;

  v_window := private.reserve_manual_job_search_window(p_run_id,p_idempotency_key);
  if v_window->>'ok'<>'true' then return v_window; end if;

  v_dispatch := public.create_chatgpt_dispatch_request_with_website_instruction(
    'jobs.search.manual','{}'::jsonb,'user_click','Run a manual job search',p_idempotency_key,90,p_website_instruction
  );
  v_dispatch_id := nullif(v_dispatch->>'id','')::uuid;
  if v_dispatch_id is null then raise exception 'The Website Bridge did not return a dispatch id'; end if;
  insert into public.job_search_runs(id,user_id,trigger,state,idempotency_key,source_keys,max_jobs,dispatch_request_id)
  values(p_run_id,v_user,'manual','queued',p_idempotency_key,v_source_keys,10,v_dispatch_id)
  on conflict(user_id,idempotency_key) do nothing;
  select * into v_run from public.job_search_runs where user_id=v_user and idempotency_key=p_idempotency_key;
  if not found or v_run.id is distinct from p_run_id or v_run.dispatch_request_id is distinct from v_dispatch_id then
    raise exception 'The manual search could not be linked to its durable run';
  end if;
  return jsonb_build_object('ok',true,'run_id',v_run.id,'dispatch',v_dispatch,
    'server_now',v_window->'server_now','cooldown_disabled',coalesce((v_window->>'cooldown_disabled')::boolean,false));
end;
$$;

revoke all on function public.create_manual_job_search_dispatch(uuid,text,text,text[]) from public,anon,service_role;
grant execute on function public.create_manual_job_search_dispatch(uuid,text,text,text[]) to authenticated;

create or replace function public.create_manual_job_search_dispatch(
  p_run_id uuid,
  p_idempotency_key text,
  p_website_instruction text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.create_manual_job_search_dispatch($1,$2,$3,
    coalesce((select array_agg(source_key order by source_key) from public.job_search_sources where user_id=(select auth.uid()) and enabled),'{}'::text[]));
$$;
revoke all on function public.create_manual_job_search_dispatch(uuid,text,text) from public,anon,service_role;
grant execute on function public.create_manual_job_search_dispatch(uuid,text,text) to authenticated;

create or replace function public.create_manual_job_search_dispatch(
  p_idempotency_key text,
  p_website_instruction text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.create_manual_job_search_dispatch(gen_random_uuid(),$1,$2);
$$;
revoke all on function public.create_manual_job_search_dispatch(text,text) from public,anon,service_role;
grant execute on function public.create_manual_job_search_dispatch(text,text) to authenticated;

create or replace function private.build_scheduled_job_search_instruction(
  p_user uuid,
  p_profile_id uuid,
  p_preferences jsonb,
  p_sources text[],
  p_run_id uuid,
  p_testing boolean
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_mode text := coalesce(p_preferences->>'search_mode','keywords_and_profile');
  v_salary jsonb := coalesce(p_preferences->'salary','{}'::jsonb);
  v_profile_summary text;
  v_prompt text;
begin
  select left(jsonb_build_object(
    'experience',coalesce((select jsonb_agg(jsonb_build_object('role',left(e.role_title,100),'employer',left(e.employer,100),'details',left(e.details,180))) from (select role_title,employer,details from public.candidate_employment where profile_id=p_profile_id and verification_status='verified' order by start_date desc nulls last limit 4) e),'[]'::jsonb),
    'education',coalesce((select jsonb_agg(jsonb_build_object('qualification',left(e.qualification,100),'institution',left(e.institution,100),'field',left(e.field_of_study,100))) from (select qualification,institution,field_of_study from public.candidate_education where profile_id=p_profile_id and verification_status='verified' order by start_date desc nulls last limit 3) e),'[]'::jsonb),
    'skills',coalesce((select jsonb_agg(jsonb_build_object('name',left(s.name,100),'proficiency',left(s.proficiency,80),'years',s.years_experience)) from (select name,proficiency,years_experience from public.candidate_skills where profile_id=p_profile_id and verification_status='verified' order by name limit 12) s),'[]'::jsonb),
    'evidence',coalesce((select jsonb_agg(jsonb_build_object('claim',left(e.claim,160),'detail',left(e.detail,140))) from (select claim,detail from public.evidence_items where profile_id=p_profile_id and verification_status='verified' order by strength desc limit 4) e),'[]'::jsonb)
  )::text,1400) into v_profile_summary;

  v_prompt := concat_ws(E'\n',
    'Run one bounded, read-only job search now. This is a one-time search, not a scheduled task.',
    'Do not create or change any ChatGPT Task or schedule. Do not apply, sign in, contact employers, or make external commitments.',
    'Search only enabled public sources, inspect each listing, deduplicate known listings, return no more than 10 distinct vacancies, preserve exact listing URLs, and do not invent missing facts. Keep every application behind human review.',
    'Profile-fit assessments must cite concrete evidence from the verified background included below. Never change the user controlled locations, salary, work modes, sponsorship, excluded industries, or posting-age constraints.',
    'This search run_id is '||p_run_id::text||'. Return exactly one JSON object and no markdown using this envelope: {"run_id":"'||p_run_id::text||'","jobs_checked":0,"summary":"short outcome","results":[]}. Each result is {"status":"found","source_url":"https://example.com/job","job":{"company":"…","title":"…","description":"at least 40 grounded characters","salary_source":"not_available","salary_basis":[],"responsibilities":[],"essential_requirements":[],"desirable_requirements":[],"skills":[],"benefits":[],"raw_metadata":{}}} or {"status":"unavailable","source_url":null,"reason":"brief reason"}. Use only these job keys: company,title,industry,description,application_url,external_job_id,location,work_mode,salary_text,salary_min,salary_max,salary_currency,salary_source,salary_confidence,salary_basis,posted_at,closes_at,employment_type,ats_provider,summary,responsibilities,essential_requirements,desirable_requirements,skills,benefits,application_instructions,company_website,raw_metadata. salary_source is exactly advertised, chatgpt_estimate, or not_available. Clearly label estimates and include salary_basis; never invent a salary. jobs_checked counts distinct listings reviewed.',
    'Role discovery: '||case when v_mode='profile' then 'infer suitable role titles, seniority and industries from the verified evidence; do not infer user constraints.' when v_mode='keywords' then 'use only the supplied keywords and role families.' else 'start with supplied keywords and use verified evidence to rank fit.' end,
    'Enabled sources: '||left(array_to_string(coalesce(p_sources,'{}'::text[]),', '),400),
    'Role keywords: '||left(coalesce(p_preferences->'target_roles','[]'::jsonb)::text,450),
    'Role families: '||left(coalesce(p_preferences->'role_families','[]'::jsonb)::text,350),
    'Target seniority: '||left(coalesce(p_preferences->>'target_seniority','not specified'),160),
    'Preferred locations: '||left(coalesce(p_preferences->'locations','[]'::jsonb)::text,400),
    'Preferred industries: '||left(coalesce(p_preferences->'preferred_industries','[]'::jsonb)::text,350),
    'Excluded industries: '||left(coalesce(p_preferences->'excluded_industries','[]'::jsonb)::text,350),
    'Work modes: '||left(coalesce(p_preferences->'work_modes','[]'::jsonb)::text,160),
    'Posting age limit in days: '||coalesce(p_preferences->'posting_age_policy'->>'max_days','30'),
    'Salary floor: '||coalesce(v_salary->>'minimum','not specified'),
    'Salary target: '||coalesce(v_salary->>'target','not specified'),
    'Salary currency: '||coalesce(v_salary->>'currency','GBP'),
    'Sponsorship required: '||case when coalesce((p_preferences->>'sponsorship_required')::boolean,false) then 'yes' else 'no' end,
    'Minimum fit score: '||coalesce(p_preferences->>'min_fit_score_10','6'),
    'Auto-prepare threshold: '||coalesce(p_preferences->>'auto_prepare_threshold','80'),
    'Other preferences: '||left(coalesce(p_preferences->>'notes',''),500),
    'Verified role-fit evidence (contact details omitted): '||coalesce(v_profile_summary,'{}')
  );
  if p_testing then
    v_prompt := 'TEST ONLY — The following message is a test. Do not add, save, or update anything from it to ChatGPT Memory or long-term memory. Treat the request below as a test and answer it without changing Memory.'||E'\n\n'||v_prompt;
  end if;
  if length(v_prompt)>6000 then raise exception 'Scheduled search instruction exceeds the Website Bridge limit'; end if;
  if v_prompt ~* '(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)' then raise exception 'Scheduled search instruction contains bridge protocol text'; end if;
  return v_prompt;
end;
$$;
revoke all on function private.build_scheduled_job_search_instruction(uuid,uuid,jsonb,text[],uuid,boolean) from public,anon,authenticated,service_role;

create or replace function public.finalize_job_search_run(
  p_run_id uuid,
  p_final_state text,
  p_jobs_checked integer default 0,
  p_found_count integer default 0,
  p_unavailable_count integer default 0,
  p_result_summary text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_run public.job_search_runs;
  v_dispatch public.chatgpt_dispatch_requests;
  v_pending integer;
  v_discovered integer;
  v_completed integer;
  v_final text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_run from public.job_search_runs where id=p_run_id and user_id=v_user for update;
  if not found then raise exception 'Manual search not found'; end if;
  if v_run.dispatch_request_id is null then raise exception 'Search run is not linked to a Website Bridge result'; end if;
  select * into v_dispatch from public.chatgpt_dispatch_requests where id=v_run.dispatch_request_id and user_id=v_user;
  if not found then raise exception 'Search dispatch not found'; end if;

  if p_final_state='completed' then
    if v_dispatch.state<>'completed' or coalesce((v_dispatch.output_refs->>'response_provenance_recorded')::boolean,false) is not true then
      raise exception 'Only a completed, provenance-verified bridge response can finish a search';
    end if;
    if p_jobs_checked<0 or p_jobs_checked>1000 or p_found_count<0 or p_found_count>10 or p_unavailable_count<0 or p_unavailable_count>10 then
      raise exception 'Search result counters are outside their allowed bounds';
    end if;
    select count(*) into v_pending from public.job_url_inspection_requests
     where user_id=v_user and batch_id=p_run_id and dispatch_request_id=v_run.dispatch_request_id
       and status not in ('completed','failed','user_required');
    if v_pending>0 then raise exception 'Captured listing results are still being saved'; end if;
    select count(*) into v_completed from public.job_url_inspection_requests
     where user_id=v_user and batch_id=p_run_id and dispatch_request_id=v_run.dispatch_request_id and status='completed';
    if v_completed<>p_found_count then raise exception 'Not every found listing has been saved'; end if;

    insert into public.job_search_run_jobs(run_id,job_id,user_id,disposition,reason)
    select p_run_id,j.id,v_user,
           case when j.discovered_at>=v_run.requested_at then 'discovered' else 'duplicate' end,
           case when j.discovered_at>=v_run.requested_at then 'Added from this captured search result.' else 'Matched an existing vacancy in the job pool.' end
      from public.job_url_inspection_requests i
      join public.jobs j on j.id=i.job_id and j.user_id=v_user
     where i.user_id=v_user and i.batch_id=p_run_id and i.dispatch_request_id=v_run.dispatch_request_id and i.status='completed'
    on conflict(run_id,job_id) do nothing;

    select count(*) into v_discovered from public.job_search_run_jobs where run_id=p_run_id and user_id=v_user and disposition='discovered';
    update public.job_search_runs set state='completed',finished_at=coalesce(finished_at,now()),
      jobs_checked=p_jobs_checked,jobs_discovered=v_discovered,
      jobs_deduped=greatest(0,p_found_count-v_discovered),jobs_accepted=0,
      summary=jsonb_build_object('result_summary',left(coalesce(p_result_summary,''),2000),'found',p_found_count,'unavailable',p_unavailable_count),
      error_json=null,updated_at=now()
     where id=p_run_id and user_id=v_user;
    v_final := 'completed';
  else
    if p_final_state not in ('failed','user_required','expired','cancelled') then raise exception 'Invalid terminal search state'; end if;
    if p_final_state='user_required' and v_dispatch.state<>'user_required' then raise exception 'Bridge request is not waiting for user action'; end if;
    if p_final_state in ('expired','cancelled') and v_dispatch.state not in ('expired','cancelled') then raise exception 'Bridge request is not terminal'; end if;
    -- A completed dispatch can still contain an invalid/mismatched payload or
    -- lack v3 provenance. Those are terminal search failures too: persisting
    -- them here avoids leaving the application run in an endless importing
    -- state while preserving the completed bridge record for diagnosis.
    if p_final_state='failed' and v_dispatch.state not in ('failed','expired','cancelled','completed') then raise exception 'Bridge request is not terminal'; end if;
    v_final := case when p_final_state in ('expired','cancelled') then 'failed' else p_final_state end;
    update public.job_search_runs set state=v_final,finished_at=coalesce(finished_at,now()),
      error_json=jsonb_build_object('message',left(coalesce(nullif(p_error_message,''),'The Website Bridge ended this search without a usable result.'),2000)),updated_at=now()
     where id=p_run_id and user_id=v_user;
  end if;
  return (select to_jsonb(r)-'user_id' from public.job_search_runs r where r.id=p_run_id and r.user_id=v_user);
end;
$$;
revoke all on function public.finalize_job_search_run(uuid,text,integer,integer,integer,text,text) from public,anon,service_role;
grant execute on function public.finalize_job_search_run(uuid,text,integer,integer,integer,text,text) to authenticated;

create or replace function private.dispatch_due_job_searches()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due record;
  v_count integer := 0;
  v_original_sub text := coalesce(current_setting('request.jwt.claim.sub',true),'');
  v_sources text[];
  v_source_keys text[];
  v_run_id uuid;
  v_dispatch jsonb;
  v_dispatch_id uuid;
  v_window_key text;
  v_instruction text;
  v_next timestamptz;
  v_preferences jsonb;
  v_profile_id uuid;
  v_testing boolean;
begin
  for v_due in
    select c.user_id,c.next_scheduled_search_at,c.search_schedule_timezone,c.search_schedule_time,
           cp.preferences,p.id as profile_id
      from public.job_search_controls c
      join public.candidate_profiles p on p.user_id=c.user_id
      join public.candidate_preferences cp on cp.profile_id=p.id
     where c.search_schedule_enabled=true and c.next_scheduled_search_at<=now()
       and coalesce(cp.preferences->>'search_cadence','daily') in ('daily','weekdays','weekly')
     order by c.next_scheduled_search_at
     limit 25
     for update of c skip locked
  loop
    begin
      v_preferences := v_due.preferences;
      v_profile_id := v_due.profile_id;
      v_window_key := 'scheduled:'||v_due.user_id::text||':'||to_char(v_due.next_scheduled_search_at at time zone 'UTC','YYYYMMDDHH24MI');
      select id into v_run_id from public.job_search_runs where user_id=v_due.user_id and idempotency_key=v_window_key;
      if v_run_id is not null then
        v_next := private.next_job_search_due_at(v_preferences->>'search_cadence',v_due.search_schedule_time,v_due.search_schedule_timezone,now());
        update public.job_search_controls set next_scheduled_search_at=v_next,last_scheduled_search_error=null,updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;

      if exists(
        select 1
          from public.job_search_runs r
          join public.chatgpt_dispatch_requests d on d.id=r.dispatch_request_id and d.user_id=r.user_id
         where r.user_id=v_due.user_id and r.state in ('queued','running')
           and d.state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','sent','acknowledged_by_mcp','running')
      ) then
        update public.job_search_controls set last_scheduled_search_error='A previous bridge search is still active. The scheduled run will wait to avoid duplicate work.',updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;

      insert into public.job_search_sources(user_id,source_key,label,source_type,base_url)
      values
        (v_due.user_id,'employer_careers','Employer career sites','employer_careers',null),
        (v_due.user_id,'live_ats','Live ATS pages','live_ats',null),
        (v_due.user_id,'quality_boards','High-quality job boards','quality_board',null)
      on conflict(user_id,source_key) do nothing;
      select coalesce(array_agg(source_key order by source_key) filter(where enabled),'{}'::text[]),
             coalesce(array_agg(label order by source_key) filter(where enabled),'{}'::text[])
        into v_source_keys,v_sources from public.job_search_sources where user_id=v_due.user_id;
      if cardinality(v_source_keys)=0 then
        update public.job_search_controls set last_scheduled_search_error='No discovery sources are enabled. Enable at least one source in Search settings.',
          next_scheduled_search_at=now()+interval '15 minutes',updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;

      select coalesce(testing_mode_enabled,false) into v_testing from public.job_search_controls where user_id=v_due.user_id;
      v_run_id := gen_random_uuid();
      v_instruction := private.build_scheduled_job_search_instruction(v_due.user_id,v_profile_id,v_preferences,v_sources,v_run_id,v_testing);
      v_next := private.next_job_search_due_at(v_preferences->>'search_cadence',v_due.search_schedule_time,v_due.search_schedule_timezone,now());
      perform set_config('request.jwt.claim.sub',v_due.user_id::text,true);
      v_dispatch := public.create_chatgpt_dispatch_request_with_website_instruction(
        'jobs.search.manual','{}'::jsonb,'explicit_automation','Scheduled job search',v_window_key,65,v_instruction
      );
      v_dispatch_id := nullif(v_dispatch->>'id','')::uuid;
      if v_dispatch_id is null then raise exception 'Generic Website Bridge dispatch did not return a request id'; end if;

      insert into public.job_search_runs(id,user_id,trigger,state,idempotency_key,source_keys,max_jobs,dispatch_request_id,next_run_at)
      values(v_run_id,v_due.user_id,'scheduled','queued',v_window_key,v_source_keys,10,v_dispatch_id,v_next);
      update public.job_search_controls set next_scheduled_search_at=v_next,last_scheduled_search_at=now(),
        last_scheduled_window_key=v_window_key,last_scheduled_search_error=null,updated_at=now() where user_id=v_due.user_id;
      v_count := v_count+1;
      perform set_config('request.jwt.claim.sub',v_original_sub,true);
    exception when others then
      perform set_config('request.jwt.claim.sub',v_original_sub,true);
      update public.job_search_controls set last_scheduled_search_error=left(sqlerrm,2000),
        next_scheduled_search_at=now()+interval '15 minutes',updated_at=now() where user_id=v_due.user_id;
    end;
  end loop;
  perform set_config('request.jwt.claim.sub',v_original_sub,true);
  return v_count;
end;
$$;
revoke all on function private.dispatch_due_job_searches() from public,anon,authenticated,service_role;

select cron.schedule(
  'job-search-dispatch-due-runs',
  '* * * * *',
  'select private.dispatch_due_job_searches()'
);

comment on column public.job_search_controls.next_scheduled_search_at is
  'Next due app-owned search. The Cron worker enqueues a normal generic Website Bridge dispatch; the browser helper must be online to deliver it.';
