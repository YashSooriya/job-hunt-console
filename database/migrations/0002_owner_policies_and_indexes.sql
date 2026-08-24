-- Milestone 1: owner helper functions, child-table RLS and idempotent import indexes.

create unique index if not exists applications_user_tracker_row_unique
  on public.applications(user_id, source_tracker_row)
  where source_tracker_row is not null;

create or replace function public.owns_profile(p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.candidate_profiles where id=p_profile_id and user_id=auth.uid()); $$;

create or replace function public.owns_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.jobs where id=p_job_id and user_id=auth.uid()); $$;

create or replace function public.owns_application(p_application_id uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.applications where id=p_application_id and user_id=auth.uid()); $$;

create or replace function public.owns_document(p_document_id uuid)
returns boolean language sql stable security definer set search_path=public
as $$
  select exists(
    select 1
    from public.documents d
    left join public.applications a on a.id=d.application_id
    left join public.candidate_profiles p on p.id=d.profile_id
    where d.id=p_document_id and (a.user_id=auth.uid() or p.user_id=auth.uid())
  );
$$;

grant execute on function public.owns_profile(uuid) to authenticated;
grant execute on function public.owns_job(uuid) to authenticated;
grant execute on function public.owns_application(uuid) to authenticated;
grant execute on function public.owns_document(uuid) to authenticated;

create policy candidate_facts_owner on public.candidate_facts
  for all using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));
create policy evidence_sources_owner on public.evidence_sources
  for all using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));
create policy evidence_items_owner on public.evidence_items
  for all using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));
create policy candidate_preferences_owner on public.candidate_preferences
  for all using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));
create policy reusable_answers_owner on public.reusable_answers
  for all using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));

create policy job_snapshots_owner on public.job_snapshots
  for all using (public.owns_job(job_id)) with check (public.owns_job(job_id));
create policy job_requirements_owner on public.job_requirements
  for all using (public.owns_job(job_id)) with check (public.owns_job(job_id));
create policy job_analyses_owner on public.job_analyses
  for all using (public.owns_job(job_id)) with check (public.owns_job(job_id));

create policy application_strategies_owner on public.application_strategies
  for all using (public.owns_application(application_id)) with check (public.owns_application(application_id));
create policy application_answers_owner on public.application_answers
  for all using (public.owns_application(application_id)) with check (public.owns_application(application_id));
create policy assessments_owner on public.assessments
  for all using (public.owns_application(application_id)) with check (public.owns_application(application_id));
create policy interviews_owner on public.interviews
  for all using (public.owns_application(application_id)) with check (public.owns_application(application_id));

create policy documents_owner on public.documents
  for all using (
    (application_id is not null and public.owns_application(application_id))
    or (profile_id is not null and public.owns_profile(profile_id))
  ) with check (
    (application_id is not null and public.owns_application(application_id))
    or (profile_id is not null and public.owns_profile(profile_id))
  );

create policy document_versions_owner on public.document_versions
  for all using (public.owns_document(document_id)) with check (public.owns_document(document_id));

create policy document_evidence_links_owner on public.document_evidence_links
  for all using (
    exists(
      select 1 from public.document_versions dv
      where dv.id=document_version_id and public.owns_document(dv.document_id)
    )
  ) with check (
    exists(
      select 1 from public.document_versions dv
      where dv.id=document_version_id and public.owns_document(dv.document_id)
    )
    and exists(
      select 1 from public.evidence_items ei
      where ei.id=evidence_item_id and public.owns_profile(ei.profile_id)
    )
  );

create policy application_email_links_owner on public.application_email_links
  for all using (
    public.owns_application(application_id)
    and exists(select 1 from public.emails e where e.id=email_id and e.user_id=auth.uid())
  ) with check (
    public.owns_application(application_id)
    and exists(select 1 from public.emails e where e.id=email_id and e.user_id=auth.uid())
  );
