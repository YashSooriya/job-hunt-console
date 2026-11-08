-- M08: factual review covers the exact saved version and rendered PDF/DOCX.
-- A Gate 1 reviewer cannot repoint an accepted version or replace/delete its
-- stored files after individual acceptance or Gate 1 approval.

alter table public.document_versions
  add column if not exists factual_review_locked_at timestamptz;
revoke update (factual_review_locked_at) on public.document_versions from public,anon,authenticated,service_role;

create or replace function public.guard_application_content_mutation()
returns trigger
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_application_id uuid;
  v_state public.application_state;
  v_submission_lock boolean := false;
begin
  if tg_table_name='document_versions' then
    select application_id into v_application_id
      from public.documents
     where id=old.document_id;
  elsif tg_table_name='application_salary_contexts' then
    v_application_id:=case when tg_op='DELETE' then old.application_id else new.application_id end;
  elsif tg_table_name='application_answers' then
    v_application_id:=case when tg_op='DELETE' then old.application_id else new.application_id end;
  end if;

  if v_application_id is null then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;

  if auth.uid() is not null and (not private.current_user_active_member() or not exists(
      select 1 from public.applications where id=v_application_id and user_id=(select auth.uid())
    )) then
    raise exception 'Active application owner membership required';
  end if;

  select state into v_state from public.applications where id=v_application_id;

  -- One-time migration backfill for rows approved before this sticky marker
  -- existed. No artifact field or mutable approval field may change here.
  if tg_table_name='document_versions' and tg_op='UPDATE'
     and old.approval_status='approved' and old.approved_at is not null
     and old.factual_review_locked_at is null and new.factual_review_locked_at=old.approved_at
     and (to_jsonb(new)-array['factual_review_locked_at']::text[])
           is not distinct from (to_jsonb(old)-array['factual_review_locked_at']::text[]) then
    return new;
  end if;

  -- The private submission-context helper is the only trusted path allowed
  -- to change an approved version to submitted. It may stamp only the exact
  -- Gate 1-pinned versions and only after a later form review has completed.
  if tg_table_name='document_versions' and tg_op='UPDATE'
     and v_state in ('final_review','approved_for_submission')
     and old.approval_status='approved' and new.approval_status='submitted'
     and old.factual_review_locked_at is not null
     and old.submission_locked_at is null and new.submission_locked_at is not null
     and (to_jsonb(new)-array['approval_status','submission_locked_at']::text[])
           is not distinct from
         (to_jsonb(old)-array['approval_status','submission_locked_at']::text[])
     and exists(
       select 1 from public.documents d
       join public.applications a on a.id=d.application_id
       join public.application_review_packages rp on rp.application_id=a.id
       where d.id=old.document_id and a.id=v_application_id
         and a.state in ('final_review','approved_for_submission')
         and rp.approved_at is not null
         and (old.id=rp.cv_version_id
           or (rp.cover_letter_decision='use' and old.id=rp.cover_letter_version_id))
     ) then
    v_submission_lock:=true;
  end if;
  if v_submission_lock then return new; end if;

  if v_state not in ('preparing','ready_for_review','revision_requested') then
    raise exception 'Application content is frozen after Approval Gate 1. Return to a revision state before changing it.';
  end if;

  if tg_table_name='document_versions'
     and (old.approval_status='approved' or old.factual_review_locked_at is not null) then
    if tg_op='DELETE' then
      raise exception 'Factual review locks this exact version and rendered files; create a new version for changed content.';
    end if;
    if (to_jsonb(new)-array['approval_status','approved_at','approved_by','submission_locked_at','factual_review_locked_at']::text[])
         is distinct from
       (to_jsonb(old)-array['approval_status','approved_at','approved_by','submission_locked_at','factual_review_locked_at']::text[]) then
      raise exception 'Factual review locks this exact version and rendered files; create a new version for changed content.';
    end if;
  end if;

  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke execute on function public.guard_application_content_mutation() from public,anon,authenticated;

-- Keep an immutable marker across return-to-revision, where the mutable
-- approval status is deliberately cleared so the user can review again.
update public.document_versions
   set factual_review_locked_at=coalesce(factual_review_locked_at,approved_at)
 where approval_status='approved' and approved_at is not null and factual_review_locked_at is null;

create or replace function public.review_application_document(p_application_id uuid,p_version_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_kind public.document_kind;
  v_state public.application_state;
  v_unsupported integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_decision not in ('approve','reject') then raise exception 'Unsupported document review decision'; end if;
  select a.state,d.kind,jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))
    into v_state,v_kind,v_unsupported from public.applications a
    join public.documents d on d.application_id=a.id
    join public.document_versions dv on dv.document_id=d.id
   where a.id=p_application_id and a.user_id=v_user and dv.id=p_version_id and dv.rendered_object_key is not null;
  if v_kind is null then raise exception 'Rendered document version does not belong to this application'; end if;
  if v_state not in ('ready_for_review','revision_requested') then raise exception 'Documents can only be reviewed during content review'; end if;
  if p_decision='approve' and v_unsupported>0 then raise exception 'A document with unsupported claims cannot be accepted'; end if;
  update public.document_versions set approval_status=case when p_decision='approve' then 'approved' else 'rejected' end,
    approved_at=case when p_decision='approve' then now() else null end,
    approved_by=case when p_decision='approve' then v_user else null end,
    factual_review_locked_at=case when p_decision='approve' then coalesce(factual_review_locked_at,now()) else factual_review_locked_at end
   where id=p_version_id;
  if v_kind='cv' then
    update public.application_review_packages set cv_version_id=p_version_id,approved_at=null,approved_by=null,updated_at=now()
      where application_id=p_application_id;
  else
    update public.application_review_packages set cover_letter_version_id=p_version_id,cover_letter_decision='use',
      approved_at=null,approved_by=null,updated_at=now() where application_id=p_application_id;
  end if;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'user',v_user::text,'document.reviewed','document_version',p_version_id,
      jsonb_build_object('application_id',p_application_id,'decision',p_decision,'kind',v_kind));
  return jsonb_build_object('version_id',p_version_id,'decision',p_decision,'kind',v_kind);
end;
$$;
revoke all on function public.review_application_document(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.review_application_document(uuid,uuid,text) to authenticated;

create or replace function public.approve_application_content(p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid()); v_app public.applications; v_package public.application_review_packages;
  v_cv_status text; v_cv_review_locked_at timestamptz; v_cover_status text; v_cover_review_locked_at timestamptz;
  v_unresolved integer; v_unapproved integer; v_salary integer; v_answer_ids uuid[];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state<>'ready_for_review' then raise exception 'Application must be Ready for Review before content approval'; end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id for update;
  if not found or v_package.assembled_at is null then raise exception 'Review package has not been assembled'; end if;

  select dv.approval_status,dv.factual_review_locked_at into v_cv_status,v_cv_review_locked_at
    from public.documents d join public.document_versions dv on dv.document_id=d.id
   where d.application_id=p_application_id and d.kind='cv' and dv.id=v_package.cv_version_id
     and dv.rendered_object_key is not null
     and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0;
  if v_cv_status is distinct from 'approved' or v_cv_review_locked_at is null then
    raise exception 'Selected CV version is not approved';
  end if;

  if v_package.cover_letter_decision='use' then
    select dv.approval_status,dv.factual_review_locked_at into v_cover_status,v_cover_review_locked_at
      from public.documents d join public.document_versions dv on dv.document_id=d.id
     where d.application_id=p_application_id and d.kind='cover_letter' and dv.id=v_package.cover_letter_version_id
       and dv.rendered_object_key is not null
       and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0;
    if v_cover_status is distinct from 'approved' or v_cover_review_locked_at is null then
      raise exception 'Selected cover-letter version is not approved';
    end if;
  elsif v_package.cover_letter_version_id is not null then
    raise exception 'A removed or unnecessary cover letter cannot remain selected';
  end if;

  select recommended_value into v_salary from public.application_salary_contexts
   where application_id=p_application_id and approved_at is not null and recommended_value>0;
  if v_salary is null then raise exception 'Salary expectation has not been approved'; end if;
  select count(*) into v_unresolved from public.application_answers
   where application_id=p_application_id and required and nullif(btrim(coalesce(answer_text,'')),'') is null;
  if v_unresolved>0 then raise exception '% required screening answer(s) remain blank',v_unresolved; end if;
  select count(*) into v_unapproved from public.application_answers where application_id=p_application_id and
   ((trust='proposed' and approved_at is null) or
    (trust='user_required' and (approved_at is null or nullif(btrim(coalesce(answer_text,'')),'') is null)));
  if v_unapproved>0 then raise exception '% generated/user-only screening answer(s) are not approved',v_unapproved; end if;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_answer_ids from public.application_answers
   where application_id=p_application_id and (required or trust in ('proposed','user_required'));

  update public.application_review_packages set approved_at=now(),approved_by=v_user,updated_at=now()
   where application_id=p_application_id returning * into v_package;
  update public.applications set state='content_approved',next_action='Review the approved package before any separate employer-form action.',updated_at=now()
   where id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
   values(v_user,'user',v_user::text,'application.content_approved','application',p_application_id,
    jsonb_build_object('cv_version_id',v_package.cv_version_id,'cover_letter_version_id',v_package.cover_letter_version_id,
      'cover_letter_decision',v_package.cover_letter_decision,'salary_recommended_value',v_salary,'reviewed_answer_ids',v_answer_ids));
  return jsonb_build_object('application_id',p_application_id,'state','content_approved','approved_at',v_package.approved_at,
    'cv_version_id',v_package.cv_version_id,'cover_letter_version_id',v_package.cover_letter_version_id,
    'cover_letter_decision',v_package.cover_letter_decision,'salary_recommended_value',v_salary,'reviewed_answer_ids',v_answer_ids);
end;
$$;
revoke all on function public.approve_application_content(uuid) from public,anon,service_role;
grant execute on function public.approve_application_content(uuid) to authenticated;

create or replace function private.can_mutate_application_document_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_application_id uuid;
  v_version_id uuid;
  v_kind public.document_kind;
  v_state public.application_state;
  v_approved_at timestamptz;
  v_approval_status text;
  v_factual_review_locked_at timestamptz;
  v_file text;
begin
  if v_user is null or not private.current_user_active_member() then return false; end if;
  if split_part(coalesce(p_name,''),'/',1)<>v_user::text then return false; end if;
  begin
    v_application_id:=split_part(p_name,'/',2)::uuid;
    v_version_id:=split_part(p_name,'/',3)::uuid;
  exception when invalid_text_representation then return false;
  end;
  v_file:=split_part(p_name,'/',4);

  select d.kind,a.state,rp.approved_at,dv.approval_status,dv.factual_review_locked_at
    into v_kind,v_state,v_approved_at,v_approval_status,v_factual_review_locked_at
    from public.document_versions dv
    join public.documents d on d.id=dv.document_id
    join public.applications a on a.id=d.application_id
    left join public.application_review_packages rp on rp.application_id=a.id
   where dv.id=v_version_id and d.application_id=v_application_id and a.user_id=v_user;
  if not found or v_state='content_approved' or v_approved_at is not null
     or v_approval_status='approved' or v_factual_review_locked_at is not null then return false; end if;
  if v_kind='cv' then return v_file in ('cv.pdf','cv.docx'); end if;
  if v_kind='cover_letter' then return v_file in ('cover_letter.pdf','cover_letter.docx','cover-letter.pdf','cover-letter.docx'); end if;
  return false;
end;
$$;
revoke all on function private.can_mutate_application_document_object(text) from public,anon,service_role;
grant execute on function private.can_mutate_application_document_object(text) to authenticated;

drop policy if exists jobhunt_application_documents_insert on storage.objects;
drop policy if exists jobhunt_application_documents_update on storage.objects;
drop policy if exists jobhunt_application_documents_delete on storage.objects;
create policy jobhunt_application_documents_insert on storage.objects
  for insert to authenticated with check (
    bucket_id='application-documents' and private.can_mutate_application_document_object(name)
  );
create policy jobhunt_application_documents_update on storage.objects
  for update to authenticated using (
    bucket_id='application-documents' and private.can_mutate_application_document_object(name)
  ) with check (
    bucket_id='application-documents' and private.can_mutate_application_document_object(name)
  );
create policy jobhunt_application_documents_delete on storage.objects
  for delete to authenticated using (
    bucket_id='application-documents' and private.can_mutate_application_document_object(name)
  );

notify pgrst,'reload schema';
