-- One-way, revisioned Google Sheets mirror of the live job pool. Supabase stays
-- authoritative; the Sheet is a read-only-by-convention snapshot for ChatGPT.

create table if not exists public.job_pool_sheet_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  source_revision bigint not null default 0 check (source_revision >= 0),
  spreadsheet_id text,
  spreadsheet_url text,
  spreadsheet_title text,
  data_sheet_id integer,
  data_sheet_title text not null default 'Job Pool',
  manifest_sheet_id integer,
  manifest_sheet_title text not null default 'Job Pool Manifest',
  current_publication_id uuid,
  published_revision bigint,
  content_hash text,
  row_count integer not null default 0 check (row_count >= 0),
  drive_file_version text,
  verification_token text,
  drive_verified_at timestamptz,
  drive_verified_version text,
  drive_check_lease_id uuid,
  drive_check_lease_expires_at timestamptz,
  last_synced_at timestamptz,
  last_sync_status text not null default 'not_configured'
    check (last_sync_status in ('not_configured','dirty','syncing','ok','failed')),
  last_sync_error text,
  sync_lease_id uuid,
  sync_lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_pool_sheet_publications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  spreadsheet_id text not null,
  spreadsheet_url text not null,
  data_sheet_id integer not null,
  data_sheet_title text not null,
  manifest_sheet_id integer not null,
  manifest_sheet_title text not null,
  source_revision bigint not null check (source_revision >= 0),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  row_count integer not null check (row_count >= 0),
  drive_file_version text not null,
  verification_token text not null,
  published_at timestamptz not null default now(),
  unique(user_id,id)
);

alter table public.job_pool_sheet_sync
  add constraint job_pool_sheet_sync_publication_owner_fk
  foreign key (user_id,current_publication_id)
  references public.job_pool_sheet_publications(user_id,id)
  deferrable initially deferred;

create index if not exists job_pool_sheet_publications_owner_recent_idx
  on public.job_pool_sheet_publications(user_id,published_at desc);

create table if not exists public.job_search_run_pool_snapshots (
  run_id uuid primary key references public.job_search_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  publication_id uuid not null,
  spreadsheet_url text not null,
  data_sheet_id integer not null,
  data_sheet_title text not null,
  manifest_sheet_id integer not null,
  manifest_sheet_title text not null,
  source_revision bigint not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  row_count integer not null check (row_count >= 0),
  verification_token text not null,
  captured_at timestamptz not null default now(),
  foreign key (user_id,publication_id)
    references public.job_pool_sheet_publications(user_id,id) on delete restrict
);

create index if not exists job_search_run_pool_snapshots_user_idx
  on public.job_search_run_pool_snapshots(user_id,captured_at desc);

alter table public.job_pool_sheet_sync enable row level security;
alter table public.job_pool_sheet_publications enable row level security;
alter table public.job_search_run_pool_snapshots enable row level security;

revoke all on table public.job_pool_sheet_sync from public,anon,authenticated,service_role;
revoke all on table public.job_pool_sheet_publications from public,anon,authenticated,service_role;
revoke all on table public.job_search_run_pool_snapshots from public,anon,authenticated,service_role;
grant select on table public.job_pool_sheet_sync,public.job_pool_sheet_publications to authenticated;
grant select,insert on table public.job_search_run_pool_snapshots to authenticated;

drop policy if exists job_pool_sheet_sync_owner_select on public.job_pool_sheet_sync;
create policy job_pool_sheet_sync_owner_select on public.job_pool_sheet_sync
  for select to authenticated using (user_id=(select auth.uid()));

drop policy if exists job_pool_sheet_publications_owner_select on public.job_pool_sheet_publications;
create policy job_pool_sheet_publications_owner_select on public.job_pool_sheet_publications
  for select to authenticated using (user_id=(select auth.uid()));

drop policy if exists job_search_run_pool_snapshots_owner_select on public.job_search_run_pool_snapshots;
create policy job_search_run_pool_snapshots_owner_select on public.job_search_run_pool_snapshots
  for select to authenticated using (user_id=(select auth.uid()));
drop policy if exists job_search_run_pool_snapshots_owner_insert on public.job_search_run_pool_snapshots;
create policy job_search_run_pool_snapshots_owner_insert on public.job_search_run_pool_snapshots
  for insert to authenticated with check (
    user_id=(select auth.uid())
    and exists(select 1 from public.job_search_runs r where r.id=run_id and r.user_id=(select auth.uid()))
    and exists(select 1 from public.job_pool_sheet_publications p where p.id=publication_id and p.user_id=(select auth.uid()))
  );

create or replace function private.mark_job_pool_sheet_dirty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_old_user uuid;
  v_new_user uuid;
  v_company uuid;
  v_user uuid;
begin
  if tg_table_name='jobs' then
    if tg_op<>'INSERT' then
      v_row:=to_jsonb(old);
      if coalesce(v_row->>'discovery_source','')<>'historical_tracker' then
        v_old_user:=nullif(v_row->>'user_id','')::uuid;
      end if;
    end if;
    if tg_op<>'DELETE' then
      v_row:=to_jsonb(new);
      if coalesce(v_row->>'discovery_source','')<>'historical_tracker' then
        v_new_user:=nullif(v_row->>'user_id','')::uuid;
      end if;
    end if;
    for v_user in select distinct user_id from unnest(array[v_old_user,v_new_user]) as users(user_id) where user_id is not null order by user_id loop
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,846392));
      insert into public.job_pool_sheet_sync(user_id,source_revision,last_sync_status,updated_at)
      values(v_user,1,'dirty',now())
      on conflict(user_id) do update set
        source_revision=public.job_pool_sheet_sync.source_revision+1,
        last_sync_status=case when public.job_pool_sheet_sync.spreadsheet_id is null then 'not_configured' else 'dirty' end,
        drive_verified_at=null,
        drive_verified_version=null,
        last_sync_error=null,
        updated_at=now();
    end loop;
  elsif tg_table_name='companies' then
    if tg_op='UPDATE' and old.canonical_name is not distinct from new.canonical_name then return new; end if;
    v_company:=case when tg_op='DELETE' then old.id else new.id end;
    for v_user in
      select distinct user_id from public.jobs
       where company_id=v_company and archived_at is null
         and discovery_source is distinct from 'historical_tracker'
       order by user_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,846392));
      insert into public.job_pool_sheet_sync(user_id,source_revision,last_sync_status,updated_at)
      values(v_user,1,'dirty',now())
      on conflict(user_id) do update set
        source_revision=public.job_pool_sheet_sync.source_revision+1,
        last_sync_status=case when public.job_pool_sheet_sync.spreadsheet_id is null then 'not_configured' else 'dirty' end,
        drive_verified_at=null,
        drive_verified_version=null,
        last_sync_error=null,
        updated_at=now();
    end loop;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

revoke all on function private.mark_job_pool_sheet_dirty() from public,anon,authenticated,service_role;

drop trigger if exists jobs_mark_job_pool_sheet_dirty on public.jobs;
create trigger jobs_mark_job_pool_sheet_dirty
  after insert or update or delete on public.jobs
  for each row execute function private.mark_job_pool_sheet_dirty();

drop trigger if exists companies_mark_job_pool_sheet_dirty on public.companies;
create trigger companies_mark_job_pool_sheet_dirty
  after update of canonical_name on public.companies
  for each row execute function private.mark_job_pool_sheet_dirty();

create or replace function public.begin_job_pool_sheet_sync(p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_state public.job_pool_sheet_sync;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_lease_id is null then raise exception 'A sync lease id is required'; end if;
  perform private.assert_current_user_active_app_membership();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,846392));
  insert into public.job_pool_sheet_sync(user_id) values(v_user) on conflict(user_id) do nothing;

  if exists(
    select 1 from public.job_search_runs r
     where r.user_id=v_user and r.state in ('queued','running','importing')
  ) then
    return jsonb_build_object('ok',false,'reason','active_search');
  end if;

  if exists(select 1 from public.job_pool_sheet_sync s where s.user_id=v_user
       and s.drive_check_lease_expires_at>now()) then
    return jsonb_build_object('ok',false,'reason','drive_check_active');
  end if;

  update public.job_pool_sheet_sync
     set sync_lease_id=p_lease_id,sync_lease_expires_at=now()+interval '10 minutes',
         last_sync_status=case when spreadsheet_id is null then 'not_configured' else 'syncing' end,
         updated_at=now()
   where user_id=v_user and (sync_lease_expires_at is null or sync_lease_expires_at<=now())
     and (drive_check_lease_expires_at is null or drive_check_lease_expires_at<=now())
   returning * into v_state;
  if not found then return jsonb_build_object('ok',false,'reason','sync_busy'); end if;
  return jsonb_build_object(
    'ok',true,'lease_id',p_lease_id,'source_revision',v_state.source_revision,
    'spreadsheet_id',v_state.spreadsheet_id,'spreadsheet_url',v_state.spreadsheet_url,
    'spreadsheet_title',v_state.spreadsheet_title,'data_sheet_id',v_state.data_sheet_id,
    'data_sheet_title',v_state.data_sheet_title,'manifest_sheet_id',v_state.manifest_sheet_id,
    'manifest_sheet_title',v_state.manifest_sheet_title,'current_publication_id',v_state.current_publication_id,
    'published_revision',v_state.published_revision,'content_hash',v_state.content_hash,
    'row_count',v_state.row_count,'drive_file_version',v_state.drive_file_version,
    'verification_token',v_state.verification_token,'last_sync_status',v_state.last_sync_status
  );
end;
$$;

create or replace function public.finish_job_pool_sheet_sync(
  p_lease_id uuid,
  p_snapshot jsonb default null,
  p_error text default null,
  p_keep_lease boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_state public.job_pool_sheet_sync;
  v_publication public.job_pool_sheet_publications;
  v_revision bigint;
  v_row_count integer;
  v_data_sheet_id integer;
  v_manifest_sheet_id integer;
  v_spreadsheet_id text;
  v_spreadsheet_url text;
  v_spreadsheet_title text;
  v_data_title text;
  v_manifest_title text;
  v_hash text;
  v_file_version text;
  v_token text;
  v_publication_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_lease_id is null then raise exception 'A sync lease id is required'; end if;
  perform private.assert_current_user_active_app_membership();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,846392));
  select * into v_state from public.job_pool_sheet_sync where user_id=v_user and sync_lease_id=p_lease_id for update;
  if not found then raise exception 'The job-pool Sheet sync lease expired'; end if;

  if p_snapshot is null then
    if p_keep_lease then
      update public.job_pool_sheet_sync set sync_lease_expires_at=now()+interval '10 minutes',updated_at=now()
       where user_id=v_user and sync_lease_id=p_lease_id;
      return jsonb_build_object('ok',true,'lease_kept',true);
    end if;
    update public.job_pool_sheet_sync set sync_lease_id=null,sync_lease_expires_at=null,
      drive_verified_at=null,drive_verified_version=null,
      last_sync_status=case when p_error is not null then 'failed' when spreadsheet_id is null then 'not_configured' when published_revision is distinct from source_revision then 'dirty' else 'ok' end,
      last_sync_error=case when p_error is null then last_sync_error else left(p_error,1000) end,
      updated_at=now() where user_id=v_user and sync_lease_id=p_lease_id;
    if p_error is not null then
      return jsonb_build_object('ok',false,'error',left(p_error,1000));
    end if;
    return jsonb_build_object('ok',true,'released',true);
  end if;

  if jsonb_typeof(p_snapshot)<>'object' then raise exception 'A verified Sheet snapshot is required'; end if;
  v_revision:=nullif(p_snapshot->>'source_revision','')::bigint;
  v_row_count:=nullif(p_snapshot->>'row_count','')::integer;
  v_data_sheet_id:=nullif(p_snapshot->>'data_sheet_id','')::integer;
  v_manifest_sheet_id:=nullif(p_snapshot->>'manifest_sheet_id','')::integer;
  v_spreadsheet_id:=nullif(btrim(p_snapshot->>'spreadsheet_id'),'');
  v_spreadsheet_url:=nullif(btrim(p_snapshot->>'spreadsheet_url'),'');
  v_spreadsheet_title:=nullif(btrim(p_snapshot->>'spreadsheet_title'),'');
  v_data_title:=nullif(btrim(p_snapshot->>'data_sheet_title'),'');
  v_manifest_title:=nullif(btrim(p_snapshot->>'manifest_sheet_title'),'');
  v_hash:=nullif(p_snapshot->>'content_hash','');
  v_file_version:=nullif(p_snapshot->>'drive_file_version','');
  v_token:=nullif(p_snapshot->>'verification_token','');
  v_publication_id:=nullif(p_snapshot->>'publication_id','')::uuid;
  if v_revision is null or v_revision<0 or v_row_count is null or v_row_count<0 or v_row_count>25000
     or v_data_sheet_id is null or v_data_sheet_id<0 or v_manifest_sheet_id is null or v_manifest_sheet_id<0
     or v_spreadsheet_id is null or v_spreadsheet_id !~ '^[A-Za-z0-9_-]{10,200}$'
     or v_spreadsheet_url is null or v_spreadsheet_url !~ ('^https://docs\.google\.com/spreadsheets/d/'||v_spreadsheet_id||'/edit([?#].*)?$')
     or v_spreadsheet_title is null or length(v_spreadsheet_title)>160
     or v_data_title is distinct from 'Job Pool' or v_manifest_title is distinct from 'Job Pool Manifest'
     or v_hash is null or v_hash !~ '^[a-f0-9]{64}$'
     or v_file_version is null or length(v_file_version)>100
     or v_token is null or v_token !~ '^[0-9a-f-]{36}$'
     or v_publication_id is null then
    raise exception 'The job-pool Sheet snapshot metadata is invalid';
  end if;
  if v_state.source_revision is distinct from v_revision then
    update public.job_pool_sheet_sync set sync_lease_id=null,sync_lease_expires_at=null,
      drive_verified_at=null,drive_verified_version=null,
      last_sync_status=case when spreadsheet_id is null then 'not_configured' else 'dirty' end,
      last_sync_error='The job pool changed while the Sheet was being updated. Sync again before searching.',updated_at=now()
     where user_id=v_user;
    return jsonb_build_object('ok',false,'reason','source_changed','source_revision',v_state.source_revision);
  end if;

  if v_state.current_publication_id is not null
     and v_state.current_publication_id=v_publication_id
     and v_state.spreadsheet_id=v_spreadsheet_id
     and v_state.published_revision=v_revision
     and v_state.content_hash=v_hash
     and v_state.verification_token=v_token
     and v_state.data_sheet_id=v_data_sheet_id
     and v_state.manifest_sheet_id=v_manifest_sheet_id then
    update public.job_pool_sheet_publications set drive_file_version=v_file_version
      where id=v_state.current_publication_id and user_id=v_user returning * into v_publication;
  else
    insert into public.job_pool_sheet_publications(
      id,user_id,spreadsheet_id,spreadsheet_url,data_sheet_id,data_sheet_title,manifest_sheet_id,manifest_sheet_title,
      source_revision,content_hash,row_count,drive_file_version,verification_token
    ) values(
      v_publication_id,v_user,v_spreadsheet_id,v_spreadsheet_url,v_data_sheet_id,v_data_title,v_manifest_sheet_id,v_manifest_title,
      v_revision,v_hash,v_row_count,v_file_version,v_token
    ) returning * into v_publication;
  end if;

  update public.job_pool_sheet_sync set
    spreadsheet_id=v_spreadsheet_id,spreadsheet_url=v_spreadsheet_url,spreadsheet_title=v_spreadsheet_title,
    data_sheet_id=v_data_sheet_id,data_sheet_title=v_data_title,
    manifest_sheet_id=v_manifest_sheet_id,manifest_sheet_title=v_manifest_title,
    current_publication_id=v_publication.id,published_revision=v_revision,content_hash=v_hash,row_count=v_row_count,
    drive_file_version=v_file_version,verification_token=v_token,last_synced_at=now(),last_sync_status='ok',
    drive_verified_at=now(),drive_verified_version=v_file_version,
    drive_check_lease_id=null,drive_check_lease_expires_at=null,
    last_sync_error=null,
    sync_lease_id=case when p_keep_lease then p_lease_id else null end,
    sync_lease_expires_at=case when p_keep_lease then now()+interval '10 minutes' else null end,
    updated_at=now()
   where user_id=v_user;
  update public.job_search_controls set
    next_scheduled_search_at=case when search_schedule_enabled and next_scheduled_search_at<=now() then now() else next_scheduled_search_at end,
    last_scheduled_search_error=null,updated_at=now()
   where user_id=v_user;
  return jsonb_build_object('ok',true,'publication_id',v_publication.id,'source_revision',v_revision,
    'content_hash',v_hash,'row_count',v_row_count,'spreadsheet_url',v_spreadsheet_url,
    'data_sheet_id',v_data_sheet_id,'data_sheet_title',v_data_title,
    'manifest_sheet_id',v_manifest_sheet_id,'manifest_sheet_title',v_manifest_title,
    'verification_token',v_token,'drive_file_version',v_file_version);
end;
$$;

revoke all on function public.begin_job_pool_sheet_sync(uuid) from public,anon,service_role;
grant execute on function public.begin_job_pool_sheet_sync(uuid) to authenticated;
revoke all on function public.finish_job_pool_sheet_sync(uuid,jsonb,text,boolean) from public,anon,service_role;
grant execute on function public.finish_job_pool_sheet_sync(uuid,jsonb,text,boolean) to authenticated;

-- The database cron cannot call Google. A trusted Supabase Edge Function claims
-- due users, and the Cloudflare scheduled handler checks Drive's O(1) file
-- version using each user's refresh credential. A search is eligible only
-- after this short-lived, lease-bound check confirms the exact published file.
create or replace function public.claim_due_job_pool_sheet_checks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due record;
  v_pool public.job_pool_sheet_sync;
  v_lease uuid;
  v_refresh_token text;
  v_result jsonb := '[]'::jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;

  for v_due in
    select c.user_id,c.next_scheduled_search_at
      from public.job_search_controls c
      join public.candidate_profiles p on p.user_id=c.user_id
      join public.candidate_preferences cp on cp.profile_id=p.id
      join private.app_memberships m on m.user_id=c.user_id and m.status='active'
     where c.search_schedule_enabled=true and c.next_scheduled_search_at<=now()
       and coalesce(cp.preferences->>'search_cadence','daily') in ('daily','weekdays','weekly')
     order by c.next_scheduled_search_at,c.user_id
     limit 25
     for update of c skip locked
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_due.user_id::text,846392));
    select * into v_pool from public.job_pool_sheet_sync where user_id=v_due.user_id for update;
    if not found or v_pool.spreadsheet_id is null or v_pool.current_publication_id is null
       or v_pool.last_sync_status<>'ok'
       or v_pool.source_revision is distinct from v_pool.published_revision
       or (v_pool.sync_lease_expires_at is not null and v_pool.sync_lease_expires_at>now())
       or (v_pool.drive_check_lease_expires_at is not null and v_pool.drive_check_lease_expires_at>now())
       or exists(
         select 1 from public.job_search_runs r
          where r.user_id=v_due.user_id and r.state in ('queued','running','importing')
       ) then
      continue;
    end if;

    v_lease:=gen_random_uuid();
    select ds.decrypted_secret into v_refresh_token
      from private.gmail_oauth_credentials c
      join vault.decrypted_secrets ds on ds.id=c.refresh_secret_id
     where c.user_id=v_due.user_id;
    update public.job_pool_sheet_sync set
      drive_verified_at=null,drive_verified_version=null,
      drive_check_lease_id=v_lease,drive_check_lease_expires_at=now()+interval '2 minutes',updated_at=now()
     where user_id=v_due.user_id;
    v_result:=v_result||jsonb_build_array(jsonb_build_object(
      'user_id',v_due.user_id,'lease_id',v_lease,'spreadsheet_id',v_pool.spreadsheet_id,
      'expected_drive_file_version',v_pool.drive_file_version,'source_revision',v_pool.source_revision,
      'refresh_token',v_refresh_token
    ));
  end loop;
  return v_result;
end;
$$;
revoke all on function public.claim_due_job_pool_sheet_checks() from public,anon,authenticated,service_role;
grant execute on function public.claim_due_job_pool_sheet_checks() to service_role;

create or replace function public.finish_job_pool_sheet_drive_check(
  p_user_id uuid,
  p_lease_id uuid,
  p_source_revision bigint,
  p_observed_version text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pool public.job_pool_sheet_sync;
  v_error text:=left(nullif(btrim(coalesce(p_error,'')),''),300);
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_user_id is null or p_lease_id is null then raise exception 'A user and drive-check lease are required'; end if;
  select * into v_pool from public.job_pool_sheet_sync
   where user_id=p_user_id and drive_check_lease_id=p_lease_id
     and drive_check_lease_expires_at>now()
   for update;
  if not found then raise exception 'The Job Pool Sheet Drive-check lease expired'; end if;

  if v_error is not null then
    update public.job_pool_sheet_sync set
      drive_verified_at=null,drive_verified_version=null,
      drive_check_lease_id=null,drive_check_lease_expires_at=null,
      last_sync_status=case when v_error in ('google_reconnect_required','google_sheet_not_accessible') then 'failed' else last_sync_status end,
      last_sync_error=case when v_error in ('google_reconnect_required','google_sheet_not_accessible') then v_error else last_sync_error end,
      updated_at=now()
     where user_id=p_user_id and drive_check_lease_id=p_lease_id;
    update public.job_search_controls set
      last_scheduled_search_error=case
        when v_error='google_reconnect_required' then 'Reconnect Google in Settings before a scheduled search can verify the Job Pool Sheet.'
        when v_error='google_sheet_not_accessible' then 'The Job Pool Sheet is no longer accessible. Reconnect Google or sync a new managed Sheet.'
        else 'The scheduled search could not verify the Google Sheet version. It will retry shortly.'
      end,
      next_scheduled_search_at=case
        when v_error in ('google_reconnect_required','google_sheet_not_accessible') then now()+interval '15 minutes'
        else next_scheduled_search_at
      end,
      updated_at=now()
     where user_id=p_user_id;
    return jsonb_build_object('ok',false,'reason',v_error);
  end if;

  if p_observed_version is null or length(p_observed_version)>100 then
    raise exception 'A valid Google Drive file version is required';
  end if;
  if v_pool.source_revision is distinct from p_source_revision
     or v_pool.source_revision is distinct from v_pool.published_revision
     or v_pool.last_sync_status is distinct from 'ok' then
    update public.job_pool_sheet_sync set
      drive_verified_at=null,drive_verified_version=null,
      drive_check_lease_id=null,drive_check_lease_expires_at=null,
      last_sync_status='dirty',last_sync_error='The job pool changed while its scheduled Google Sheet version was being checked. Sync it before the next search.',updated_at=now()
     where user_id=p_user_id and drive_check_lease_id=p_lease_id;
    update public.job_search_controls set last_scheduled_search_error='The job pool changed during Sheet verification. The scheduled search is held until the next sync.',
      updated_at=now() where user_id=p_user_id;
    return jsonb_build_object('ok',false,'reason','source_changed');
  end if;

  if v_pool.drive_file_version is distinct from p_observed_version then
    update public.job_pool_sheet_sync set
      drive_verified_at=null,drive_verified_version=null,
      drive_check_lease_id=null,drive_check_lease_expires_at=null,
      last_sync_status='dirty',last_sync_error='The Google Sheet changed outside the database publication. Sync the Job Pool Sheet before searching.',updated_at=now()
     where user_id=p_user_id and drive_check_lease_id=p_lease_id;
    update public.job_search_controls set last_scheduled_search_error='The Google Sheet changed since its last verified publication. Sync the Job Pool Sheet before the scheduled search can run.',
      next_scheduled_search_at=now()+interval '15 minutes',updated_at=now() where user_id=p_user_id;
    return jsonb_build_object('ok',false,'reason','sheet_changed');
  end if;

  update public.job_pool_sheet_sync set
    drive_verified_at=now(),drive_verified_version=p_observed_version,
    drive_check_lease_id=null,drive_check_lease_expires_at=null,updated_at=now()
   where user_id=p_user_id and drive_check_lease_id=p_lease_id;
  return jsonb_build_object('ok',true,'drive_file_version',p_observed_version,'source_revision',p_source_revision);
end;
$$;
revoke all on function public.finish_job_pool_sheet_drive_check(uuid,uuid,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_job_pool_sheet_drive_check(uuid,uuid,bigint,text,text) to service_role;

comment on function public.claim_due_job_pool_sheet_checks() is
  'Service-only claim that leases due scheduled users and returns only the Google credentials needed for one Drive metadata version check.';
comment on function public.finish_job_pool_sheet_drive_check(uuid,uuid,bigint,text,text) is
  'Service-only, lease-bound recording of a scheduled Google Drive version check; a mismatch marks the Sheet dirty and blocks search dispatch.';

create or replace function public.create_manual_job_search_dispatch_with_pool_snapshot(
  p_run_id uuid,
  p_idempotency_key text,
  p_website_instruction text,
  p_source_keys text[],
  p_publication_id uuid,
  p_lease_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
  v_run_id uuid;
  v_publication public.job_pool_sheet_publications;
  v_existing public.job_search_run_pool_snapshots;
  v_pool public.job_pool_sheet_sync;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_current_user_active_app_membership();
  if p_publication_id is null or p_lease_id is null then raise exception 'A verified job-pool Sheet publication and sync lease are required'; end if;
  -- Serialize with the job-pool dirty trigger. Mutations committed before this
  -- lock are observed as a newer revision; later mutations follow this exact
  -- dispatch boundary.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,846392));
  select * into v_pool from public.job_pool_sheet_sync where user_id=v_user;
  if not found or v_pool.current_publication_id is distinct from p_publication_id
     or v_pool.source_revision is distinct from v_pool.published_revision
     or v_pool.last_sync_status is distinct from 'ok'
     or v_pool.drive_verified_at is null or v_pool.drive_verified_at<now()-interval '2 minutes'
     or v_pool.drive_verified_version is distinct from v_pool.drive_file_version
     or v_pool.sync_lease_id is distinct from p_lease_id
     or v_pool.sync_lease_expires_at is null or v_pool.sync_lease_expires_at<=now() then
    raise exception 'The Job Pool Sheet changed before the search could be dispatched. Sync again; no search was sent.';
  end if;
  select * into v_publication from public.job_pool_sheet_publications
   where id=p_publication_id and user_id=v_user;
  if not found then raise exception 'The job-pool Sheet publication is not owned by this user'; end if;

  v_result:=public.create_manual_job_search_dispatch(p_run_id,p_idempotency_key,p_website_instruction,p_source_keys);
  if coalesce(v_result->>'ok','false')<>'true' then return v_result; end if;
  v_run_id:=nullif(v_result->>'run_id','')::uuid;
  if v_run_id is null then raise exception 'The manual search run was not returned'; end if;
  select * into v_existing from public.job_search_run_pool_snapshots where run_id=v_run_id and user_id=v_user;
  if not found then
    insert into public.job_search_run_pool_snapshots(
      run_id,user_id,publication_id,spreadsheet_url,data_sheet_id,data_sheet_title,
      manifest_sheet_id,manifest_sheet_title,source_revision,content_hash,row_count,verification_token
    ) values(
      v_run_id,v_user,v_publication.id,v_publication.spreadsheet_url,v_publication.data_sheet_id,v_publication.data_sheet_title,
      v_publication.manifest_sheet_id,v_publication.manifest_sheet_title,v_publication.source_revision,
      v_publication.content_hash,v_publication.row_count,v_publication.verification_token
    );
  end if;
  return v_result;
end;
$$;
revoke all on function public.create_manual_job_search_dispatch_with_pool_snapshot(uuid,text,text,text[],uuid,uuid) from public,anon,service_role;
grant execute on function public.create_manual_job_search_dispatch_with_pool_snapshot(uuid,text,text,text[],uuid,uuid) to authenticated;

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
  v_pool public.job_pool_sheet_sync;
  v_publication public.job_pool_sheet_publications;
begin
  select * into v_pool from public.job_pool_sheet_sync where user_id=p_user;
  if not found or v_pool.current_publication_id is null or v_pool.spreadsheet_id is null
     or v_pool.source_revision is distinct from v_pool.published_revision
     or v_pool.last_sync_status is distinct from 'ok'
     or v_pool.drive_verified_at is null or v_pool.drive_verified_at<now()-interval '2 minutes'
     or v_pool.drive_verified_version is distinct from v_pool.drive_file_version then
    raise exception 'The Job Pool Sheet is not connected and current. Open Settings, create/sync the managed Sheet, and retry.';
  end if;
  select * into v_publication from public.job_pool_sheet_publications
   where id=v_pool.current_publication_id and user_id=p_user;
  if not found then raise exception 'The current Job Pool Sheet publication could not be verified'; end if;

  select left(jsonb_build_object(
    'experience',coalesce((select jsonb_agg(jsonb_build_object('role',left(e.role_title,100),'employer',left(e.employer,100),'details',left(e.details,180))) from (select role_title,employer,details from public.candidate_employment where profile_id=p_profile_id and verification_status='verified' order by start_date desc nulls last limit 4) e),'[]'::jsonb),
    'education',coalesce((select jsonb_agg(jsonb_build_object('qualification',left(e.qualification,100),'institution',left(e.institution,100),'field',left(e.field_of_study,100))) from (select qualification,institution,field_of_study from public.candidate_education where profile_id=p_profile_id and verification_status='verified' order by start_date desc nulls last limit 3) e),'[]'::jsonb),
    'skills',coalesce((select jsonb_agg(jsonb_build_object('name',left(s.name,100),'proficiency',left(s.proficiency,80),'years',s.years_experience)) from (select name,proficiency,years_experience from public.candidate_skills where profile_id=p_profile_id and verification_status='verified' order by name limit 12) s),'[]'::jsonb),
    'evidence',coalesce((select jsonb_agg(jsonb_build_object('claim',left(e.claim,160),'detail',left(e.detail,140))) from (select claim,detail from public.evidence_items where profile_id=p_profile_id and verification_status='verified' order by strength desc limit 4) e),'[]'::jsonb)
  )::text,1400) into v_profile_summary;

  v_prompt := concat_ws(E'\n',
    'Run one bounded, read-only job search now. This is a one-time search, not a scheduled task.',
    'Do not create or change any ChatGPT Task or schedule. Do not apply, sign in, contact employers, or make external commitments.',
    'Before searching, open the linked Google Sheet using your connected Google Drive access. Read the entire active job data tab and its manifest, not a Drive search snippet. Do not return any new vacancy unless you can verify the manifest token and confirm rows_read equals the manifest row_count. If the Sheet is inaccessible or incomplete, return no results and report that access/read was unavailable; do not guess.',
    'Job Pool Sheet: '||v_publication.spreadsheet_url||'#gid='||v_publication.data_sheet_id::text,
    'Active data tab: '||v_publication.data_sheet_title||' (gid '||v_publication.data_sheet_id::text||'). Manifest tab: '||v_publication.manifest_sheet_title||' (gid '||v_publication.manifest_sheet_id::text||'). Publication id: '||v_publication.id::text||'. Expected revision: '||v_publication.source_revision::text||'. Expected active job rows: '||v_publication.row_count::text||'. The verification token is in the manifest and is deliberately not included in this instruction.',
    'Use existing job IDs, links, company/title/location/salary details and user status to avoid duplicates and avoid recommending jobs already applied to or closed. The Sheet is a read-only mirror; never edit it.',
    'Search only enabled public sources, inspect each listing, return no more than 10 distinct vacancies, preserve exact listing URLs, and do not invent missing facts. Keep every application behind human review.',
    'Profile-fit assessments must cite concrete evidence from the verified background included below. Never change the user controlled locations, salary, work modes, sponsorship, excluded industries, or posting-age constraints.',
    'This search run_id is '||p_run_id::text||'. Return exactly one JSON object and no markdown using this envelope: {"run_id":"'||p_run_id::text||'","job_pool_snapshot":{"publication_id":"'||v_publication.id::text||'","revision":'||v_publication.source_revision::text||',"access_check_token":"<exact token read from the manifest>","rows_read":'||v_publication.row_count::text||'},"jobs_checked":0,"summary":"short outcome","results":[]}. Each result is {"status":"found","source_url":"https://example.com/job","job":{"company":"…","title":"…","description":"at least 40 grounded characters","salary_source":"not_available","salary_basis":[],"responsibilities":[],"essential_requirements":[],"desirable_requirements":[],"skills":[],"benefits":[],"raw_metadata":{}}} or {"status":"unavailable","source_url":null,"reason":"brief reason"}. Use only these job keys: company,title,industry,description,application_url,external_job_id,location,work_mode,salary_text,salary_min,salary_max,salary_currency,salary_source,salary_confidence,salary_basis,posted_at,closes_at,employment_type,ats_provider,summary,responsibilities,essential_requirements,desirable_requirements,skills,benefits,application_instructions,company_website,raw_metadata. salary_source is exactly advertised, chatgpt_estimate, or not_available. Clearly label estimates and include salary_basis; never invent a salary. jobs_checked counts distinct new public listings reviewed, not rows in the existing Sheet.',
    'Role discovery: '||case when v_mode='profile' then 'infer suitable role titles, seniority and industries from the verified evidence; do not infer user constraints.' when v_mode='keywords' then 'use only the supplied keywords and role families.' else 'start with the supplied keywords and use verified evidence to rank fit.' end,
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
    v_prompt:='TEST ONLY — The following message is a test. Do not add, save, or update anything from it to ChatGPT Memory or long-term memory. Treat the request below as a test and answer it without changing Memory.'||E'\n\n'||v_prompt;
  end if;
  if length(v_prompt)>6000 then raise exception 'Scheduled search instruction exceeds the Website Bridge limit'; end if;
  if v_prompt ~* '(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)' then
    raise exception 'Scheduled search instruction contains bridge protocol text';
  end if;
  return v_prompt;
end;
$$;
revoke all on function private.build_scheduled_job_search_instruction(uuid,uuid,jsonb,text[],uuid,boolean) from public,anon,authenticated,service_role;

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
  v_pool public.job_pool_sheet_sync;
  v_publication public.job_pool_sheet_publications;
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
      v_preferences:=v_due.preferences;
      v_profile_id:=v_due.profile_id;
      v_window_key:='scheduled:'||v_due.user_id::text||':'||to_char(v_due.next_scheduled_search_at at time zone 'UTC','YYYYMMDDHH24MI');
      select id into v_run_id from public.job_search_runs where user_id=v_due.user_id and idempotency_key=v_window_key;
      if v_run_id is not null then
        v_next:=private.next_job_search_due_at(v_preferences->>'search_cadence',v_due.search_schedule_time,v_due.search_schedule_timezone,now());
        update public.job_search_controls set next_scheduled_search_at=v_next,last_scheduled_search_error=null,updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;

      if exists(
        select 1 from public.job_search_runs r
        join public.chatgpt_dispatch_requests d on d.id=r.dispatch_request_id and d.user_id=r.user_id
        where r.user_id=v_due.user_id and r.state in ('queued','running')
          and d.state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready','send_attempted','sent','acknowledged_by_mcp','running')
      ) then
        update public.job_search_controls set last_scheduled_search_error='A previous bridge search is still active. The scheduled run will wait to avoid duplicate work.',updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;

      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_due.user_id::text,846392));
      select * into v_pool from public.job_pool_sheet_sync where user_id=v_due.user_id;
      if not found or v_pool.spreadsheet_id is null or v_pool.current_publication_id is null then
        update public.job_search_controls set last_scheduled_search_error='Create the managed Job Pool Sheet in Settings before scheduled searches can run.',
          next_scheduled_search_at=now()+interval '15 minutes',updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;
      if v_pool.source_revision is distinct from v_pool.published_revision then
        update public.job_search_controls set last_scheduled_search_error='The job pool Sheet is catching up with the database. The scheduled search will retry shortly.',
          updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;
      if v_pool.last_sync_status is distinct from 'ok' then
        update public.job_search_controls set last_scheduled_search_error='The Job Pool Sheet must be synchronized and verified before the scheduled search can run.',
          updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;
      if (v_pool.sync_lease_id is not null and v_pool.sync_lease_expires_at>now())
         or (v_pool.drive_check_lease_id is not null and v_pool.drive_check_lease_expires_at>now()) then
        update public.job_search_controls set last_scheduled_search_error='The Job Pool Sheet is being synchronized or verified. The scheduled search will retry shortly.',
          updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;
      if v_pool.drive_verified_at is null or v_pool.drive_verified_at<now()-interval '2 minutes'
         or v_pool.drive_verified_version is distinct from v_pool.drive_file_version then
        update public.job_search_controls set last_scheduled_search_error='The Google Drive version of the Job Pool Sheet has not been verified yet. The scheduled search will retry shortly.',
          updated_at=now() where user_id=v_due.user_id;
        continue;
      end if;
      select * into v_publication from public.job_pool_sheet_publications
       where id=v_pool.current_publication_id and user_id=v_due.user_id;
      if not found then raise exception 'The current Job Pool Sheet publication could not be verified'; end if;

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
      v_run_id:=gen_random_uuid();
      v_instruction:=private.build_scheduled_job_search_instruction(v_due.user_id,v_profile_id,v_preferences,v_sources,v_run_id,v_testing);
      v_next:=private.next_job_search_due_at(v_preferences->>'search_cadence',v_due.search_schedule_time,v_due.search_schedule_timezone,now());
      perform set_config('request.jwt.claim.sub',v_due.user_id::text,true);
      v_dispatch:=public.create_chatgpt_dispatch_request_with_website_instruction(
        'jobs.search.manual','{}'::jsonb,'explicit_automation','Scheduled job search',v_window_key,65,v_instruction
      );
      v_dispatch_id:=nullif(v_dispatch->>'id','')::uuid;
      if v_dispatch_id is null then raise exception 'Generic Website Bridge dispatch did not return a request id'; end if;

      insert into public.job_search_runs(id,user_id,trigger,state,idempotency_key,source_keys,max_jobs,dispatch_request_id,next_run_at)
      values(v_run_id,v_due.user_id,'scheduled','queued',v_window_key,v_source_keys,10,v_dispatch_id,v_next);
      insert into public.job_search_run_pool_snapshots(
        run_id,user_id,publication_id,spreadsheet_url,data_sheet_id,data_sheet_title,
        manifest_sheet_id,manifest_sheet_title,source_revision,content_hash,row_count,verification_token
      ) values(
        v_run_id,v_due.user_id,v_publication.id,v_publication.spreadsheet_url,v_publication.data_sheet_id,v_publication.data_sheet_title,
        v_publication.manifest_sheet_id,v_publication.manifest_sheet_title,v_publication.source_revision,
        v_publication.content_hash,v_publication.row_count,v_publication.verification_token
      );
      update public.job_search_controls set next_scheduled_search_at=v_next,last_scheduled_search_at=now(),
        last_scheduled_window_key=v_window_key,last_scheduled_search_error=null,updated_at=now() where user_id=v_due.user_id;
      v_count:=v_count+1;
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

comment on table public.job_pool_sheet_sync is
  'Per-user integrity state for a one-way Sheet projection of public job-listing metadata. Supabase jobs remain authoritative.';
comment on table public.job_pool_sheet_publications is
  'Immutable, user-scoped records for verified Job Pool Sheet publications referenced by specific search runs.';
comment on table public.job_search_run_pool_snapshots is
  'Exact Google Sheet publication bound to each manual or scheduled search so captured results can be checked against the same snapshot.';
