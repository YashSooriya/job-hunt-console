-- Durable, owner-scoped fit analysis. This is independent of the Website
-- Bridge dispatch contract and does not change any existing bridge grants.

alter table public.jobs
  add column if not exists analysis_revision bigint not null default 1;
alter table public.candidate_profiles
  add column if not exists analysis_revision bigint not null default 1;
alter table public.job_analyses
  add column if not exists engine_version text not null default 'legacy-v1',
  add column if not exists job_revision bigint,
  add column if not exists profile_revision bigint,
  add column if not exists input_hash text,
  add column if not exists assessment_as_of timestamptz;

create or replace function private.bump_job_analysis_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.analysis_revision is distinct from old.analysis_revision then
    new.analysis_revision := old.analysis_revision + 1;
  elsif (new.company_id, new.title, new.industry, new.external_job_id, new.source_url, new.application_url,
      new.location_text, new.work_mode, new.salary_text, new.salary_min, new.salary_max,
      new.salary_currency, new.posted_at, new.closes_at, new.employment_type,
      new.ats_provider, new.discovery_source, new.current_snapshot_id)
     is distinct from
     (old.company_id, old.title, old.industry, old.external_job_id, old.source_url, old.application_url,
      old.location_text, old.work_mode, old.salary_text, old.salary_min, old.salary_max,
      old.salary_currency, old.posted_at, old.closes_at, old.employment_type,
      old.ats_provider, old.discovery_source, old.current_snapshot_id) then
    new.analysis_revision := old.analysis_revision + 1;
  else
    new.analysis_revision := old.analysis_revision;
  end if;
  return new;
end;
$$;
revoke all on function private.bump_job_analysis_revision() from public, anon, authenticated, service_role;
drop trigger if exists jobs_bump_analysis_revision on public.jobs;
create trigger jobs_bump_analysis_revision before update on public.jobs
for each row execute function private.bump_job_analysis_revision();

create or replace function private.bump_job_analysis_revision_from_company_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.canonical_name is distinct from old.canonical_name then
    update public.jobs set analysis_revision=analysis_revision+1 where company_id=new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.bump_job_analysis_revision_from_company_update() from public, anon, authenticated, service_role;
drop trigger if exists companies_bump_job_analysis_revision on public.companies;
create trigger companies_bump_job_analysis_revision after update of canonical_name on public.companies
for each row execute function private.bump_job_analysis_revision_from_company_update();

create or replace function private.bump_job_analysis_revision_from_snapshot_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.description_text,new.company_name) is distinct from (old.description_text,old.company_name) then
    update public.jobs set analysis_revision=analysis_revision+1
     where id=new.job_id and current_snapshot_id=new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.bump_job_analysis_revision_from_snapshot_update() from public, anon, authenticated, service_role;
drop trigger if exists current_snapshot_bump_job_analysis_revision on public.job_snapshots;
create trigger current_snapshot_bump_job_analysis_revision after update of description_text,company_name on public.job_snapshots
for each row execute function private.bump_job_analysis_revision_from_snapshot_update();

create or replace function private.bump_profile_analysis_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid;
begin
  if tg_op = 'DELETE' then
    v_profile_id := old.profile_id;
  else
    v_profile_id := new.profile_id;
  end if;
  update public.candidate_profiles
     set analysis_revision = analysis_revision + 1
   where id = v_profile_id;
  if tg_op = 'UPDATE' and new.profile_id is distinct from old.profile_id then
    update public.candidate_profiles set analysis_revision=analysis_revision+1 where id=old.profile_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.bump_profile_analysis_revision() from public, anon, authenticated, service_role;
drop trigger if exists candidate_facts_bump_analysis_revision on public.candidate_facts;
create trigger candidate_facts_bump_analysis_revision after insert or update or delete on public.candidate_facts
for each row execute function private.bump_profile_analysis_revision();
drop trigger if exists evidence_items_bump_analysis_revision on public.evidence_items;
create trigger evidence_items_bump_analysis_revision after insert or update or delete on public.evidence_items
for each row execute function private.bump_profile_analysis_revision();
drop trigger if exists candidate_preferences_bump_analysis_revision on public.candidate_preferences;
create trigger candidate_preferences_bump_analysis_revision after insert or update or delete on public.candidate_preferences
for each row execute function private.bump_profile_analysis_revision();
drop trigger if exists candidate_employment_bump_analysis_revision on public.candidate_employment;
create trigger candidate_employment_bump_analysis_revision after insert or update or delete on public.candidate_employment
for each row execute function private.bump_profile_analysis_revision();
drop trigger if exists candidate_education_bump_analysis_revision on public.candidate_education;
create trigger candidate_education_bump_analysis_revision after insert or update or delete on public.candidate_education
for each row execute function private.bump_profile_analysis_revision();
drop trigger if exists candidate_skills_bump_analysis_revision on public.candidate_skills;
create trigger candidate_skills_bump_analysis_revision after insert or update or delete on public.candidate_skills
for each row execute function private.bump_profile_analysis_revision();
drop trigger if exists candidate_projects_bump_analysis_revision on public.candidate_projects;
create trigger candidate_projects_bump_analysis_revision after insert or update or delete on public.candidate_projects
for each row execute function private.bump_profile_analysis_revision();
drop trigger if exists candidate_publications_bump_analysis_revision on public.candidate_publications;
create trigger candidate_publications_bump_analysis_revision after insert or update or delete on public.candidate_publications
for each row execute function private.bump_profile_analysis_revision();
create or replace function private.bump_profile_analysis_revision_on_profile_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.display_name is distinct from old.display_name then
    new.analysis_revision := old.analysis_revision + 1;
  elsif new.analysis_revision is distinct from old.analysis_revision then
    new.analysis_revision := old.analysis_revision + 1;
  else
    new.analysis_revision := old.analysis_revision;
  end if;
  return new;
end;
$$;
revoke all on function private.bump_profile_analysis_revision_on_profile_update() from public, anon, authenticated, service_role;
drop trigger if exists candidate_profiles_bump_analysis_revision on public.candidate_profiles;
create trigger candidate_profiles_bump_analysis_revision before update on public.candidate_profiles
for each row execute function private.bump_profile_analysis_revision_on_profile_update();

create table public.job_analysis_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  mode text not null check (mode in ('pending','selected','outdated','retry','automatic')),
  state text not null default 'queued' check (state in ('queued','processing','completed','partial','cancelled')),
  requested_job_ids uuid[] not null default '{}',
  requested_count integer not null default 0 check (requested_count >= 0),
  reused_count integer not null default 0 check (reused_count >= 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (user_id, request_id)
);

create table public.job_analysis_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null references public.job_analysis_batches(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  state text not null default 'queued' check (state in ('queued','running','completed','needs_user','failed','cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  job_revision bigint not null,
  profile_revision bigint not null,
  assessment_as_of timestamptz not null default date_trunc('milliseconds',now()),
  lease_token uuid,
  lease_expires_at timestamptz,
  analysis_id uuid references public.job_analyses(id) on delete set null,
  error_json jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (batch_id, job_id)
);

create index job_analysis_batches_owner_recent on public.job_analysis_batches(user_id, created_at desc);
create index job_analysis_tasks_claim on public.job_analysis_tasks(state, created_at) where state in ('queued','running');
create index job_analysis_tasks_owner_recent on public.job_analysis_tasks(user_id, created_at desc);
create unique index job_analysis_tasks_one_active_per_job
  on public.job_analysis_tasks(user_id, job_id) where state in ('queued','running');

alter table public.job_analysis_batches enable row level security;
alter table public.job_analysis_tasks enable row level security;
revoke all on table public.job_analysis_batches, public.job_analysis_tasks from public, anon, authenticated, service_role;
create policy job_analysis_batches_owner_select on public.job_analysis_batches
  for select to authenticated using ((select auth.uid()) = user_id and private.current_user_active_member());
create policy job_analysis_tasks_owner_select on public.job_analysis_tasks
  for select to authenticated using ((select auth.uid()) = user_id and private.current_user_active_member());
grant select on public.job_analysis_batches, public.job_analysis_tasks to authenticated;

create or replace function private.create_job_analysis_batch(
  p_request_id uuid, p_mode text, p_job_ids uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_profile public.candidate_profiles;
  v_batch public.job_analysis_batches;
  v_ids uuid[];
  v_inserted_count integer;
  v_reused_count integer;
  v_mode text := p_mode;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_request_id is null or v_mode is null or v_mode not in ('pending','selected','outdated','retry') then
    raise exception 'Invalid analysis batch request';
  end if;
  select * into v_profile from public.candidate_profiles where user_id=v_user;
  if not found then raise exception 'Complete your profile before analysing jobs'; end if;

  if v_mode='selected' then
    if coalesce(cardinality(p_job_ids),0)<1 or cardinality(p_job_ids)>100 then
      raise exception 'Select between 1 and 100 jobs';
    end if;
    if (select count(distinct x) from unnest(p_job_ids) x) <> cardinality(p_job_ids)
       or (select count(*) from public.jobs j where j.user_id=v_user and j.id=any(p_job_ids)) <> cardinality(p_job_ids) then
      raise exception 'One or more selected jobs are unavailable';
    end if;
    select array_agg(x order by x) into v_ids from unnest(p_job_ids) x;
  elsif v_mode='pending' then
    select coalesce(array_agg(j.id order by j.discovered_at desc,j.id), '{}') into v_ids
      from public.jobs j
     where j.user_id=v_user and j.archived_at is null
       and not exists(select 1 from public.job_analyses a where a.job_id=j.id);
  elsif v_mode='outdated' then
    select coalesce(array_agg(j.id order by j.discovered_at desc,j.id), '{}') into v_ids
      from public.jobs j
      left join lateral (
        select a.engine_version,a.job_revision,a.profile_revision,a.input_hash,a.assessment_as_of
          from public.job_analyses a where a.job_id=j.id order by a.created_at desc,a.id desc limit 1
     ) a on true
     where j.user_id=v_user and j.archived_at is null
       and a.engine_version is not null
       and (a.engine_version is distinct from 'job-fit-v2'
         or a.job_revision is distinct from j.analysis_revision
         or a.profile_revision is distinct from v_profile.analysis_revision
         or coalesce(a.input_hash,'') !~ '^[0-9a-f]{64}$'
         or a.assessment_as_of is null);
  else
    select coalesce(array_agg(distinct t.job_id order by t.job_id), '{}') into v_ids
      from public.job_analysis_tasks t join public.jobs j on j.id=t.job_id
     where t.user_id=v_user and t.state='failed' and j.archived_at is null
       and not exists(select 1 from public.job_analysis_tasks active
         where active.user_id=v_user and active.job_id=j.id and active.state in ('queued','running'))
       and not exists(select 1 from public.job_analyses ja_current
         where ja_current.job_id=j.id and ja_current.engine_version='job-fit-v2'
           and ja_current.job_revision=j.analysis_revision and ja_current.profile_revision=v_profile.analysis_revision
           and ja_current.input_hash ~ '^[0-9a-f]{64}$' and ja_current.assessment_as_of is not null);
  end if;

  select * into v_batch from public.job_analysis_batches
   where user_id=v_user and request_id=p_request_id;
  if found then
    if v_batch.mode is distinct from v_mode
       or (v_mode='selected' and v_batch.requested_job_ids is distinct from v_ids) then
      raise exception 'Request id was already used for a different analysis batch';
    end if;
    return jsonb_build_object('batch_id',v_batch.id,'state',v_batch.state,'requested_count',v_batch.requested_count,'reused_count',v_batch.reused_count,'idempotent',true);
  end if;

  insert into public.job_analysis_batches(user_id,request_id,mode,requested_job_ids,requested_count)
  values(v_user,p_request_id,v_mode,v_ids,cardinality(v_ids)) returning * into v_batch;

  insert into public.job_analysis_tasks(user_id,batch_id,job_id,job_revision,profile_revision,assessment_as_of)
  select v_user,v_batch.id,j.id,j.analysis_revision,v_profile.analysis_revision,date_trunc('milliseconds',now())
    from public.jobs j where j.id=any(v_ids) and j.user_id=v_user
  on conflict (user_id,job_id) where state in ('queued','running') do nothing;
  get diagnostics v_inserted_count = row_count;
  v_reused_count := greatest(0,cardinality(v_ids)-v_inserted_count);
  update public.job_analysis_batches set reused_count=v_reused_count where id=v_batch.id;
  if v_inserted_count=0 then
    update public.job_analysis_batches set state=case when v_reused_count>0 then 'processing' else 'completed' end,
      finished_at=case when v_reused_count>0 then null else now() end where id=v_batch.id;
  end if;
  return jsonb_build_object('batch_id',v_batch.id,'state',case when v_inserted_count=0 and v_reused_count>0 then 'processing' when v_inserted_count=0 then 'completed' else 'queued' end,
    'requested_count',cardinality(v_ids),'queued_count',v_inserted_count,'reused_count',v_reused_count,'idempotent',false);
end;
$$;
revoke all on function private.create_job_analysis_batch(uuid,text,uuid[]) from public, anon, authenticated, service_role;

create or replace function public.create_job_analysis_batch(p_request_id uuid,p_mode text,p_job_ids uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  return private.create_job_analysis_batch($1,$2,$3);
end;
$$;
revoke all on function public.create_job_analysis_batch(uuid,text,uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.create_job_analysis_batch(uuid,text,uuid[]) to authenticated;

create or replace function private.claim_job_analysis_tasks(p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_claimed jsonb;
begin
  if coalesce(p_limit,0) < 1 or p_limit > 5 then raise exception 'Claim size must be 1 to 5'; end if;
  update public.job_analysis_tasks t set state='needs_user',lease_token=null,lease_expires_at=null,
    error_json=jsonb_build_object('message','Your profile is unavailable; finish onboarding before analysing jobs.'),
    finished_at=now(),updated_at=now()
   where t.state in ('queued','running') and not exists(select 1 from public.candidate_profiles p where p.user_id=t.user_id);
  update public.job_analysis_tasks set state='failed',lease_token=null,lease_expires_at=null,
    error_json=jsonb_build_object('message','Analysis exceeded its retry limit; retry this batch.'),
    finished_at=now(),updated_at=now()
   where state='running' and lease_expires_at < now() and attempt_count >= 4;
  with candidates as (
    select t.id from public.job_analysis_tasks t
     where (t.state='queued' or (t.state='running' and t.lease_expires_at < now()))
       and t.attempt_count < 4
     order by t.created_at,t.id for update skip locked limit p_limit
  ), claimed as (
    update public.job_analysis_tasks t set state='running',attempt_count=t.attempt_count+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',
      started_at=coalesce(t.started_at,now()),updated_at=now(),error_json=null
      from candidates c where t.id=c.id
      returning t.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'task_id',t.id,'batch_id',t.batch_id,'user_id',t.user_id,'job_id',t.job_id,
    'lease_token',t.lease_token,'attempt_count',t.attempt_count,'job_revision',t.job_revision,
    'profile_revision',t.profile_revision,'assessment_as_of',t.assessment_as_of,
    'job',jsonb_build_object('company',coalesce(c.canonical_name,s.company_name,'Unknown company'),
      'title',j.title,'industry',j.industry,'description',s.description_text,'externalJobId',j.external_job_id,
      'sourceUrl',j.source_url,'applicationUrl',j.application_url,'location',j.location_text,'workMode',j.work_mode,
      'salaryText',j.salary_text,'salaryMin',j.salary_min,'salaryMax',j.salary_max,'salaryCurrency',coalesce(j.salary_currency,'GBP'),
      'postedAt',j.posted_at,'closesAt',j.closes_at,'employmentType',j.employment_type,'atsProvider',j.ats_provider,
      'discoverySource',j.discovery_source),
    'profile',jsonb_build_object('displayName',p.display_name,
      'facts',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'factKey',f.fact_key,'value',f.value_json,'status',f.verification_status) order by f.fact_key,f.id) from public.candidate_facts f where f.profile_id=p.id),'[]'::jsonb),
      'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'evidenceKey',e.evidence_key,'category',e.category,'claim',e.claim,'detail',e.detail,'tags',e.tags,'strength',e.strength,'status',e.verification_status) order by e.evidence_key,e.id) from public.evidence_items e where e.profile_id=p.id and e.verification_status<>'rejected'),'[]'::jsonb),
      'preferences',coalesce((select cp.preferences from public.candidate_preferences cp where cp.profile_id=p.id),'{}'::jsonb),
      'sources','[]'::jsonb,'structured',jsonb_build_object('employment','[]'::jsonb,'education','[]'::jsonb,'skills','[]'::jsonb,'projects','[]'::jsonb,'publications','[]'::jsonb))
    )),'[]'::jsonb) into v_claimed
    from claimed t join public.jobs j on j.id=t.job_id
    left join public.companies c on c.id=j.company_id
    left join public.job_snapshots s on s.id=j.current_snapshot_id
    join public.candidate_profiles p on p.user_id=t.user_id;
  update public.job_analysis_batches b set state='processing',started_at=coalesce(started_at,now())
   where b.id in (select (x->>'batch_id')::uuid from jsonb_array_elements(v_claimed) x)
     and b.state='queued';
  return v_claimed;
end;
$$;
revoke all on function private.claim_job_analysis_tasks(integer) from public, anon, authenticated, service_role;
grant execute on function private.claim_job_analysis_tasks(integer) to service_role;
create or replace function public.claim_job_analysis_tasks(p_limit integer default 5)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin return private.claim_job_analysis_tasks($1); end;
$$;
revoke all on function public.claim_job_analysis_tasks(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_job_analysis_tasks(integer) to service_role;

create or replace function private.finish_job_analysis_task(
  p_task_id uuid,p_lease_token uuid,p_analysis jsonb,p_input_hash text,p_engine_version text,p_error text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_task public.job_analysis_tasks;
  v_job public.jobs;
  v_profile public.candidate_profiles;
  v_analysis_id uuid;
  v_requirement jsonb;
  v_job_found boolean := false;
  v_profile_found boolean := false;
  v_task_state text;
begin
  select * into v_task from public.job_analysis_tasks where id=p_task_id for update;
  if not found or v_task.state<>'running' or v_task.lease_token is distinct from p_lease_token
     or v_task.lease_expires_at < now() then
    raise exception 'Analysis task lease is no longer current';
  end if;
  select * into v_job from public.jobs where id=v_task.job_id and user_id=v_task.user_id for update;
  v_job_found := found;
  select * into v_profile from public.candidate_profiles where user_id=v_task.user_id for update;
  v_profile_found := found;
  if not v_job_found or not v_profile_found then
    update public.job_analysis_tasks set state='needs_user',lease_token=null,lease_expires_at=null,
      error_json=jsonb_build_object('message','The job or profile is no longer available. Restore the profile or re-add the listing before analysing.'),
      finished_at=now(),updated_at=now() where id=v_task.id;
    update public.job_analysis_batches set state='partial',finished_at=now() where id=v_task.batch_id;
    return jsonb_build_object('state','needs_user','reason','inputs_unavailable');
  end if;
  if v_job.analysis_revision is distinct from v_task.job_revision
     or v_profile.analysis_revision is distinct from v_task.profile_revision then
    update public.job_analysis_tasks set state='queued',job_revision=v_job.analysis_revision,
      profile_revision=v_profile.analysis_revision,attempt_count=0,lease_token=null,
      lease_expires_at=null,assessment_as_of=date_trunc('milliseconds',now()),error_json=jsonb_build_object('message','Inputs changed while analysis was running; queued again.'),updated_at=now()
     where id=v_task.id;
    update public.job_analysis_batches set state='processing',finished_at=null where id=v_task.batch_id;
    return jsonb_build_object('state','queued','reason','inputs_changed');
  end if;
  if p_error is not null then
    v_task_state := case when left(p_error,11)='needs_user:' then 'needs_user' when v_task.attempt_count<4 then 'queued' else 'failed' end;
    update public.job_analysis_tasks set state=v_task_state,
      lease_token=null,lease_expires_at=null,error_json=jsonb_build_object('message',left(p_error,1000)),
      finished_at=case when v_task_state in ('failed','needs_user') then now() else null end,updated_at=now() where id=v_task.id;
    update public.job_analysis_batches b set state=case
        when exists(select 1 from public.job_analysis_tasks t where t.batch_id=b.id and t.state in ('queued','running')) then 'processing'
        when exists(select 1 from public.job_analysis_tasks t where t.batch_id=b.id and t.state in ('failed','needs_user')) then 'partial'
        else 'completed' end,
      finished_at=case when exists(select 1 from public.job_analysis_tasks t where t.batch_id=b.id and t.state in ('queued','running')) then null else now() end
     where b.id=v_task.batch_id;
    return jsonb_build_object('state',v_task_state);
  end if;
  if jsonb_typeof(p_analysis) is distinct from 'object' or length(coalesce(p_input_hash,''))<>64
     or p_engine_version is distinct from 'job-fit-v2'
     or nullif(p_analysis->>'fitScore','') is null or nullif(p_analysis->>'priorityScore','') is null
     or coalesce(p_input_hash,'') !~ '^[0-9a-f]{64}$'
     or coalesce(p_analysis->>'eligibility','') not in ('eligible','eligible_with_concerns','unknown','ineligible')
     or coalesce(p_analysis->>'triage','') not in ('auto_prepare','recommend','maybe','reject')
     or coalesce(p_analysis->>'recommendedCvFamily','') not in ('simulation_cae','scientific_software','quantitative_data','motorsport')
     or coalesce(p_analysis->>'coverLetterValue','') not in ('high','medium','low','not_accepted')
     or jsonb_typeof(coalesce(p_analysis->'requirements','[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(coalesce(p_analysis->'strengths','[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(coalesce(p_analysis->'weaknesses','[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(coalesce(p_analysis->'eligibilityNotes','[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(coalesce(p_analysis->'evidenceIds','[]'::jsonb)) is distinct from 'array' then
    raise exception 'Analysis result failed validation';
  end if;
  insert into public.job_analyses(job_id,model,contract_version,eligibility,eligibility_notes,fit_score,priority_score,
    fit_components,priority_components,recommended_cv_family,strengths,weaknesses,application_strategy,
    cover_letter_value,evidence_item_ids,analysis_source,triage,triage_reason,engine_version,job_revision,
    profile_revision,input_hash,assessment_as_of)
  values(v_job.id,null,coalesce(p_analysis->>'contractVersion','1.0.0'),
    (p_analysis->>'eligibility')::public.eligibility_state,
    coalesce(array(select jsonb_array_elements_text(p_analysis->'eligibilityNotes')),'{}'),
    greatest(0,least(100,(p_analysis->>'fitScore')::numeric)),greatest(0,least(100,(p_analysis->>'priorityScore')::numeric)),
    coalesce(p_analysis->'fitComponents','{}'),coalesce(p_analysis->'priorityComponents','{}'),
    (p_analysis->>'recommendedCvFamily')::public.cv_family,coalesce(p_analysis->'strengths','[]'),
    coalesce(p_analysis->'weaknesses','[]'),coalesce(p_analysis->>'applicationStrategy',''),
    coalesce(p_analysis->>'coverLetterValue','low'),
    coalesce(array(select x::uuid from jsonb_array_elements_text(p_analysis->'evidenceIds') x where x ~* '^[0-9a-f-]{36}$'),'{}'),
    'deterministic_v2',(p_analysis->>'triage')::public.job_triage,coalesce(p_analysis->>'triageReason',''),
    p_engine_version,v_task.job_revision,v_task.profile_revision,p_input_hash,v_task.assessment_as_of)
  returning id into v_analysis_id;
  for v_requirement in select value from jsonb_array_elements(coalesce(p_analysis->'requirements','[]'::jsonb)) loop
    if nullif(left(coalesce(v_requirement->>'text',''),2000),'') is null then continue; end if;
    insert into public.job_requirements(job_id,analysis_id,requirement_text,requirement_type,category,evidence_item_ids,match_score)
    values(v_job.id,v_analysis_id,left(coalesce(v_requirement->>'text',''),2000),
      case when v_requirement->>'type' in ('essential','desirable','context','eligibility') then v_requirement->>'type' else 'context' end,
      nullif(v_requirement->>'category',''),
      coalesce(array(select x::uuid from jsonb_array_elements_text(v_requirement->'evidenceIds') x where x ~* '^[0-9a-f-]{36}$'),'{}'),
      greatest(0,least(100,coalesce((v_requirement->>'matchScore')::integer,0))));
  end loop;
  update public.jobs set triage=nullif(p_analysis->>'triage','')::public.job_triage,
    triage_reason=left(coalesce(p_analysis->>'triageReason',''),1000),updated_at=now() where id=v_job.id;
  update public.job_analysis_tasks set state='completed',analysis_id=v_analysis_id,lease_token=null,
    lease_expires_at=null,error_json=null,finished_at=now(),updated_at=now() where id=v_task.id;
  update public.job_analysis_batches b set state=case
      when exists(select 1 from public.job_analysis_tasks t where t.batch_id=b.id and t.state in ('queued','running')) then 'processing'
      when exists(select 1 from public.job_analysis_tasks t where t.batch_id=b.id and t.state in ('failed','needs_user')) then 'partial'
      else 'completed' end,
    finished_at=case when exists(select 1 from public.job_analysis_tasks t where t.batch_id=b.id and t.state in ('queued','running')) then null else now() end
   where b.id=v_task.batch_id;
  return jsonb_build_object('state','completed','analysis_id',v_analysis_id);
end;
$$;
revoke all on function private.finish_job_analysis_task(uuid,uuid,jsonb,text,text,text) from public, anon, authenticated, service_role;
grant execute on function private.finish_job_analysis_task(uuid,uuid,jsonb,text,text,text) to service_role;
create or replace function public.finish_job_analysis_task(p_task_id uuid,p_lease_token uuid,p_analysis jsonb,p_input_hash text,p_engine_version text,p_error text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin return private.finish_job_analysis_task($1,$2,$3,$4,$5,$6); end;
$$;
revoke all on function public.finish_job_analysis_task(uuid,uuid,jsonb,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.finish_job_analysis_task(uuid,uuid,jsonb,text,text,text) to service_role;

create or replace function public.get_job_analysis_batch(p_batch_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_batch public.job_analysis_batches;
  v_profile_revision bigint;
  v_counts jsonb;
  v_issues jsonb;
  v_state text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select * into v_batch from public.job_analysis_batches b
   where b.id=p_batch_id and b.user_id=(select auth.uid());
  if not found then raise exception 'Analysis batch not found'; end if;
  select p.analysis_revision into v_profile_revision from public.candidate_profiles p
   where p.user_id=(select auth.uid());

  with requested as (
    select unnest(v_batch.requested_job_ids) as job_id
  ), classified as (
    select r.job_id,j.title,a.created_at,
      case
        when j.id is null then 'unavailable'
        when own_task.state='completed' then 'completed'
        when active.state='running' then 'running'
        when active.state='queued' then 'queued'
        when a.id is not null then 'completed'
        when own_task.state='needs_user' then 'needs_user'
        when own_task.state='failed' then 'failed'
        when terminal.state='needs_user' then 'needs_user'
        when terminal.state='failed' then 'failed'
        else 'queued'
      end as task_state,
      coalesce(terminal.error_json->>'message','') as error_message
    from requested r
    left join public.jobs j on j.id=r.job_id
    left join lateral (
      select ja.id from public.job_analyses ja
       where ja.job_id=j.id and ja.engine_version='job-fit-v2'
         and ja.job_revision=j.analysis_revision and ja.profile_revision=v_profile_revision
         and ja.input_hash ~ '^[0-9a-f]{64}$' and ja.assessment_as_of is not null
       order by ja.created_at desc,ja.id desc limit 1
    ) a on true
    left join lateral (
      select t.state from public.job_analysis_tasks t
       where t.batch_id=v_batch.id and t.job_id=r.job_id
       order by t.updated_at desc,t.id desc limit 1
    ) own_task on true
    left join lateral (
      select t.state from public.job_analysis_tasks t
       where t.user_id=(select auth.uid()) and t.job_id=r.job_id and t.state in ('queued','running')
       order by t.updated_at desc,t.id desc limit 1
    ) active on true
    left join lateral (
      select t.state,t.error_json from public.job_analysis_tasks t
       where t.user_id=(select auth.uid()) and t.job_id=r.job_id and t.state in ('failed','needs_user')
       order by t.updated_at desc,t.id desc limit 1
    ) terminal on true
  )
  select jsonb_build_object(
    'total',count(*),
    'completed',count(*) filter(where task_state='completed'),
    'queued',count(*) filter(where task_state='queued'),
    'running',count(*) filter(where task_state='running'),
    'failed',count(*) filter(where task_state='failed'),
    'needs_user',count(*) filter(where task_state='needs_user'),
    'unavailable',count(*) filter(where task_state='unavailable'),
    'reused',v_batch.reused_count
  ),
  coalesce((select jsonb_agg(jsonb_build_object('job_id',issue.job_id,'title',issue.title,
    'state',issue.task_state,'message',nullif(issue.error_message,'')) order by issue.title,issue.job_id)
    from (select job_id,title,task_state,error_message from classified
      where task_state in ('failed','needs_user','unavailable') order by title,job_id limit 20) issue),'[]'::jsonb)
  into v_counts,v_issues from classified;

  v_state := case
    when coalesce((v_counts->>'queued')::integer,0)>0 and coalesce((v_counts->>'running')::integer,0)=0 then 'queued'
    when coalesce((v_counts->>'queued')::integer,0)>0 or coalesce((v_counts->>'running')::integer,0)>0 then 'processing'
    when coalesce((v_counts->>'failed')::integer,0)>0 or coalesce((v_counts->>'needs_user')::integer,0)>0 or coalesce((v_counts->>'unavailable')::integer,0)>0 then 'partial'
    else 'completed' end;
  return jsonb_build_object('batch_id',v_batch.id,'mode',v_batch.mode,'state',v_state,
    'requested_count',v_batch.requested_count,'counts',v_counts,'issues',v_issues,
    'created_at',v_batch.created_at,'started_at',v_batch.started_at,'finished_at',v_batch.finished_at);
end;
$$;
revoke all on function public.get_job_analysis_batch(uuid) from public,anon,service_role;
grant execute on function public.get_job_analysis_batch(uuid) to authenticated;

create or replace function public.get_retryable_job_analysis_count()
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_profile_revision bigint; v_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select p.analysis_revision into v_profile_revision from public.candidate_profiles p where p.user_id=v_user;
  if not found then return 0; end if;
  select count(distinct t.job_id)::integer into v_count
    from public.job_analysis_tasks t join public.jobs j on j.id=t.job_id
   where t.user_id=v_user and t.state='failed' and j.archived_at is null
     and not exists(select 1 from public.job_analysis_tasks active
       where active.user_id=v_user and active.job_id=j.id and active.state in ('queued','running'))
     and not exists(select 1 from public.job_analyses ja_current
       where ja_current.job_id=j.id and ja_current.engine_version='job-fit-v2'
         and ja_current.job_revision=j.analysis_revision and ja_current.profile_revision=v_profile_revision
         and ja_current.input_hash ~ '^[0-9a-f]{64}$' and ja_current.assessment_as_of is not null);
  return coalesce(v_count,0);
end;
$$;
revoke all on function public.get_retryable_job_analysis_count() from public, anon, authenticated, service_role;
grant execute on function public.get_retryable_job_analysis_count() to authenticated;

create or replace function private.enqueue_imported_job_analysis()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_job_id uuid; v_profile public.candidate_profiles; v_batch public.job_analysis_batches; v_inserted_count integer;
begin
  if new.status <> 'completed' or old.status='completed' or new.job_id is null then return new; end if;
  v_owner := new.user_id; v_job_id := new.job_id;
  select * into v_profile from public.candidate_profiles where user_id=v_owner;
  if not found then return new; end if;
  if exists(select 1 from public.jobs j join public.job_analyses a on a.job_id=j.id
    where j.id=v_job_id and a.engine_version='job-fit-v2'
      and a.job_revision=j.analysis_revision and a.profile_revision=v_profile.analysis_revision
      and a.input_hash ~ '^[0-9a-f]{64}$' and a.assessment_as_of is not null) then return new; end if;
  insert into public.job_analysis_batches(user_id,request_id,mode,state,requested_job_ids,requested_count)
  values(v_owner,gen_random_uuid(),'automatic','queued',array[v_job_id],1) returning * into v_batch;
  insert into public.job_analysis_tasks(user_id,batch_id,job_id,job_revision,profile_revision)
  select v_owner,v_batch.id,j.id,j.analysis_revision,v_profile.analysis_revision from public.jobs j
   where j.id=v_job_id and j.user_id=v_owner and j.archived_at is null
  on conflict (user_id,job_id) where state in ('queued','running') do nothing;
  get diagnostics v_inserted_count = row_count;
  if v_inserted_count=0 then
    if exists(select 1 from public.job_analysis_tasks t where t.user_id=v_owner and t.job_id=v_job_id and t.state in ('queued','running')) then
      update public.job_analysis_batches set state='processing',reused_count=1 where id=v_batch.id;
    else
      update public.job_analysis_batches set state='completed',finished_at=now() where id=v_batch.id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_imported_job_analysis() from public, anon, authenticated, service_role;
drop trigger if exists completed_job_inspection_enqueue_analysis on public.job_url_inspection_requests;
create trigger completed_job_inspection_enqueue_analysis after update of status on public.job_url_inspection_requests
for each row execute function private.enqueue_imported_job_analysis();

comment on table public.job_analysis_batches is 'Durable user-visible batches for profile-fit analysis; rows are owner readable and worker controlled.';
comment on table public.job_analysis_tasks is 'Lease-protected per-job analysis work; every result is tied to job/profile input revisions.';
