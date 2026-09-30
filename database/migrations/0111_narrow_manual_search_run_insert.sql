-- Remove the pre-existing table-level INSERT grant from authenticated users.
-- The column-level grant from 0109 remains intact, allowing the SECURITY
-- INVOKER dispatch wrapper to create only the initial, user-owned run linkage.
-- Worker-owned lifecycle, counters, timestamps, and result fields stay out of
-- the authenticated insert boundary.
revoke insert on table public.job_search_runs from authenticated;

grant insert (id,user_id,trigger,state,idempotency_key,source_keys,max_jobs,dispatch_request_id)
  on public.job_search_runs to authenticated;

do $verify$
begin
  if has_table_privilege('authenticated','public.job_search_runs','INSERT') then
    raise exception 'Authenticated users still have table-level INSERT on job_search_runs';
  end if;
  if not has_column_privilege('authenticated','public.job_search_runs','dispatch_request_id','INSERT') then
    raise exception 'Authenticated users lost the required dispatch_request_id column grant';
  end if;
  if has_column_privilege('authenticated','public.job_search_runs','jobs_discovered','INSERT')
     or has_column_privilege('authenticated','public.job_search_runs','summary','INSERT')
     or has_column_privilege('authenticated','public.job_search_runs','error_json','INSERT') then
    raise exception 'Authenticated users retain an unexpected worker-owned job_search_runs insert grant';
  end if;
end;
$verify$;
