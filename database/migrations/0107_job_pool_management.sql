-- Reversible job-pool removal and an explicit user-owned workflow state.
-- AI triage remains stored in jobs.triage and is deliberately independent.
alter table public.jobs
  add column industry text,
  add column archived_at timestamptz,
  add column user_status text not null default 'new'
    check (user_status in ('new', 'reviewing', 'interested', 'not_interested', 'applied', 'closed'));

update public.jobs as job
set industry = snapshot.raw_metadata #>> '{listing_extraction,industry}'
from public.job_snapshots as snapshot
where snapshot.id = job.current_snapshot_id
  and job.industry is null
  and nullif(snapshot.raw_metadata #>> '{listing_extraction,industry}', '') is not null;

create index idx_jobs_user_pool_status
  on public.jobs(user_id, archived_at, user_status, discovered_at desc);

comment on column public.jobs.archived_at is
  'When set, the vacancy is hidden from the active job pool and can be restored by its owner.';
comment on column public.jobs.user_status is
  'User-owned workflow state; independent of AI triage and eligibility.';
comment on column public.jobs.industry is
  'Normalized industry label, initially backfilled from the current listing snapshot when available.';
