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
    for v_user in
      select distinct users.user_id
        from unnest(array[v_old_user,v_new_user]) as users(user_id)
       where users.user_id is not null
         and exists(select 1 from auth.users u where u.id=users.user_id)
       order by users.user_id
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
  elsif tg_table_name='companies' then
    if tg_op='UPDATE' and old.canonical_name is not distinct from new.canonical_name then return new; end if;
    v_company:=case when tg_op='DELETE' then old.id else new.id end;
    for v_user in
      select distinct j.user_id from public.jobs j
       where j.company_id=v_company and j.archived_at is null
         and j.discovery_source is distinct from 'historical_tracker'
         and exists(select 1 from auth.users u where u.id=j.user_id)
       order by j.user_id
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

comment on function private.mark_job_pool_sheet_dirty() is
  'Marks a member Job Pool Sheet dirty for live users while avoiding a reinsert during auth-user cascade deletion.';
