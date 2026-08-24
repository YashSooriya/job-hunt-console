-- Milestone 9: versioned assessment/interview preparation workspaces.

-- Immutable submission context becomes the source of truth for later interview/assessment preparation once Milestone 10 records a submission.
create table if not exists public.application_submission_contexts (
  application_id uuid primary key references public.applications(id) on delete cascade,
  submitted_at timestamptz not null,
  cv_version_id uuid references public.document_versions(id) on delete restrict,
  cover_letter_version_id uuid references public.document_versions(id) on delete restrict,
  screening_answers jsonb not null default '[]'::jsonb,
  salary_context jsonb,
  job_snapshot_id uuid references public.job_snapshots(id) on delete restrict,
  job_analysis_id uuid references public.job_analyses(id) on delete restrict,
  strategy_id uuid references public.application_strategies(id) on delete restrict,
  context_snapshot jsonb not null,
  locked_at timestamptz not null default now()
);
alter table public.application_submission_contexts enable row level security;
drop policy if exists application_submission_contexts_owner on public.application_submission_contexts;
create policy application_submission_contexts_owner on public.application_submission_contexts
  for select to authenticated using ((select private.owns_application(application_id)));
grant select on public.application_submission_contexts to authenticated;

create or replace function public.prevent_submission_context_changes()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Submitted application context is immutable';
end;
$$;
drop trigger if exists application_submission_context_immutable on public.application_submission_contexts;
create trigger application_submission_context_immutable before update or delete on public.application_submission_contexts
  for each row execute function public.prevent_submission_context_changes();

create table if not exists public.workflow_preparation_versions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  workflow_kind text not null check (workflow_kind in ('assessment','interview')),
  assessment_id uuid references public.assessments(id) on delete cascade,
  interview_id uuid references public.interviews(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  context_quality text not null check (context_quality in ('exact_submitted','approved_pre_submission','best_available')),
  context_snapshot jsonb not null,
  preparation_package jsonb not null,
  generator text not null default 'deterministic_v1',
  created_at timestamptz not null default now(),
  check (
    (workflow_kind='assessment' and assessment_id is not null and interview_id is null)
    or
    (workflow_kind='interview' and interview_id is not null and assessment_id is null)
  ),
  check ((preparation_package->>'practice_only')::boolean is true)
);

create unique index if not exists workflow_prep_assessment_version_unique
  on public.workflow_preparation_versions(assessment_id, version_number)
  where assessment_id is not null;
create unique index if not exists workflow_prep_interview_version_unique
  on public.workflow_preparation_versions(interview_id, version_number)
  where interview_id is not null;
create index if not exists workflow_prep_application_created_idx
  on public.workflow_preparation_versions(application_id, created_at desc);

alter table public.workflow_preparation_versions enable row level security;
drop policy if exists workflow_preparation_versions_owner on public.workflow_preparation_versions;
create policy workflow_preparation_versions_owner on public.workflow_preparation_versions
  for all to authenticated
  using ((select private.owns_application(application_id)))
  with check ((select private.owns_application(application_id)));

grant select, insert on public.workflow_preparation_versions to authenticated;

alter table public.assessments
  add column if not exists current_preparation_version_id uuid references public.workflow_preparation_versions(id) on delete set null,
  add column if not exists preparation_status text not null default 'not_prepared' check (preparation_status in ('not_prepared','prepared','completed')),
  add column if not exists completed_at timestamptz;

alter table public.interviews
  add column if not exists current_preparation_version_id uuid references public.workflow_preparation_versions(id) on delete set null,
  add column if not exists preparation_status text not null default 'not_prepared' check (preparation_status in ('not_prepared','prepared','completed'));

create or replace function public.save_progression_preparation(
  p_workflow_kind text,
  p_workflow_id uuid,
  p_context_quality text,
  p_context_snapshot jsonb,
  p_preparation_package jsonb,
  p_generator text default 'deterministic_v1'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_application_id uuid;
  v_version_number integer;
  v_version public.workflow_preparation_versions;
  v_package_text text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_workflow_kind not in ('assessment','interview') then raise exception 'Invalid workflow kind'; end if;
  if p_context_quality not in ('exact_submitted','approved_pre_submission','best_available') then raise exception 'Invalid context quality'; end if;
  if coalesce((p_preparation_package->>'practice_only')::boolean,false) is not true then raise exception 'Preparation package must be practice-only'; end if;

  v_package_text := lower(p_preparation_package::text);
  if v_package_text ~ 'live_assessment_answer|actual_assessment_answer|answer_real_assessment|assessment_submission' then
    raise exception 'Live assessment answer/submission content is prohibited in preparation workspaces';
  end if;

  if p_workflow_kind='assessment' then
    select a.application_id into v_application_id
      from public.assessments a join public.applications app on app.id=a.application_id
      where a.id=p_workflow_id and app.user_id=v_user;
  else
    select i.application_id into v_application_id
      from public.interviews i join public.applications app on app.id=i.application_id
      where i.id=p_workflow_id and app.user_id=v_user;
  end if;
  if v_application_id is null then raise exception 'Workflow not found'; end if;

  if p_workflow_kind='assessment' then
    select coalesce(max(version_number),0)+1 into v_version_number
      from public.workflow_preparation_versions where assessment_id=p_workflow_id;
    insert into public.workflow_preparation_versions(
      application_id,workflow_kind,assessment_id,version_number,context_quality,context_snapshot,preparation_package,generator
    ) values (
      v_application_id,'assessment',p_workflow_id,v_version_number,p_context_quality,p_context_snapshot,p_preparation_package,p_generator
    ) returning * into v_version;
    update public.assessments set current_preparation_version_id=v_version.id,preparation_status='prepared',updated_at=now()
      where id=p_workflow_id;
  else
    select coalesce(max(version_number),0)+1 into v_version_number
      from public.workflow_preparation_versions where interview_id=p_workflow_id;
    insert into public.workflow_preparation_versions(
      application_id,workflow_kind,interview_id,version_number,context_quality,context_snapshot,preparation_package,generator
    ) values (
      v_application_id,'interview',p_workflow_id,v_version_number,p_context_quality,p_context_snapshot,p_preparation_package,p_generator
    ) returning * into v_version;
    update public.interviews set current_preparation_version_id=v_version.id,preparation_status='prepared',updated_at=now()
      where id=p_workflow_id;
  end if;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'progression.preparation_created',p_workflow_kind,p_workflow_id,
    jsonb_build_object('version_id',v_version.id,'version_number',v_version.version_number,'context_quality',p_context_quality,'generator',p_generator));

  return jsonb_build_object('id',v_version.id,'version_number',v_version.version_number,'application_id',v_application_id);
end;
$$;

revoke execute on function public.save_progression_preparation(text,uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.save_progression_preparation(text,uuid,text,jsonb,jsonb,text) to authenticated;

create or replace function public.set_assessment_status(p_assessment_id uuid, p_status text)
returns public.assessments
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_assessment public.assessments;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_status not in ('pending','in_progress','completed','expired','cancelled') then raise exception 'Invalid assessment status'; end if;
  select a.* into v_assessment from public.assessments a join public.applications app on app.id=a.application_id
    where a.id=p_assessment_id and app.user_id=v_user for update;
  if not found then raise exception 'Assessment not found'; end if;
  update public.assessments set status=p_status,
    preparation_status=case when p_status='completed' then 'completed' else preparation_status end,
    completed_at=case when p_status='completed' then coalesce(completed_at,now()) else completed_at end,
    updated_at=now()
    where id=p_assessment_id returning * into v_assessment;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'assessment.status_changed','assessment',p_assessment_id,jsonb_build_object('status',p_status));
  return v_assessment;
end;
$$;
revoke execute on function public.set_assessment_status(uuid,text) from public, anon;
grant execute on function public.set_assessment_status(uuid,text) to authenticated;
