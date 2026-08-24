-- Milestone 21: per-user recurring search runs, source health and bounded
-- ChatGPT search context.

create table if not exists public.job_search_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_key text not null,
  label text not null,
  source_type text not null check (source_type in ('employer_careers','live_ats','quality_board','other')),
  base_url text,
  enabled boolean not null default true,
  health text not null default 'unknown' check (health in ('unknown','healthy','degraded','failed','disabled')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, source_key)
);

create table if not exists public.job_search_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trigger text not null check (trigger in ('manual','chatgpt_task','scheduled')),
  state text not null default 'queued' check (state in ('queued','running','completed','failed','user_required')),
  idempotency_key text not null,
  source_keys text[] not null default '{}',
  max_jobs integer not null default 20 check (max_jobs between 1 and 100),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  next_run_at timestamptz,
  jobs_checked integer not null default 0 check (jobs_checked >= 0),
  jobs_discovered integer not null default 0 check (jobs_discovered >= 0),
  jobs_deduped integer not null default 0 check (jobs_deduped >= 0),
  jobs_accepted integer not null default 0 check (jobs_accepted >= 0),
  summary jsonb not null default '{}'::jsonb,
  error_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key)
);

create table if not exists public.job_search_run_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.job_search_runs(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  disposition text not null default 'discovered' check (disposition in ('discovered','duplicate','accepted','rejected','skipped')),
  reason text,
  fit_score numeric(5,2),
  priority_score numeric(5,2),
  triage public.job_triage,
  created_at timestamptz not null default now(),
  unique(run_id, job_id)
);

create index if not exists job_search_sources_user_enabled_idx
  on public.job_search_sources(user_id, enabled, updated_at desc);
create index if not exists job_search_runs_user_created_idx
  on public.job_search_runs(user_id, created_at desc);
create index if not exists job_search_runs_user_state_idx
  on public.job_search_runs(user_id, state, updated_at desc);
create index if not exists job_search_run_jobs_run_idx
  on public.job_search_run_jobs(run_id, created_at desc);
create index if not exists job_search_run_jobs_job_idx
  on public.job_search_run_jobs(job_id);
create index if not exists job_search_run_jobs_user_idx
  on public.job_search_run_jobs(user_id, created_at desc);

alter table public.job_search_sources enable row level security;
alter table public.job_search_runs enable row level security;
alter table public.job_search_run_jobs enable row level security;

drop policy if exists job_search_sources_owner on public.job_search_sources;
create policy job_search_sources_owner on public.job_search_sources
  for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
drop policy if exists job_search_runs_owner on public.job_search_runs;
create policy job_search_runs_owner on public.job_search_runs
  for select to authenticated using (user_id=(select auth.uid()));
drop policy if exists job_search_run_jobs_owner on public.job_search_run_jobs;
create policy job_search_run_jobs_owner on public.job_search_run_jobs
  for select to authenticated using (user_id=(select auth.uid()));

revoke all on public.job_search_sources, public.job_search_runs, public.job_search_run_jobs from public, anon;
grant select, insert, update, delete on public.job_search_sources to authenticated;
grant select on public.job_search_runs, public.job_search_run_jobs to authenticated;

create or replace function private.enqueue_job_search_run_internal(
  p_user uuid,
  p_trigger text default 'manual',
  p_force boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_preferences jsonb := '{}'::jsonb;
  v_cadence text := 'daily';
  v_interval interval := interval '1 day';
  v_last timestamptz;
  v_active public.job_search_runs;
  v_run public.job_search_runs;
  v_work public.chatgpt_work_items;
  v_sources text[] := '{}';
  v_idempotency text;
  v_next timestamptz;
begin
  perform private.assert_active_app_membership(p_user);
  if coalesce(p_trigger,'manual') not in ('manual','chatgpt_task','scheduled') then raise exception 'Invalid search-run trigger'; end if;

  insert into public.job_search_sources(user_id,source_key,label,source_type,base_url)
  values
    (p_user,'employer_careers','Employer career sites','employer_careers',null),
    (p_user,'live_ats','Live ATS pages','live_ats',null),
    (p_user,'quality_boards','High-quality job boards','quality_board',null)
  on conflict(user_id,source_key) do nothing;

  select coalesce(array_agg(source_key order by source_key) filter (where enabled), '{}') into v_sources
    from public.job_search_sources where user_id=p_user;
  select coalesce(preferences,'{}'::jsonb) into v_preferences from public.candidate_preferences cp
    join public.candidate_profiles p on p.id=cp.profile_id where p.user_id=p_user;
  v_cadence := coalesce(nullif(v_preferences->>'search_cadence',''),'daily');
  v_interval := case v_cadence when 'weekdays' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 day' end;

  select * into v_active from public.job_search_runs
   where user_id=p_user and state in ('queued','running') and created_at > now()-interval '30 minutes'
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object('enqueued',false,'reason','active_run','run_id',v_active.id,'state',v_active.state,'work_item_id',(
      select id from public.chatgpt_work_items where user_id=p_user and input_json->>'run_id'=v_active.id::text order by created_at desc limit 1
    ));
  end if;

  select max(finished_at) into v_last from public.job_search_runs
   where user_id=p_user and state='completed';
  if not p_force then
    if v_cadence='manual' then return jsonb_build_object('enqueued',false,'reason','manual_cadence'); end if;
    if v_last is not null and v_last > now()-v_interval then
      v_next := v_last + v_interval;
      return jsonb_build_object('enqueued',false,'reason','not_due','last_run_at',v_last,'next_run_at',v_next);
    end if;
  end if;

  v_idempotency := coalesce(p_trigger,'manual')||':'||to_char(date_trunc('minute',now()),'YYYYMMDDHH24MI')||':'||substr(md5(p_user::text||now()::text),1,8);
  insert into public.job_search_runs(user_id,trigger,state,idempotency_key,source_keys,max_jobs,started_at,next_run_at)
  values(p_user,p_trigger,'running',v_idempotency,v_sources,20,now(),now()+v_interval)
  returning * into v_run;
  insert into public.chatgpt_work_items(user_id,kind,state,idempotency_key,input_json)
  values(p_user,'job_discovery','queued','search_run:'||v_run.id::text,jsonb_build_object(
    'run_id',v_run.id,'source_keys',v_sources,'max_jobs',v_run.max_jobs,'preferences',v_preferences,
    'posting_age_policy',coalesce(v_preferences->'posting_age_policy','{}'::jsonb)
  )) returning * into v_work;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,case when p_trigger='manual' then 'user' else 'ai' end,p_user::text,'job_search.run_queued','job_search_run',v_run.id,
         jsonb_build_object('trigger',p_trigger,'source_keys',v_sources,'work_item_id',v_work.id));
  return jsonb_build_object('enqueued',true,'run_id',v_run.id,'work_item_id',v_work.id,'state',v_run.state,'next_run_at',v_run.next_run_at,'source_keys',v_sources);
end;
$$;
revoke all on function private.enqueue_job_search_run_internal(uuid,text,boolean) from public, anon, authenticated;

create or replace function private.enqueue_job_search_run_current_user(p_trigger text default 'manual')
returns jsonb
language sql
security definer
set search_path=''
as $$ select private.enqueue_job_search_run_internal((select auth.uid()),$1,true); $$;
revoke all on function private.enqueue_job_search_run_current_user(text) from public, anon, authenticated;
grant execute on function private.enqueue_job_search_run_current_user(text) to authenticated;

create or replace function public.enqueue_job_search_run(p_trigger text default 'manual')
returns jsonb
language sql
security invoker
set search_path=''
as $$ select private.enqueue_job_search_run_current_user($1); $$;
revoke all on function public.enqueue_job_search_run(text) from public, anon;
grant execute on function public.enqueue_job_search_run(text) to authenticated;

create or replace function private.finalize_job_search_run_work_item()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_run_id uuid := nullif(new.input_json->>'run_id','')::uuid;
  v_checked integer;
  v_deduped integer;
  v_accepted integer;
begin
  if new.kind <> 'job_discovery' or v_run_id is null or old.state is not distinct from new.state then return new; end if;
  if new.state not in ('completed','failed','user_required') then return new; end if;
  v_checked := case when coalesce(new.output_json->>'jobs_checked','') ~ '^[0-9]+$' then (new.output_json->>'jobs_checked')::integer else null end;
  v_deduped := case when coalesce(new.output_json->>'jobs_deduped','') ~ '^[0-9]+$' then (new.output_json->>'jobs_deduped')::integer else 0 end;
  v_accepted := case when coalesce(new.output_json->>'jobs_accepted','') ~ '^[0-9]+$' then (new.output_json->>'jobs_accepted')::integer else (select count(*) from public.job_search_run_jobs where run_id=v_run_id and disposition='accepted') end;
  update public.job_search_runs
     set state=new.state,finished_at=now(),jobs_checked=coalesce(v_checked,(select count(*) from public.job_search_run_jobs where run_id=v_run_id)),
         jobs_discovered=(select count(*) from public.job_search_run_jobs where run_id=v_run_id),jobs_deduped=coalesce(v_deduped,0),
         jobs_accepted=coalesce(v_accepted,0),summary=coalesce(new.output_json,'{}'::jsonb),error_json=new.error_json,updated_at=now()
   where id=v_run_id and user_id=new.user_id;
  return new;
end;
$$;
revoke all on function private.finalize_job_search_run_work_item() from public, anon, authenticated;
drop trigger if exists chatgpt_work_item_finalizes_search_run on public.chatgpt_work_items;
create trigger chatgpt_work_item_finalizes_search_run after update on public.chatgpt_work_items
for each row execute function private.finalize_job_search_run_work_item();

create or replace function private.attach_job_to_search_run()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare v_run_id uuid;
begin
  if new.discovery_source <> 'chatgpt_mcp' then return new; end if;
  select id into v_run_id from public.job_search_runs where user_id=new.user_id and state='running' order by created_at desc limit 1;
  if v_run_id is null then return new; end if;
  insert into public.job_search_run_jobs(run_id,job_id,user_id,disposition,reason)
  values(v_run_id,new.id,new.user_id,'discovered','New vacancy persisted by ChatGPT search worker.')
  on conflict(run_id,job_id) do nothing;
  update public.job_search_runs set jobs_discovered=(select count(*) from public.job_search_run_jobs where run_id=v_run_id),updated_at=now() where id=v_run_id;
  return new;
end;
$$;
revoke all on function private.attach_job_to_search_run() from public, anon, authenticated;
drop trigger if exists chatgpt_job_attaches_search_run on public.jobs;
create trigger chatgpt_job_attaches_search_run after insert on public.jobs
for each row execute function private.attach_job_to_search_run();

create or replace function private.attach_job_analysis_to_search_run()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  update public.job_search_run_jobs rj
     set fit_score=new.fit_score,priority_score=new.priority_score,triage=new.triage,
         disposition=case when new.triage='reject' then 'rejected' when new.triage is null then 'discovered' else 'accepted' end,
         reason=new.triage_reason
   from public.job_search_runs r
   where rj.job_id=new.job_id and rj.run_id=r.id and r.state='running';
  return new;
end;
$$;
revoke all on function private.attach_job_analysis_to_search_run() from public, anon, authenticated;
drop trigger if exists job_analysis_attaches_search_run on public.job_analyses;
create trigger job_analysis_attaches_search_run after insert on public.job_analyses
for each row execute function private.attach_job_analysis_to_search_run();

create or replace function private.chatgpt_ensure_search_run_internal(p_access_token text,p_force boolean default false)
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
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for search scheduling'; end if;
  v_result := private.enqueue_job_search_run_internal(v_token.user_id,'chatgpt_task',coalesce(p_force,false));
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_token.user_id,'chatgpt',v_token.client_id,'chatgpt.search_run_ensured','job_search_run',null,jsonb_build_object('force',coalesce(p_force,false)));
  return v_result;
end;
$$;
revoke all on function private.chatgpt_ensure_search_run_internal(text,boolean) from public, anon, authenticated;
grant execute on function private.chatgpt_ensure_search_run_internal(text,boolean) to anon, authenticated;

create or replace function public.chatgpt_ensure_search_run(p_access_token text,p_force boolean default false)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_ensure_search_run_internal($1,$2); $$;
revoke all on function public.chatgpt_ensure_search_run(text,boolean) from public, authenticated;
grant execute on function public.chatgpt_ensure_search_run(text,boolean) to anon, authenticated;

create or replace function private.chatgpt_get_search_context_internal(p_access_token text,p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_profile uuid; v_limit integer:=greatest(10,least(coalesce(p_limit,50),100)); v_result jsonb;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for search context'; end if;
  select id into v_profile from public.candidate_profiles where user_id=v_token.user_id;
  v_result := jsonb_build_object(
    'preferences',coalesce((select cp.preferences from public.candidate_preferences cp where cp.profile_id=v_profile),'{}'::jsonb),
    'sources',coalesce((select jsonb_agg(to_jsonb(s)-'user_id' order by s.source_key) from public.job_search_sources s where s.user_id=v_token.user_id),'[]'::jsonb),
    'recent_runs',coalesce((select jsonb_agg(to_jsonb(r)-'user_id' order by r.created_at desc) from (select * from public.job_search_runs where user_id=v_token.user_id order by created_at desc limit 20) r),'[]'::jsonb),
    'known_jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'title',j.title,'company_id',j.company_id,'source_url',j.source_url,'application_url',j.application_url,'posted_at',j.posted_at,'dedupe_key',j.dedupe_key,'triage',j.triage,'updated_at',j.updated_at) order by j.updated_at desc) from (select * from public.jobs where user_id=v_token.user_id order by updated_at desc limit v_limit) j),'[]'::jsonb)
  );
  return v_result;
end;
$$;
revoke all on function private.chatgpt_get_search_context_internal(text,integer) from public, anon, authenticated;
grant execute on function private.chatgpt_get_search_context_internal(text,integer) to anon, authenticated;

create or replace function public.chatgpt_get_search_context(p_access_token text,p_limit integer default 50)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_get_search_context_internal($1,$2); $$;
revoke all on function public.chatgpt_get_search_context(text,integer) from public, authenticated;
grant execute on function public.chatgpt_get_search_context(text,integer) to anon, authenticated;
