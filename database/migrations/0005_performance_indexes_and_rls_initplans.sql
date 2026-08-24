-- Milestone 1 performance: cover foreign keys and avoid per-row auth.uid() re-evaluation.

create index if not exists idx_jobs_user_id on public.jobs(user_id);
create index if not exists idx_jobs_company_id on public.jobs(company_id);
create index if not exists idx_jobs_current_snapshot_id on public.jobs(current_snapshot_id);
create index if not exists idx_job_snapshots_job_id on public.job_snapshots(job_id);
create index if not exists idx_job_requirements_job_id on public.job_requirements(job_id);
create index if not exists idx_job_analyses_job_id on public.job_analyses(job_id);
create index if not exists idx_applications_job_id on public.applications(job_id);
create index if not exists idx_application_strategies_application_id on public.application_strategies(application_id);
create index if not exists idx_application_strategies_job_analysis_id on public.application_strategies(job_analysis_id);
create index if not exists idx_application_answers_application_id on public.application_answers(application_id);
create index if not exists idx_application_answers_approved_by on public.application_answers(approved_by);
create index if not exists idx_application_answers_source_fact_id on public.application_answers(source_fact_id);
create index if not exists idx_application_answers_source_reusable_answer_id on public.application_answers(source_reusable_answer_id);
create index if not exists idx_documents_application_id on public.documents(application_id);
create index if not exists idx_documents_profile_id on public.documents(profile_id);
create index if not exists idx_document_versions_approved_by on public.document_versions(approved_by);
create index if not exists idx_document_evidence_links_evidence_item_id on public.document_evidence_links(evidence_item_id);
create index if not exists idx_evidence_items_source_id on public.evidence_items(source_id);
create index if not exists idx_application_email_links_email_id on public.application_email_links(email_id);
create index if not exists idx_assessments_application_id on public.assessments(application_id);
create index if not exists idx_interviews_application_id on public.interviews(application_id);
create index if not exists idx_audit_events_user_id on public.audit_events(user_id);

alter policy candidate_profiles_owner on public.candidate_profiles using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
alter policy companies_owner on public.companies using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
alter policy jobs_owner on public.jobs using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
alter policy applications_owner on public.applications using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
alter policy emails_owner on public.emails using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
alter policy tasks_owner on public.automation_tasks using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
alter policy audit_owner_read on public.audit_events using (user_id=(select auth.uid()));
alter policy audit_owner_insert on public.audit_events with check (user_id=(select auth.uid()) and actor_type='user');

create or replace function private.owns_profile(p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$ select exists(select 1 from public.candidate_profiles where id=p_profile_id and user_id=(select auth.uid())); $$;
create or replace function private.owns_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$ select exists(select 1 from public.jobs where id=p_job_id and user_id=(select auth.uid())); $$;
create or replace function private.owns_application(p_application_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$ select exists(select 1 from public.applications where id=p_application_id and user_id=(select auth.uid())); $$;
create or replace function private.owns_document(p_document_id uuid)
returns boolean language sql stable security definer set search_path=public,private
as $$
  select exists(
    select 1 from public.documents d
    left join public.applications a on a.id=d.application_id
    left join public.candidate_profiles p on p.id=d.profile_id
    where d.id=p_document_id and (a.user_id=(select auth.uid()) or p.user_id=(select auth.uid()))
  );
$$;

alter policy application_email_links_owner on public.application_email_links using (
  private.owns_application(application_id)
  and exists(select 1 from public.emails e where e.id=email_id and e.user_id=(select auth.uid()))
) with check (
  private.owns_application(application_id)
  and exists(select 1 from public.emails e where e.id=email_id and e.user_id=(select auth.uid()))
);
