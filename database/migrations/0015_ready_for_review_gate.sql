-- Milestone 7: Ready for Review centre and mandatory content approval gate.

create table if not exists public.application_review_packages (
  application_id uuid primary key references public.applications(id) on delete cascade,
  cv_version_id uuid references public.document_versions(id),
  cover_letter_version_id uuid references public.document_versions(id),
  cover_letter_decision text not null default 'not_required' check (cover_letter_decision in ('use','remove','not_required')),
  assembled_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.application_review_packages enable row level security;
drop policy if exists application_review_packages_owner on public.application_review_packages;
create policy application_review_packages_owner on public.application_review_packages
  for all to authenticated
  using ((select private.owns_application(application_id)))
  with check ((select private.owns_application(application_id)));

create index if not exists idx_application_review_packages_cv_version on public.application_review_packages(cv_version_id);
create index if not exists idx_application_review_packages_cover_version on public.application_review_packages(cover_letter_version_id);
create index if not exists idx_application_review_packages_approved_by on public.application_review_packages(approved_by);

-- When generated salary content materially changes, a previous approval is no longer valid.
create or replace function public.reset_salary_approval_on_content_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (
    new.source is distinct from old.source or
    new.advertised_text is distinct from old.advertised_text or
    new.estimated_low is distinct from old.estimated_low or
    new.estimated_high is distinct from old.estimated_high or
    new.recommended_value is distinct from old.recommended_value or
    new.currency is distinct from old.currency or
    new.basis is distinct from old.basis
  ) and new.approved_at is not distinct from old.approved_at then
    new.approved_at := null;
    new.approved_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists application_salary_reset_approval on public.application_salary_contexts;
create trigger application_salary_reset_approval
before update on public.application_salary_contexts
for each row execute function public.reset_salary_approval_on_content_change();
revoke execute on function public.reset_salary_approval_on_content_change() from public, anon, authenticated;

-- New document versions automatically become the selected review candidate until Gate 1 is approved.
create or replace function public.select_new_document_version_for_review()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_application_id uuid;
  v_kind public.document_kind;
begin
  select application_id, kind into v_application_id, v_kind
  from public.documents where id = new.document_id;
  if v_application_id is null then return new; end if;

  insert into public.application_review_packages(application_id, created_at, updated_at)
  values(v_application_id, now(), now())
  on conflict (application_id) do nothing;

  if v_kind = 'cv' then
    update public.application_review_packages
      set cv_version_id = new.id, approved_at = null, approved_by = null, updated_at = now()
      where application_id = v_application_id and approved_at is null;
  elsif v_kind = 'cover_letter' then
    update public.application_review_packages
      set cover_letter_version_id = new.id, cover_letter_decision = 'use', approved_at = null, approved_by = null, updated_at = now()
      where application_id = v_application_id and approved_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists document_versions_select_for_review on public.document_versions;
create trigger document_versions_select_for_review
after insert on public.document_versions
for each row execute function public.select_new_document_version_for_review();
revoke execute on function public.select_new_document_version_for_review() from public, anon, authenticated;

create or replace function public.assemble_application_review_package(p_application_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_cv public.document_versions;
  v_cover public.document_versions;
  v_cover_task public.automation_tasks;
  v_screen_task public.automation_tasks;
  v_salary_task public.automation_tasks;
  v_cover_decision text;
  v_package public.application_review_packages;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state not in ('preparing','revision_requested','ready_for_review') then
    raise exception 'Application cannot be assembled for review from state %', v_app.state;
  end if;

  select dv.* into v_cv
  from public.documents d join public.document_versions dv on dv.document_id=d.id
  where d.application_id=p_application_id and d.kind='cv'
    and dv.rendered_object_key is not null
    and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0
  order by dv.version_number desc limit 1;
  if v_cv.id is null then raise exception 'A rendered evidence-backed CV is required before Ready for Review'; end if;

  select * into v_cover_task from public.automation_tasks
    where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_cover_letter' limit 1;
  if v_cover_task.id is null or v_cover_task.state <> 'completed' then raise exception 'Cover-letter preparation is not complete'; end if;
  if coalesce((v_cover_task.output_json->>'skipped')::boolean,false) then
    v_cover_decision := 'not_required';
  else
    select dv.* into v_cover
    from public.documents d join public.document_versions dv on dv.document_id=d.id
    where d.application_id=p_application_id and d.kind='cover_letter' and dv.rendered_object_key is not null
    order by dv.version_number desc limit 1;
    if v_cover.id is null then raise exception 'A rendered cover letter is required before Ready for Review'; end if;
    v_cover_decision := 'use';
  end if;

  if not exists(select 1 from public.application_salary_contexts where application_id=p_application_id) then
    raise exception 'Salary context is required before Ready for Review';
  end if;
  select * into v_salary_task from public.automation_tasks
    where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='research_salary' limit 1;
  if v_salary_task.id is null or v_salary_task.state <> 'completed' then raise exception 'Salary preparation is not complete'; end if;
  select * into v_screen_task from public.automation_tasks
    where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_screening_answers' limit 1;
  if v_screen_task.id is null or v_screen_task.state not in ('completed','needs_user') then raise exception 'Screening-answer package is not prepared'; end if;

  insert into public.application_review_packages(
    application_id,cv_version_id,cover_letter_version_id,cover_letter_decision,assembled_at,approved_at,approved_by,updated_at
  ) values(
    p_application_id,v_cv.id,v_cover.id,v_cover_decision,now(),null,null,now()
  ) on conflict(application_id) do update set
    cv_version_id=excluded.cv_version_id,
    cover_letter_version_id=excluded.cover_letter_version_id,
    cover_letter_decision=excluded.cover_letter_decision,
    assembled_at=now(), approved_at=null, approved_by=null, updated_at=now()
  returning * into v_package;

  update public.automation_tasks set state='completed',updated_at=now(),last_error=null,
    output_json=jsonb_build_object('cv_version_id',v_cv.id,'cover_letter_version_id',v_cover.id,'cover_letter_decision',v_cover_decision)
  where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='assemble_review_package';

  if v_app.state <> 'ready_for_review' then
    update public.applications set state='ready_for_review',next_action='Review and approve the prepared application package.',updated_at=now()
      where id=p_application_id;
    insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'system','review-centre','application.ready_for_review','application',p_application_id,
      jsonb_build_object('cv_version_id',v_cv.id,'cover_letter_version_id',v_cover.id,'cover_letter_decision',v_cover_decision));
  end if;

  return jsonb_build_object('application_id',p_application_id,'state','ready_for_review','cv_version_id',v_cv.id,
    'cover_letter_version_id',v_cover.id,'cover_letter_decision',v_cover_decision,'assembled_at',v_package.assembled_at);
end;
$$;
revoke execute on function public.assemble_application_review_package(uuid) from public, anon;
grant execute on function public.assemble_application_review_package(uuid) to authenticated;

create or replace function public.review_application_document(
  p_application_id uuid,
  p_version_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_kind public.document_kind;
  v_app_state public.application_state;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_decision not in ('approve','reject') then raise exception 'Unsupported document review decision'; end if;
  select a.state,d.kind into v_app_state,v_kind
  from public.applications a
  join public.documents d on d.application_id=a.id
  join public.document_versions dv on dv.document_id=d.id
  where a.id=p_application_id and a.user_id=v_user and dv.id=p_version_id;
  if v_kind is null then raise exception 'Document version does not belong to this application'; end if;
  if v_app_state not in ('ready_for_review','revision_requested') then raise exception 'Documents can only be reviewed during content review'; end if;

  update public.document_versions set
    approval_status=case when p_decision='approve' then 'approved' else 'rejected' end,
    approved_at=case when p_decision='approve' then now() else null end,
    approved_by=case when p_decision='approve' then v_user else null end
  where id=p_version_id;

  if v_kind='cv' then
    update public.application_review_packages set cv_version_id=p_version_id,approved_at=null,approved_by=null,updated_at=now()
      where application_id=p_application_id;
  elsif v_kind='cover_letter' then
    update public.application_review_packages set cover_letter_version_id=p_version_id,cover_letter_decision='use',approved_at=null,approved_by=null,updated_at=now()
      where application_id=p_application_id;
  end if;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'document.reviewed','document_version',p_version_id,
    jsonb_build_object('application_id',p_application_id,'decision',p_decision,'kind',v_kind));
  return jsonb_build_object('version_id',p_version_id,'decision',p_decision,'kind',v_kind);
end;
$$;
revoke execute on function public.review_application_document(uuid,uuid,text) from public, anon;
grant execute on function public.review_application_document(uuid,uuid,text) to authenticated;

create or replace function public.review_application_salary(
  p_application_id uuid,
  p_recommended_value integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_user uuid := (select auth.uid()); v_salary public.application_salary_contexts;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_recommended_value is null or p_recommended_value <= 0 then raise exception 'A positive salary expectation is required'; end if;
  if not exists(select 1 from public.applications where id=p_application_id and user_id=v_user and state='ready_for_review') then
    raise exception 'Salary can only be approved during Ready for Review';
  end if;
  update public.application_salary_contexts
    set recommended_value=p_recommended_value,approved_at=now(),approved_by=v_user,updated_at=now()
    where application_id=p_application_id returning * into v_salary;
  if v_salary.application_id is null then raise exception 'Salary context not found'; end if;
  update public.application_review_packages set approved_at=null,approved_by=null,updated_at=now() where application_id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'application.salary_approved','application',p_application_id,
    jsonb_build_object('recommended_value',p_recommended_value,'currency',v_salary.currency));
  return jsonb_build_object('application_id',p_application_id,'recommended_value',p_recommended_value,'approved_at',v_salary.approved_at);
end;
$$;
revoke execute on function public.review_application_salary(uuid,integer) from public, anon;
grant execute on function public.review_application_salary(uuid,integer) to authenticated;

create or replace function public.review_application_answer(
  p_application_id uuid,
  p_answer_id uuid,
  p_answer_text text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_user uuid := (select auth.uid()); v_answer public.application_answers; v_text text := nullif(btrim(coalesce(p_answer_text,'')),'');
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select aa.* into v_answer from public.application_answers aa join public.applications a on a.id=aa.application_id
    where aa.id=p_answer_id and aa.application_id=p_application_id and a.user_id=v_user and a.state='ready_for_review';
  if not found then raise exception 'Answer is not reviewable'; end if;
  if v_answer.trust='verified' then
    if v_text is not null and v_text is distinct from v_answer.answer_text then raise exception 'Verified answers cannot be edited without changing the underlying verified fact'; end if;
    v_text := v_answer.answer_text;
  end if;
  if v_answer.required and v_text is null then raise exception 'A required answer cannot be approved blank'; end if;
  update public.application_answers set answer_text=v_text,approved_at=now(),approved_by=v_user,updated_at=now() where id=p_answer_id returning * into v_answer;
  update public.application_review_packages set approved_at=null,approved_by=null,updated_at=now() where application_id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'application.answer_approved','application_answer',p_answer_id,
    jsonb_build_object('application_id',p_application_id,'trust',v_answer.trust,'question_key',v_answer.question_key));
  return jsonb_build_object('answer_id',p_answer_id,'trust',v_answer.trust,'approved_at',v_answer.approved_at);
end;
$$;
revoke execute on function public.review_application_answer(uuid,uuid,text) from public, anon;
grant execute on function public.review_application_answer(uuid,uuid,text) to authenticated;

create or replace function public.set_application_cover_letter_decision(
  p_application_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_user uuid := (select auth.uid()); v_version uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_decision not in ('use','remove') then raise exception 'Cover-letter decision must be use or remove'; end if;
  if not exists(select 1 from public.applications where id=p_application_id and user_id=v_user and state='ready_for_review') then
    raise exception 'Cover-letter decision can only be changed during Ready for Review';
  end if;
  if p_decision='use' then
    select dv.id into v_version from public.documents d join public.document_versions dv on dv.document_id=d.id
      where d.application_id=p_application_id and d.kind='cover_letter' order by dv.version_number desc limit 1;
    if v_version is null then raise exception 'No cover-letter version exists'; end if;
  end if;
  update public.application_review_packages set cover_letter_decision=p_decision,
    cover_letter_version_id=case when p_decision='use' then v_version else null end,
    approved_at=null,approved_by=null,updated_at=now()
    where application_id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'application.cover_letter_decision','application',p_application_id,jsonb_build_object('decision',p_decision));
  return jsonb_build_object('application_id',p_application_id,'decision',p_decision,'cover_letter_version_id',v_version);
end;
$$;
revoke execute on function public.set_application_cover_letter_decision(uuid,text) from public, anon;
grant execute on function public.set_application_cover_letter_decision(uuid,text) to authenticated;

create or replace function public.approve_application_content(p_application_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_package public.application_review_packages;
  v_cv_status text;
  v_cover_status text;
  v_unresolved integer;
  v_unapproved integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state <> 'ready_for_review' then raise exception 'Application must be Ready for Review before content approval'; end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id for update;
  if not found or v_package.assembled_at is null then raise exception 'Review package has not been assembled'; end if;

  select approval_status into v_cv_status from public.document_versions where id=v_package.cv_version_id;
  if v_cv_status <> 'approved' then raise exception 'Selected CV version is not approved'; end if;
  if v_package.cover_letter_decision='use' then
    select approval_status into v_cover_status from public.document_versions where id=v_package.cover_letter_version_id;
    if v_cover_status <> 'approved' then raise exception 'Selected cover-letter version is not approved'; end if;
  end if;
  if not exists(select 1 from public.application_salary_contexts where application_id=p_application_id and approved_at is not null) then
    raise exception 'Salary expectation has not been approved';
  end if;

  select count(*) into v_unresolved from public.application_answers
    where application_id=p_application_id and required and nullif(btrim(coalesce(answer_text,'')),'') is null;
  if v_unresolved > 0 then raise exception '% required screening answer(s) remain blank',v_unresolved; end if;
  select count(*) into v_unapproved from public.application_answers
    where application_id=p_application_id and (
      (trust='proposed' and approved_at is null) or
      (trust='user_required' and (approved_at is null or nullif(btrim(coalesce(answer_text,'')),'') is null))
    );
  if v_unapproved > 0 then raise exception '% generated/user-only screening answer(s) are not approved',v_unapproved; end if;
  if not exists(select 1 from public.automation_tasks where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='assemble_review_package' and state='completed') then
    raise exception 'Ready for Review package task is incomplete';
  end if;

  update public.application_review_packages set approved_at=now(),approved_by=v_user,updated_at=now() where application_id=p_application_id returning * into v_package;
  update public.applications set state='content_approved',next_action='Complete the employer application form using the approved package.',updated_at=now() where id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'application.content_approved','application',p_application_id,
    jsonb_build_object('cv_version_id',v_package.cv_version_id,'cover_letter_version_id',v_package.cover_letter_version_id,'cover_letter_decision',v_package.cover_letter_decision));
  return jsonb_build_object('application_id',p_application_id,'state','content_approved','approved_at',v_package.approved_at);
end;
$$;
revoke execute on function public.approve_application_content(uuid) from public, anon;
grant execute on function public.approve_application_content(uuid) to authenticated;

-- Reserved gate states must be reached through their validating RPCs, never the generic state changer.
create or replace function public.transition_application_state(
  p_application_id uuid,
  p_to_state public.application_state,
  p_metadata jsonb default '{}'::jsonb
)
returns public.applications
language plpgsql
security invoker
set search_path = public
as $$
declare v_app public.applications; v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_to_state in ('ready_for_review','content_approved') then
    raise exception 'Reserved approval-gate state. Use the dedicated review workflow.';
  end if;
  select * into v_app from public.applications where id=p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.user_id <> v_user then raise exception 'Not authorised'; end if;
  if v_app.state=p_to_state then return v_app; end if;
  if not exists(select 1 from public.application_state_transitions where from_state=v_app.state and to_state=p_to_state) then
    raise exception 'Invalid application transition: % -> %',v_app.state,p_to_state;
  end if;
  update public.applications set state=p_to_state,updated_at=now(),submitted_at=case when p_to_state='submitted' then coalesce(submitted_at,now()) else submitted_at end
    where id=p_application_id returning * into v_app;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_app.user_id,'user',v_user::text,'application.state_changed','application',v_app.id,jsonb_build_object('to_state',p_to_state)||p_metadata);
  return v_app;
end;
$$;
revoke all on function public.transition_application_state(uuid, public.application_state, jsonb) from public, anon;
grant execute on function public.transition_application_state(uuid, public.application_state, jsonb) to authenticated;
