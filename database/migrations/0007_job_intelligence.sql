-- Milestone 3: job intelligence persistence and deduplication

alter table public.jobs
  add column if not exists discovery_source text not null default 'manual',
  add column if not exists dedupe_key text;

create unique index if not exists jobs_user_dedupe_key_unique
  on public.jobs(user_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists idx_jobs_user_triage_discovered
  on public.jobs(user_id, triage, discovered_at desc);

alter table public.job_snapshots
  add column if not exists content_hash text;

create unique index if not exists job_snapshots_job_content_hash_unique
  on public.job_snapshots(job_id, content_hash)
  where content_hash is not null;

alter table public.job_analyses
  add column if not exists analysis_source text not null default 'deterministic_v1',
  add column if not exists triage public.job_triage,
  add column if not exists triage_reason text;

create index if not exists idx_job_analyses_job_created_desc
  on public.job_analyses(job_id, created_at desc);

alter table public.job_requirements
  add column if not exists analysis_id uuid references public.job_analyses(id) on delete cascade;

create index if not exists idx_job_requirements_analysis_id
  on public.job_requirements(analysis_id);

-- Prevent duplicate analysis requirements from becoming ambiguous in the UI.
create index if not exists idx_job_requirements_job_analysis
  on public.job_requirements(job_id, analysis_id);
