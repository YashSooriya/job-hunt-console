-- Keep the one-hour manual-search rule and its diagnostics override outside
-- candidate preferences. The Website Bridge remains the generic dispatch path.

create table if not exists public.job_search_controls (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_manual_search_at timestamptz,
  last_manual_idempotency_key text,
  manual_search_cooldown_disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep the migration safe if a development database was created from an
-- earlier draft of this migration before the diagnostics switch was added.
alter table public.job_search_controls
  add column if not exists manual_search_cooldown_disabled boolean not null default false;

alter table public.job_search_controls enable row level security;
drop policy if exists job_search_controls_owner on public.job_search_controls;
create policy job_search_controls_owner on public.job_search_controls
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.job_search_controls from public, anon;
grant select, insert, update on public.job_search_controls to authenticated;

create or replace function public.create_manual_job_search_dispatch(
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
  v_now timestamptz := now();
  v_next timestamptz;
  v_dispatch jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null
     or length(p_idempotency_key) > 200
     or p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'Invalid manual-search idempotency key';
  end if;
  if nullif(btrim(coalesce(p_website_instruction,'')),'') is null then raise exception 'A manual search instruction is required'; end if;
  if length(p_website_instruction) > 6000 then raise exception 'Website Bridge instruction is too long'; end if;

  -- Materialise the per-user row before taking the lock. The conflict-safe
  -- insert makes two first clicks serialize instead of producing a duplicate
  -- key error; the row lock then decides which request owns the hour window.
  insert into public.job_search_controls(user_id)
  values(v_user)
  on conflict (user_id) do nothing;

  select * into v_control
    from public.job_search_controls
   where user_id = v_user
   for update;

  if v_control.last_manual_idempotency_key = p_idempotency_key then
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
  return jsonb_build_object(
    'ok',true,
    'dispatch',v_dispatch,
    'server_now',v_now,
    'cooldown_disabled',coalesce(v_control.manual_search_cooldown_disabled,false)
  );
end;
$$;

revoke all on function public.create_manual_job_search_dispatch(text,text) from public, anon;
grant execute on function public.create_manual_job_search_dispatch(text,text) to authenticated;
