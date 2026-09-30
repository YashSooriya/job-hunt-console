-- Remember the last database-backed Applications publication. A future sync
-- compares the Sheet data and manifest with this hash before replacing them,
-- so external edits are detected rather than silently blessed or overwritten.

alter table public.candidate_automation_settings
  add column if not exists last_sheet_sync_hash text;

comment on column public.candidate_automation_settings.last_sheet_sync_hash is
  'SHA-256 of the last verified Supabase-backed Applications tab publication in the managed JobHuntAI workbook.';
