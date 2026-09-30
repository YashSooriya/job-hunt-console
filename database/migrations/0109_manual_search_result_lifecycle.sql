-- Give each one-shot Website Bridge search a durable application run row so
-- completed exact-turn responses can be reconciled into the existing vacancy
-- inspection pipeline after a page refresh. This does not change bridge or
-- Edge Function protocol behaviour.

alter table public.job_search_runs
  add column if not exists dispatch_request_id uuid
  references public.chatgpt_dispatch_requests(id) on delete set null;

create unique index if not exists job_search_runs_dispatch_request_unique
  on public.job_search_runs(dispatch_request_id)
  where dispatch_request_id is not null;

drop policy if exists job_search_runs_owner_insert on public.job_search_runs;
create policy job_search_runs_owner_insert on public.job_search_runs
  for insert to authenticated
  with check ((select auth.uid()) is not null and user_id=(select auth.uid()));

-- The invoker wrapper inserts only the durable identity/linkage columns.
-- Authenticated users cannot edit worker-owned run state, counts, or summaries.
grant insert (id,user_id,trigger,state,idempotency_key,source_keys,max_jobs,dispatch_request_id)
  on public.job_search_runs to authenticated;

create or replace function public.create_manual_job_search_dispatch(
  p_run_id uuid,
  p_idempotency_key text,
  p_website_instruction text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_control public.job_search_controls;
  v_existing public.job_search_runs;
  v_run public.job_search_runs;
  v_now timestamptz := now();
  v_next timestamptz;
  v_dispatch jsonb;
  v_dispatch_id uuid;
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

  insert into public.job_search_controls(user_id)
  values(v_user)
  on conflict (user_id) do nothing;

  select * into v_control
    from public.job_search_controls
   where user_id = v_user
   for update;

  select * into v_existing
    from public.job_search_runs
   where user_id=v_user and idempotency_key=p_idempotency_key;
  if found and v_existing.id is distinct from p_run_id then
    raise exception 'This manual-search idempotency key belongs to another run';
  end if;

  if not found and v_control.last_manual_idempotency_key = p_idempotency_key then
    -- Compatibility recovery for a request created before the durable run row
    -- was added. The generic dispatcher returns the existing request below.
    null;
  elsif found then
    null;
  elsif not coalesce(v_control.manual_search_cooldown_disabled,false)
        and v_control.last_manual_search_at is not null
        and v_control.last_manual_search_at > v_now - interval '1 hour' then
    v_next := v_control.last_manual_search_at + interval '1 hour';
    return jsonb_build_object(
      'ok',false,
      'reason','manual_search_cooldown',
      'last_triggered_at',v_control.last_manual_search_at,
      'next_allowed_at',v_next,
      'server_now',v_now,
      'remaining_seconds',greatest(0,ceil(extract(epoch from (v_next-v_now))))::integer
    );
  else
    update public.job_search_controls
       set last_manual_search_at=v_now,last_manual_idempotency_key=p_idempotency_key,updated_at=v_now
     where user_id=v_user
     returning * into v_control;
  end if;

  v_dispatch := public.create_chatgpt_dispatch_request_with_website_instruction(
    'jobs.search.manual','{}'::jsonb,'user_click','Run a manual job search',p_idempotency_key,90,p_website_instruction
  );
  v_dispatch_id := nullif(v_dispatch->>'id','')::uuid;
  if v_dispatch_id is null then raise exception 'The Website Bridge did not return a dispatch id'; end if;

  insert into public.job_search_runs(
    id,user_id,trigger,state,idempotency_key,source_keys,max_jobs,dispatch_request_id
  ) values (
    p_run_id,v_user,'manual','queued',p_idempotency_key,'{}'::text[],10,v_dispatch_id
  ) on conflict (user_id,idempotency_key) do nothing;

  select * into v_run
    from public.job_search_runs
   where user_id=v_user and idempotency_key=p_idempotency_key;
  if not found or v_run.id is distinct from p_run_id or v_run.dispatch_request_id is distinct from v_dispatch_id then
    raise exception 'The manual search could not be linked to its durable run';
  end if;

  return jsonb_build_object(
    'ok',true,
    'run_id',v_run.id,
    'dispatch',v_dispatch,
    'server_now',v_now,
    'cooldown_disabled',coalesce(v_control.manual_search_cooldown_disabled,false)
  );
end;
$$;

-- Retain the original two-argument RPC signature for already-open clients;
-- it now creates a durable run as well. New clients pass the run id used in
-- the strict response contract.
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

revoke all on function public.create_manual_job_search_dispatch(uuid,text,text) from public,anon;
revoke all on function public.create_manual_job_search_dispatch(text,text) from public,anon;
grant execute on function public.create_manual_job_search_dispatch(uuid,text,text) to authenticated;
grant execute on function public.create_manual_job_search_dispatch(text,text) to authenticated;

comment on column public.job_search_runs.dispatch_request_id is
  'Generic Website Bridge dispatch linked to a manual search; captured results are reconciled through the existing authenticated listing-inspection completion path.';
