-- Store optional project dates so onboarding can present project records in
-- reverse chronological order instead of relying on import order.
alter table public.candidate_projects
  add column if not exists start_date date,
  add column if not exists end_date date;

create index if not exists candidate_projects_chronology_idx
  on public.candidate_projects(profile_id, start_date desc, end_date desc, created_at desc);
