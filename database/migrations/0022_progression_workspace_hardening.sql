-- Milestone 9 hardening: make preparation versions append-only and enforce the live-assessment boundary at table level.

alter table public.workflow_preparation_versions
  add constraint workflow_preparation_no_live_assessment_fields
  check (lower(preparation_package::text) !~ 'live_assessment_answer|actual_assessment_answer|answer_real_assessment|assessment_submission');

revoke update, delete on public.workflow_preparation_versions from authenticated, anon, public;
revoke insert, update, delete on public.application_submission_contexts from authenticated, anon, public;

drop policy if exists workflow_preparation_versions_owner on public.workflow_preparation_versions;
create policy workflow_preparation_versions_owner_select on public.workflow_preparation_versions
  for select to authenticated
  using ((select private.owns_application(application_id)));
create policy workflow_preparation_versions_owner_insert on public.workflow_preparation_versions
  for insert to authenticated
  with check ((select private.owns_application(application_id)));

-- Existing versions are historical records. Corrections create a new version.
create or replace function public.prevent_workflow_preparation_changes()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Progression preparation versions are immutable; create a new version';
end;
$$;
drop trigger if exists workflow_preparation_versions_immutable on public.workflow_preparation_versions;
create trigger workflow_preparation_versions_immutable
  before update or delete on public.workflow_preparation_versions
  for each row execute function public.prevent_workflow_preparation_changes();
