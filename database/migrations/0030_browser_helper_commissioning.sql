-- Milestone 14: one-time paired local browser helper with device-scoped credentials.

create table if not exists public.browser_agent_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  platform text not null default 'macos',
  helper_version text,
  token_hash text not null unique,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.browser_agent_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.form_agent_sessions
  add column if not exists browser_device_id uuid references public.browser_agent_devices(id) on delete set null,
  add column if not exists helper_claimed_at timestamptz;

create index if not exists browser_agent_devices_user_active_idx
  on public.browser_agent_devices(user_id, revoked_at, last_seen_at desc);
create index if not exists browser_agent_pairing_codes_user_idx
  on public.browser_agent_pairing_codes(user_id, expires_at desc);
create index if not exists form_agent_sessions_browser_device_idx
  on public.form_agent_sessions(browser_device_id, status, updated_at desc);

alter table public.browser_agent_devices enable row level security;
alter table public.browser_agent_pairing_codes enable row level security;

revoke all on public.browser_agent_devices from public, anon, authenticated;
revoke all on public.browser_agent_pairing_codes from public, anon, authenticated;
grant select, insert, update, delete on public.browser_agent_devices to service_role;
grant select, insert, update, delete on public.browser_agent_pairing_codes to service_role;

-- Explicit deny policies document that these credentials are never client-readable.
create policy browser_agent_devices_no_direct_client_access on public.browser_agent_devices
  as restrictive for all to authenticated using (false) with check (false);
create policy browser_agent_pairing_codes_no_direct_client_access on public.browser_agent_pairing_codes
  as restrictive for all to authenticated using (false) with check (false);

create or replace function private.create_browser_agent_pairing_code_for_user(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_raw text;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  update public.browser_agent_pairing_codes
     set used_at = coalesce(used_at, now())
   where user_id = p_user and used_at is null and expires_at > now();

  v_raw := upper(substr(encode(extensions.gen_random_bytes(9),'hex'),1,6) || '-' ||
                 substr(encode(extensions.gen_random_bytes(9),'hex'),1,6) || '-' ||
                 substr(encode(extensions.gen_random_bytes(9),'hex'),1,6));

  insert into public.browser_agent_pairing_codes(user_id, code_hash, expires_at)
  values(p_user, encode(extensions.digest(v_raw,'sha256'),'hex'), v_expires);

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'browser_helper.pairing_code_created','user',p_user,
         jsonb_build_object('expires_at',v_expires));

  return jsonb_build_object('pairing_code',v_raw,'expires_at',v_expires);
end;
$$;
revoke all on function private.create_browser_agent_pairing_code_for_user(uuid) from public,anon,authenticated;
grant execute on function private.create_browser_agent_pairing_code_for_user(uuid) to authenticated;

create or replace function public.create_browser_agent_pairing_code()
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.create_browser_agent_pairing_code_for_user(v_user);
end;
$$;
revoke all on function public.create_browser_agent_pairing_code() from public,anon;
grant execute on function public.create_browser_agent_pairing_code() to authenticated;

create or replace function private.get_browser_agent_helper_status_for_user(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_device public.browser_agent_devices;
begin
  select * into v_device
    from public.browser_agent_devices
   where user_id=p_user and revoked_at is null
   order by last_seen_at desc nulls last, paired_at desc
   limit 1;

  if not found then
    return jsonb_build_object('paired',false,'device',null);
  end if;

  return jsonb_build_object(
    'paired',true,
    'device',jsonb_build_object(
      'id',v_device.id,
      'display_name',v_device.display_name,
      'platform',v_device.platform,
      'helper_version',v_device.helper_version,
      'paired_at',v_device.paired_at,
      'last_seen_at',v_device.last_seen_at,
      'online',coalesce(v_device.last_seen_at > now()-interval '30 seconds',false)
    )
  );
end;
$$;
revoke all on function private.get_browser_agent_helper_status_for_user(uuid) from public,anon,authenticated;
grant execute on function private.get_browser_agent_helper_status_for_user(uuid) to authenticated;

create or replace function public.get_browser_agent_helper_status()
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.get_browser_agent_helper_status_for_user(v_user);
end;
$$;
revoke all on function public.get_browser_agent_helper_status() from public,anon;
grant execute on function public.get_browser_agent_helper_status() to authenticated;

create or replace function private.revoke_browser_agent_device_for_user(p_user uuid,p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  update public.browser_agent_devices
     set revoked_at=now(),updated_at=now()
   where id=p_device_id and user_id=p_user and revoked_at is null;
  if not found then raise exception 'Browser helper device not found'; end if;

  update public.form_agent_sessions
     set status='cancelled',completed_at=now(),updated_at=now()
   where user_id=p_user and browser_device_id=p_device_id
     and status in ('active','needs_user','final_review','approved_for_submission');

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'browser_helper.device_revoked','browser_agent_device',p_device_id,'{}'::jsonb);
  return jsonb_build_object('revoked',true,'device_id',p_device_id);
end;
$$;
revoke all on function private.revoke_browser_agent_device_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.revoke_browser_agent_device_for_user(uuid,uuid) to authenticated;

create or replace function public.revoke_browser_agent_device(p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.revoke_browser_agent_device_for_user(v_user,p_device_id);
end;
$$;
revoke all on function public.revoke_browser_agent_device(uuid) from public,anon;
grant execute on function public.revoke_browser_agent_device(uuid) to authenticated;

create or replace function private.start_form_agent_session_for_paired_device(
  p_user uuid,
  p_application_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_started jsonb;
  v_session uuid;
begin
  if not exists(
    select 1 from public.browser_agent_devices
     where id=p_device_id and user_id=p_user and revoked_at is null
  ) then raise exception 'Paired browser helper not found'; end if;

  v_started := private.start_form_agent_session_for_user(p_user,p_application_id);
  v_session := (v_started->>'session_id')::uuid;
  update public.form_agent_sessions
     set browser_device_id=p_device_id,helper_claimed_at=null,updated_at=now()
   where id=v_session and user_id=p_user;

  return (v_started - 'token') || jsonb_build_object('queued_for_helper',true,'device_id',p_device_id);
end;
$$;
revoke all on function private.start_form_agent_session_for_paired_device(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function private.start_form_agent_session_for_paired_device(uuid,uuid,uuid) to authenticated;

create or replace function public.start_form_agent_session_for_device(p_application_id uuid,p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.start_form_agent_session_for_paired_device(v_user,p_application_id,p_device_id);
end;
$$;
revoke all on function public.start_form_agent_session_for_device(uuid,uuid) from public,anon;
grant execute on function public.start_form_agent_session_for_device(uuid,uuid) to authenticated;

create or replace function private.resume_form_agent_session_for_user(p_user uuid,p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_session public.form_agent_sessions;
begin
  select * into v_session from public.form_agent_sessions where id=p_session_id and user_id=p_user for update;
  if not found then raise exception 'Form session not found'; end if;
  if v_session.status <> 'needs_user' then raise exception 'Form session is not waiting for user action'; end if;
  if v_session.expires_at <= now() then raise exception 'Form session has expired'; end if;
  update public.form_agent_sessions set status='active',pause_reasons='[]'::jsonb,updated_at=now() where id=p_session_id;
  update public.applications set state='form_in_progress',next_action='Browser helper resumed.',updated_at=now() where id=v_session.application_id and user_id=p_user;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'browser_helper.resumed','application',v_session.application_id,jsonb_build_object('session_id',p_session_id));
  return jsonb_build_object('session_id',p_session_id,'status','active');
end;
$$;
revoke all on function private.resume_form_agent_session_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.resume_form_agent_session_for_user(uuid,uuid) to authenticated;

create or replace function public.resume_form_agent_session(p_session_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.resume_form_agent_session_for_user(v_user,p_session_id);
end;
$$;
revoke all on function public.resume_form_agent_session(uuid) from public,anon;
grant execute on function public.resume_form_agent_session(uuid) to authenticated;
