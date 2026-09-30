-- Reuse the existing owner-scoped Job Pool publication as the canonical
-- workbook pointer. If a member already configured the application tracker,
-- its selected workbook is adopted on the first managed sync instead of
-- creating a second file. Existing spreadsheet contents are never deleted.

create or replace function public.begin_job_pool_sheet_sync(p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_state public.job_pool_sheet_sync;
  v_profile uuid;
  v_tracker_id text;
  v_tracker_url text;
  v_tracker_title text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_lease_id is null then raise exception 'A sync lease id is required'; end if;
  perform private.assert_current_user_active_app_membership();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,846392));
  insert into public.job_pool_sheet_sync(user_id) values(v_user) on conflict(user_id) do nothing;

  select * into v_state from public.job_pool_sheet_sync where user_id=v_user for update;
  if v_state.spreadsheet_id is null then
    select p.id into v_profile from public.candidate_profiles p where p.user_id=v_user;
    if v_profile is not null then
      select a.google_spreadsheet_id,a.google_spreadsheet_url,a.google_spreadsheet_title
        into v_tracker_id,v_tracker_url,v_tracker_title
        from public.candidate_automation_settings a where a.profile_id=v_profile;
      if v_tracker_id ~ '^[A-Za-z0-9_-]{10,200}$' then
        update public.job_pool_sheet_sync set
          spreadsheet_id=v_tracker_id,
          spreadsheet_url=coalesce(nullif(v_tracker_url,''),'https://docs.google.com/spreadsheets/d/'||v_tracker_id||'/edit'),
          spreadsheet_title=coalesce(nullif(v_tracker_title,''),'JobHuntAI'),
          last_sync_status='dirty',last_sync_error=null,updated_at=now()
         where user_id=v_user returning * into v_state;
      end if;
    end if;
  end if;

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

comment on function public.begin_job_pool_sheet_sync(uuid) is
  'Begins an owner-scoped Job Pool publication and adopts an already configured application-tracker workbook when no Job Pool workbook is linked.';
