-- Keep the opt-in, account-wide ChatGPT testing-mode setting beside the
-- manual-search diagnostics control. Existing owner-only RLS and grants on
-- job_search_controls continue to protect this setting.
alter table public.job_search_controls
  add column if not exists testing_mode_enabled boolean not null default false;
