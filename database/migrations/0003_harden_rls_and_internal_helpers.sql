-- Milestone 1 hardening: private ownership helpers, transition-table RLS and privileged RPC tightening.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

drop policy if exists candidate_facts_owner on public.candidate_facts;
drop policy if exists evidence_sources_owner on public.evidence_sources;
drop policy if exists evidence_items_owner on public.evidence_items;
drop policy if exists candidate_preferences_owner on public.candidate_preferences;
drop policy if exists reusable_answers_owner on public.reusable_answers;
drop policy if exists job_snapshots_owner on public.job_snapshots;
drop policy if exists job_requirements_owner on public.job_requirements;
drop policy if exists job_analyses_owner on public.job_analyses;
drop policy if exists application_strategies_owner on public.application_strategies;
drop policy if exists application_answers_owner on public.application_answers;
drop policy if exists assessments_owner on public.assessments;
drop policy if exists interviews_owner on public.interviews;
drop policy if exists documents_owner on public.documents;
drop policy if exists document_versions_owner on public.document_versions;
drop policy if exists document_evidence_links_owner on public.document_evidence_links;
drop policy if exists application_email_links_owner on public.application_email_links;

drop function if exists public.owns_profile(uuid);
drop function if exists public.owns_job(uuid);
drop function if exists public.owns_application(uuid);
drop function if exists public.owns_document(uuid);

create function private.owns_profile(p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$ select exists(select 1 from public.candidate_profiles where id=p_profile_id and user_id=auth.uid()); $$;

create function private.owns_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$ select exists(select 1 from public.jobs where id=p_job_id and user_id=auth.uid()); $$;

create function private.owns_application(p_application_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$ select exists(select 1 from public.applications where id=p_application_id and user_id=auth.uid()); $$;

create function private.owns_document(p_document_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$
  select exists(
    select 1
    from public.documents d
    left join public.applications a on a.id=d.application_id
    left join public.candidate_profiles p on p.id=d.profile_id
    where d.id=p_document_id and (a.user_id=auth.uid() or p.user_id=auth.uid())
  );
$$;

grant execute on function private.owns_profile(uuid) to authenticated;
grant execute on function private.owns_job(uuid) to authenticated;
grant execute on function private.owns_application(uuid) to authenticated;
grant execute on function private.owns_document(uuid) to authenticated;

create policy candidate_facts_owner on public.candidate_facts for all using (private.owns_profile(profile_id)) with check (private.owns_profile(profile_id));
create policy evidence_sources_owner on public.evidence_sources for all using (private.owns_profile(profile_id)) with check (private.owns_profile(profile_id));
create policy evidence_items_owner on public.evidence_items for all using (private.owns_profile(profile_id)) with check (private.owns_profile(profile_id));
create policy candidate_preferences_owner on public.candidate_preferences for all using (private.owns_profile(profile_id)) with check (private.owns_profile(profile_id));
create policy reusable_answers_owner on public.reusable_answers for all using (private.owns_profile(profile_id)) with check (private.owns_profile(profile_id));
create policy job_snapshots_owner on public.job_snapshots for all using (private.owns_job(job_id)) with check (private.owns_job(job_id));
create policy job_requirements_owner on public.job_requirements for all using (private.owns_job(job_id)) with check (private.owns_job(job_id));
create policy job_analyses_owner on public.job_analyses for all using (private.owns_job(job_id)) with check (private.owns_job(job_id));
create policy application_strategies_owner on public.application_strategies for all using (private.owns_application(application_id)) with check (private.owns_application(application_id));
create policy application_answers_owner on public.application_answers for all using (private.owns_application(application_id)) with check (private.owns_application(application_id));
create policy assessments_owner on public.assessments for all using (private.owns_application(application_id)) with check (private.owns_application(application_id));
create policy interviews_owner on public.interviews for all using (private.owns_application(application_id)) with check (private.owns_application(application_id));
create policy documents_owner on public.documents for all using (
  (application_id is not null and private.owns_application(application_id))
  or (profile_id is not null and private.owns_profile(profile_id))
) with check (
  (application_id is not null and private.owns_application(application_id))
  or (profile_id is not null and private.owns_profile(profile_id))
);
create policy document_versions_owner on public.document_versions for all using (private.owns_document(document_id)) with check (private.owns_document(document_id));
create policy document_evidence_links_owner on public.document_evidence_links for all using (
  exists(select 1 from public.document_versions dv where dv.id=document_version_id and private.owns_document(dv.document_id))
) with check (
  exists(select 1 from public.document_versions dv where dv.id=document_version_id and private.owns_document(dv.document_id))
  and exists(select 1 from public.evidence_items ei where ei.id=evidence_item_id and private.owns_profile(ei.profile_id))
);
create policy application_email_links_owner on public.application_email_links for all using (
  private.owns_application(application_id)
  and exists(select 1 from public.emails e where e.id=email_id and e.user_id=auth.uid())
) with check (
  private.owns_application(application_id)
  and exists(select 1 from public.emails e where e.id=email_id and e.user_id=auth.uid())
);

alter table public.application_state_transitions enable row level security;
create policy transition_lookup_authenticated on public.application_state_transitions
  for select to authenticated using (true);
revoke all on public.application_state_transitions from anon;

revoke all on function public.transition_application_state(uuid, public.application_state, jsonb) from public, anon;
grant execute on function public.transition_application_state(uuid, public.application_state, jsonb) to authenticated;

create or replace function public.prevent_locked_document_version_changes()
returns trigger language plpgsql set search_path=public as $$
begin
  if old.submission_locked_at is not null and (
    new.structured_content is distinct from old.structured_content or
    new.latex_source is distinct from old.latex_source or
    new.rendered_object_key is distinct from old.rendered_object_key or
    new.document_id is distinct from old.document_id
  ) then raise exception 'Submitted document version is immutable'; end if;
  return new;
end;
$$;
