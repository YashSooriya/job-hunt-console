-- A stale legacy run without any Website Bridge dispatch cannot still be
-- performing work. Do not let that historical row prevent the service-only
-- scheduled Drive-version verifier from refreshing the managed Sheet proof.
-- Recent and dispatch-linked queued/running/importing rows still block checks.

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
            and not (
              r.dispatch_request_id is null
              and r.created_at < now()-interval '45 minutes'
            )
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
