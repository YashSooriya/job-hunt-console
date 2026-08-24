-- Milestone 25: per-user email cadence and an optional managed Google Sheets
-- application tracker. The Sheet is deliberately limited to files created by
-- this application or explicitly selected through Google Picker with drive.file.

create table if not exists public.candidate_automation_settings (
  profile_id uuid primary key references public.candidate_profiles(id) on delete cascade,
  email_monitoring_enabled boolean not null default true,
  email_monitoring_cadence text not null default 'daily'
    check (email_monitoring_cadence in ('manual','hourly','every_4_hours','daily','weekdays')),
  spreadsheet_sync_enabled boolean not null default false,
  google_spreadsheet_id text,
  google_spreadsheet_url text,
  google_spreadsheet_title text,
  google_spreadsheet_tab text not null default 'Applications',
  last_email_review_at timestamptz,
  next_email_review_at timestamptz,
  last_email_review_status text,
  last_email_scanned integer not null default 0,
  last_email_relevant integer not null default 0,
  last_email_needs_user integer not null default 0,
  last_email_error text,
  last_sheet_sync_at timestamptz,
  last_sheet_sync_status text,
  last_sheet_sync_rows integer not null default 0,
  last_sheet_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists candidate_automation_settings_email_due_idx
  on public.candidate_automation_settings(next_email_review_at)
  where email_monitoring_enabled = true and email_monitoring_cadence <> 'manual';

alter table public.candidate_automation_settings enable row level security;
revoke all on public.candidate_automation_settings from public,anon;
drop policy if exists candidate_automation_settings_owner on public.candidate_automation_settings;
create policy candidate_automation_settings_owner on public.candidate_automation_settings
  for all to authenticated
  using (exists(select 1 from public.candidate_profiles p where p.id=profile_id and p.user_id=(select auth.uid())))
  with check (exists(select 1 from public.candidate_profiles p where p.id=profile_id and p.user_id=(select auth.uid())));
grant select,insert,update on public.candidate_automation_settings to authenticated;

create or replace function private.automation_next_run(p_cadence text,p_enabled boolean)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not coalesce(p_enabled,true) or p_cadence='manual' then return null; end if;
  if p_cadence='hourly' then return now()+interval '1 hour'; end if;
  if p_cadence='every_4_hours' then return now()+interval '4 hours'; end if;
  if p_cadence='weekdays' then
    return case extract(isodow from now())::integer
      when 5 then now()+interval '3 days'
      when 6 then now()+interval '2 days'
      when 7 then now()+interval '1 day'
      else now()+interval '1 day'
    end;
  end if;
  return now()+interval '1 day';
end;
$$;
revoke all on function private.automation_next_run(text,boolean) from public,anon,authenticated;
grant execute on function private.automation_next_run(text,boolean) to authenticated;

create or replace function private.automation_settings_for_user(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
  v_settings public.candidate_automation_settings;
begin
  select id into v_profile from public.candidate_profiles where user_id=p_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  insert into public.candidate_automation_settings(profile_id) values(v_profile) on conflict(profile_id) do nothing;
  select * into v_settings from public.candidate_automation_settings where profile_id=v_profile;
  return jsonb_build_object(
    'profile_id',v_profile,
    'email_monitoring_enabled',coalesce(v_settings.email_monitoring_enabled,true),
    'email_monitoring_cadence',coalesce(v_settings.email_monitoring_cadence,'daily'),
    'email_review_due',coalesce(v_settings.next_email_review_at is null or v_settings.next_email_review_at<=now(),true),
    'last_email_review_at',v_settings.last_email_review_at,
    'next_email_review_at',v_settings.next_email_review_at,
    'last_email_review_status',v_settings.last_email_review_status,
    'last_email_scanned',coalesce(v_settings.last_email_scanned,0),
    'last_email_relevant',coalesce(v_settings.last_email_relevant,0),
    'last_email_needs_user',coalesce(v_settings.last_email_needs_user,0),
    'last_email_error',v_settings.last_email_error,
    'spreadsheet_sync_enabled',coalesce(v_settings.spreadsheet_sync_enabled,false),
    'google_spreadsheet_id',v_settings.google_spreadsheet_id,
    'google_spreadsheet_url',v_settings.google_spreadsheet_url,
    'google_spreadsheet_title',v_settings.google_spreadsheet_title,
    'google_spreadsheet_tab',coalesce(v_settings.google_spreadsheet_tab,'Applications'),
    'last_sheet_sync_at',v_settings.last_sheet_sync_at,
    'last_sheet_sync_status',v_settings.last_sheet_sync_status,
    'last_sheet_sync_rows',coalesce(v_settings.last_sheet_sync_rows,0),
    'last_sheet_sync_error',v_settings.last_sheet_sync_error
  );
end;
$$;
revoke all on function private.automation_settings_for_user(uuid) from public,anon,authenticated;
grant execute on function private.automation_settings_for_user(uuid) to authenticated;

create or replace function public.get_automation_settings()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.automation_settings_for_user(v_user);
end;
$$;
revoke all on function public.get_automation_settings() from public,anon;
grant execute on function public.get_automation_settings() to authenticated;

create or replace function public.save_automation_settings(
  p_email_monitoring_enabled boolean default true,
  p_email_monitoring_cadence text default 'daily',
  p_spreadsheet_sync_enabled boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_profile uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_email_monitoring_cadence not in ('manual','hourly','every_4_hours','daily','weekdays') then raise exception 'Invalid email monitoring cadence'; end if;
  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  insert into public.candidate_automation_settings(
    profile_id,email_monitoring_enabled,email_monitoring_cadence,spreadsheet_sync_enabled,next_email_review_at,updated_at
  ) values (
    v_profile,coalesce(p_email_monitoring_enabled,true),p_email_monitoring_cadence,coalesce(p_spreadsheet_sync_enabled,false),
    private.automation_next_run(p_email_monitoring_cadence,coalesce(p_email_monitoring_enabled,true)),now()
  ) on conflict(profile_id) do update set
    email_monitoring_enabled=excluded.email_monitoring_enabled,
    email_monitoring_cadence=excluded.email_monitoring_cadence,
    spreadsheet_sync_enabled=excluded.spreadsheet_sync_enabled,
    next_email_review_at=excluded.next_email_review_at,
    updated_at=now();
  return private.automation_settings_for_user(v_user);
end;
$$;
revoke all on function public.save_automation_settings(boolean,text,boolean) from public,anon;
grant execute on function public.save_automation_settings(boolean,text,boolean) to authenticated;

create or replace function public.record_email_review_run(
  p_status text,
  p_scanned integer default 0,
  p_relevant integer default 0,
  p_needs_user integer default 0,
  p_error text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_profile uuid;
  v_settings public.candidate_automation_settings;
  v_now timestamptz := now();
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  insert into public.candidate_automation_settings(profile_id) values(v_profile) on conflict(profile_id) do nothing;
  select * into v_settings from public.candidate_automation_settings where profile_id=v_profile for update;
  update public.candidate_automation_settings set
    last_email_review_at=v_now,
    next_email_review_at=private.automation_next_run(v_settings.email_monitoring_cadence,v_settings.email_monitoring_enabled),
    last_email_review_status=coalesce(nullif(p_status,''),'ok'),
    last_email_scanned=greatest(0,coalesce(p_scanned,0)),
    last_email_relevant=greatest(0,coalesce(p_relevant,0)),
    last_email_needs_user=greatest(0,coalesce(p_needs_user,0)),
    last_email_error=nullif(p_error,''),
    updated_at=v_now
  where profile_id=v_profile;
  return private.automation_settings_for_user(v_user);
end;
$$;
revoke all on function public.record_email_review_run(text,integer,integer,integer,text) from public,anon;
grant execute on function public.record_email_review_run(text,integer,integer,integer,text) to authenticated;

create or replace function public.record_tracker_sheet_sync(
  p_status text,
  p_rows integer default 0,
  p_error text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_user uuid := (select auth.uid()); v_profile uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  insert into public.candidate_automation_settings(profile_id) values(v_profile) on conflict(profile_id) do nothing;
  update public.candidate_automation_settings set
    last_sheet_sync_at=now(),last_sheet_sync_status=coalesce(nullif(p_status,''),'ok'),last_sheet_sync_rows=greatest(0,coalesce(p_rows,0)),last_sheet_sync_error=nullif(p_error,''),updated_at=now()
  where profile_id=v_profile;
  return private.automation_settings_for_user(v_user);
end;
$$;
revoke all on function public.record_tracker_sheet_sync(text,integer,text) from public,anon;
grant execute on function public.record_tracker_sheet_sync(text,integer,text) to authenticated;

create or replace function private.chatgpt_get_automation_settings_internal(p_access_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_result jsonb;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for automation settings'; end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;
  v_result:=private.automation_settings_for_user(v_token.user_id);
  return v_result || jsonb_build_object('user_id',v_token.user_id);
end;
$$;
revoke all on function private.chatgpt_get_automation_settings_internal(text) from public,anon,authenticated;
grant execute on function private.chatgpt_get_automation_settings_internal(text) to anon,authenticated;

-- The MCP route may request a server-side Sheet sync, but the decrypted
-- refresh token must never be callable by anon/authenticated ChatGPT RPCs.
-- Only the application backend's Supabase service role may invoke this
-- broker; the token is consumed in the backend and is never returned by MCP.
create or replace function private.chatgpt_server_get_google_refresh_token_internal(p_access_token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_refresh text;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for Google Sheet writes'; end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;
  select ds.decrypted_secret into v_refresh
    from private.gmail_oauth_credentials c
    join vault.decrypted_secrets ds on ds.id=c.refresh_secret_id
   where c.user_id=v_token.user_id;
  return v_refresh;
end;
$$;
revoke all on function private.chatgpt_server_get_google_refresh_token_internal(text) from public,anon,authenticated,service_role;
grant execute on function private.chatgpt_server_get_google_refresh_token_internal(text) to service_role;

create or replace function private.chatgpt_get_application_tracker_internal(p_access_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_rows jsonb;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for tracker reads'; end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'application_id',a.id,
    'company',coalesce(c.canonical_name,''),
    'role',coalesce(j.title,''),
    'external_job_id',j.external_job_id,
    'application_date',a.applied_at,
    'last_email',le.last_email_at,
    'state',a.state,
    'next_action',a.next_action,
    'deadline',a.deadline_at,
    'notes',a.notes,
    'email_source',case when le.last_email_at is null then null else 'Gmail' end,
    'priority_score',la.priority_score
  ) order by coalesce(a.applied_at,a.updated_at) desc),'[]'::jsonb)
    into v_rows
    from public.applications a
    join public.jobs j on j.id=a.job_id and j.user_id=v_token.user_id
    left join public.companies c on c.id=j.company_id
    left join lateral (
      select max(e.received_at) as last_email_at
        from public.application_email_links l
        join public.emails e on e.id=l.email_id and e.user_id=v_token.user_id
       where l.application_id=a.id and l.is_primary=true
    ) le on true
    left join lateral (
      select ja.priority_score
        from public.job_analyses ja
       where ja.job_id=j.id
       order by ja.created_at desc
       limit 1
    ) la on true
   where a.user_id=v_token.user_id;
  return jsonb_build_object('user_id',v_token.user_id,'records',v_rows);
end;
$$;
revoke all on function private.chatgpt_get_application_tracker_internal(text) from public,anon,authenticated;
grant execute on function private.chatgpt_get_application_tracker_internal(text) to anon,authenticated;

create or replace function private.chatgpt_configure_tracker_sheet_internal(
  p_access_token text,p_spreadsheet_id text,p_spreadsheet_url text,p_title text,p_tab text default 'Applications'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_profile uuid;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for tracker writes'; end if;
  if nullif(btrim(coalesce(p_spreadsheet_id,'')),'') is null then raise exception 'Spreadsheet id is required'; end if;
  if length(coalesce(p_spreadsheet_id,''))>200 or length(coalesce(p_spreadsheet_url,''))>1000 or length(coalesce(p_title,''))>300 then raise exception 'Spreadsheet metadata is too long'; end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;
  select id into v_profile from public.candidate_profiles where user_id=v_token.user_id;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  insert into public.candidate_automation_settings(profile_id,spreadsheet_sync_enabled,google_spreadsheet_id,google_spreadsheet_url,google_spreadsheet_title,google_spreadsheet_tab,updated_at)
  values(v_profile,true,p_spreadsheet_id,nullif(p_spreadsheet_url,''),nullif(p_title,''),coalesce(nullif(p_tab,''),'Applications'),now())
  on conflict(profile_id) do update set spreadsheet_sync_enabled=true,google_spreadsheet_id=excluded.google_spreadsheet_id,google_spreadsheet_url=excluded.google_spreadsheet_url,google_spreadsheet_title=excluded.google_spreadsheet_title,google_spreadsheet_tab=excluded.google_spreadsheet_tab,updated_at=now();
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_token.user_id,'chatgpt',v_token.client_id,'chatgpt.tracker_sheet_configured','google_spreadsheet',null,jsonb_build_object('spreadsheet_id',p_spreadsheet_id,'tab',coalesce(nullif(p_tab,''),'Applications')));
  return private.automation_settings_for_user(v_token.user_id);
end;
$$;
revoke all on function private.chatgpt_configure_tracker_sheet_internal(text,text,text,text,text) from public,anon,authenticated;
grant execute on function private.chatgpt_configure_tracker_sheet_internal(text,text,text,text,text) to anon,authenticated;

create or replace function private.chatgpt_record_tracker_sheet_sync_internal(p_access_token text,p_status text,p_rows integer default 0,p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_profile uuid;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for tracker writes'; end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;
  select id into v_profile from public.candidate_profiles where user_id=v_token.user_id;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;
  insert into public.candidate_automation_settings(profile_id) values(v_profile) on conflict(profile_id) do nothing;
  update public.candidate_automation_settings set last_sheet_sync_at=now(),last_sheet_sync_status=coalesce(nullif(p_status,''),'ok'),last_sheet_sync_rows=greatest(0,coalesce(p_rows,0)),last_sheet_sync_error=nullif(p_error,''),updated_at=now() where profile_id=v_profile;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_token.user_id,'chatgpt',v_token.client_id,'chatgpt.tracker_sheet_sync','google_spreadsheet',null,jsonb_build_object('status',coalesce(nullif(p_status,''),'ok'),'rows',greatest(0,coalesce(p_rows,0)),'error',nullif(p_error,'')));
  return private.automation_settings_for_user(v_token.user_id);
end;
$$;
revoke all on function private.chatgpt_record_tracker_sheet_sync_internal(text,text,integer,text) from public,anon,authenticated;
grant execute on function private.chatgpt_record_tracker_sheet_sync_internal(text,text,integer,text) to anon,authenticated;

create or replace function chatgpt_internal.get_automation_settings(p_access_token text)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_automation_settings_internal(p_access_token); $$;
create or replace function chatgpt_internal.server_get_google_refresh_token(p_access_token text)
returns text language sql security definer set search_path=''
as $$ select private.chatgpt_server_get_google_refresh_token_internal(p_access_token); $$;
create or replace function chatgpt_internal.get_application_tracker(p_access_token text)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_application_tracker_internal(p_access_token); $$;
create or replace function chatgpt_internal.configure_tracker_sheet(p_access_token text,p_spreadsheet_id text,p_spreadsheet_url text,p_title text,p_tab text default 'Applications')
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_configure_tracker_sheet_internal(p_access_token,p_spreadsheet_id,p_spreadsheet_url,p_title,p_tab); $$;
create or replace function chatgpt_internal.record_tracker_sheet_sync(p_access_token text,p_status text,p_rows integer default 0,p_error text default null)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_record_tracker_sheet_sync_internal(p_access_token,p_status,p_rows,p_error); $$;

revoke all on function chatgpt_internal.get_automation_settings(text),chatgpt_internal.server_get_google_refresh_token(text),chatgpt_internal.get_application_tracker(text),chatgpt_internal.configure_tracker_sheet(text,text,text,text,text),chatgpt_internal.record_tracker_sheet_sync(text,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function chatgpt_internal.get_automation_settings(text),chatgpt_internal.get_application_tracker(text),chatgpt_internal.configure_tracker_sheet(text,text,text,text,text),chatgpt_internal.record_tracker_sheet_sync(text,text,integer,text) to anon,authenticated;
grant execute on function chatgpt_internal.server_get_google_refresh_token(text) to service_role;

create or replace function public.chatgpt_get_automation_settings(p_access_token text)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_automation_settings($1); $$;
create or replace function public.chatgpt_server_get_google_refresh_token(p_access_token text)
returns text language sql security invoker set search_path=''
as $$ select chatgpt_internal.server_get_google_refresh_token($1); $$;
create or replace function public.chatgpt_get_application_tracker(p_access_token text)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_application_tracker($1); $$;
create or replace function public.chatgpt_configure_tracker_sheet(p_access_token text,p_spreadsheet_id text,p_spreadsheet_url text,p_title text,p_tab text default 'Applications')
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.configure_tracker_sheet($1,$2,$3,$4,$5); $$;
create or replace function public.chatgpt_record_tracker_sheet_sync(p_access_token text,p_status text,p_rows integer default 0,p_error text default null)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.record_tracker_sheet_sync($1,$2,$3,$4); $$;

revoke all on function public.chatgpt_get_automation_settings(text),public.chatgpt_server_get_google_refresh_token(text),public.chatgpt_get_application_tracker(text),public.chatgpt_configure_tracker_sheet(text,text,text,text,text),public.chatgpt_record_tracker_sheet_sync(text,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.chatgpt_get_automation_settings(text),public.chatgpt_get_application_tracker(text),public.chatgpt_configure_tracker_sheet(text,text,text,text,text),public.chatgpt_record_tracker_sheet_sync(text,text,integer,text) to anon;
grant execute on function public.chatgpt_server_get_google_refresh_token(text) to service_role;
