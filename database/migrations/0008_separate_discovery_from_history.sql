-- Keep historical application records out of the discovery inbox.
update public.jobs j
set discovery_source = 'historical_tracker'
where exists (
  select 1 from public.applications a
  where a.job_id = j.id and a.source_tracker_row is not null
);

create or replace function public.mark_historical_tracker_job()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.source_tracker_row is not null then
    update public.jobs set discovery_source = 'historical_tracker' where id = new.job_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.mark_historical_tracker_job() from public, anon, authenticated;

drop trigger if exists applications_mark_historical_job on public.applications;
create trigger applications_mark_historical_job
after insert or update of source_tracker_row on public.applications
for each row execute function public.mark_historical_tracker_job();
