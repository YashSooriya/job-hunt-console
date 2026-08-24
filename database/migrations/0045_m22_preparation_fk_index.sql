-- M22 follow-up: cover the preparation request analysis foreign key.
create index if not exists application_preparation_requests_analysis_idx
  on public.application_preparation_requests(analysis_id);
