-- Milestone 10 performance indexes for foreign-key lookups.
create index if not exists form_agent_sessions_application_idx
  on public.form_agent_sessions(application_id);
create index if not exists form_agent_sessions_final_observation_idx
  on public.form_agent_sessions(final_observation_id)
  where final_observation_id is not null;
