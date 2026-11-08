-- M08: make the Review Centre the only authenticated path into and through Gate 1.

-- Review-package, answer, salary, document and version stamps are changed only
-- by the owner-checked review/document RPCs. Keep reads and the narrow link
-- update used when an approved reusable answer is associated with its source.
revoke insert, update, delete on public.application_review_packages from public, anon, authenticated;
grant select on public.application_review_packages to authenticated;
revoke insert, update, delete on public.documents from public, anon, authenticated;
grant select on public.documents to authenticated;
revoke insert, update, delete on public.document_evidence_links from public, anon, authenticated;
grant select on public.document_evidence_links to authenticated;
revoke insert, update, delete on public.application_salary_contexts from public, anon, authenticated;
grant select on public.application_salary_contexts to authenticated;
revoke insert, update, delete on public.application_answers from public, anon, authenticated;
revoke insert, update, delete on public.document_versions from public, anon, authenticated;
grant select on public.document_versions to authenticated;
revoke update (state) on public.applications from public, anon, authenticated;

do $$
declare
  v_answer_columns text;
  v_version_columns text;
begin
  select string_agg(format('%I',a.attname),', ' order by a.attnum)
    into v_answer_columns from pg_attribute a
   where a.attrelid='public.application_answers'::regclass and a.attnum>0 and not a.attisdropped;
  select string_agg(format('%I',a.attname),', ' order by a.attnum)
    into v_version_columns from pg_attribute a
   where a.attrelid='public.document_versions'::regclass and a.attnum>0 and not a.attisdropped;
  if v_answer_columns is null or v_version_columns is null then
    raise exception 'Could not resolve M08 protected columns';
  end if;
  execute format('revoke insert (%s), update (%s) on public.application_answers from public, anon, authenticated',v_answer_columns,v_answer_columns);
  execute format('revoke update (%s) on public.document_versions from public, anon, authenticated',v_version_columns);
end;
$$;
grant select on public.application_answers to authenticated;
grant update (source_reusable_answer_id,updated_at) on public.application_answers to authenticated;
-- Existing CV/letter renderers attach the private PDF key after upload. No
-- other version field is directly writable by an authenticated client.
grant update (rendered_object_key) on public.document_versions to authenticated;

alter table public.application_salary_contexts drop constraint if exists application_salary_contexts_source_check;
alter table public.application_salary_contexts add constraint application_salary_contexts_source_check
  check (source in ('advertised','estimated','user_provided'));

insert into public.application_state_transitions(from_state,to_state)
values ('content_approved','revision_requested') on conflict do nothing;

-- Preserve the original Gate 1 row guards and extend them to version updates
-- and deletes. A user must first use the explicit return-to-revision action.
create or replace function public.guard_application_content_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_application_id uuid;
  v_state public.application_state;
begin
  if tg_table_name='document_versions' then
    select application_id into v_application_id from public.documents
      where id=case when tg_op='DELETE' then old.document_id else new.document_id end;
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
  if v_state not in ('preparing','ready_for_review','revision_requested') then
    raise exception 'Application content is frozen after Approval Gate 1. Return to a revision state before changing it.';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists document_versions_gate1_freeze_update on public.document_versions;
drop trigger if exists document_versions_gate1_freeze_delete on public.document_versions;
create trigger document_versions_gate1_freeze_update before update on public.document_versions
  for each row execute function public.guard_application_content_mutation();
create trigger document_versions_gate1_freeze_delete before delete on public.document_versions
  for each row execute function public.guard_application_content_mutation();
revoke execute on function public.guard_application_content_mutation() from public,anon,authenticated;

-- Storage objects are writable only for the exact owner/application/version
-- path, and only while that application has not passed Gate 1.
create or replace function private.can_mutate_application_document_object(p_name text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_application_id uuid;
  v_version_id uuid;
  v_kind public.document_kind;
  v_state public.application_state;
  v_approved_at timestamptz;
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
  select d.kind,a.state,rp.approved_at into v_kind,v_state,v_approved_at
    from public.document_versions dv
    join public.documents d on d.id=dv.document_id
    join public.applications a on a.id=d.application_id
    left join public.application_review_packages rp on rp.application_id=a.id
   where dv.id=v_version_id and d.application_id=v_application_id and a.user_id=v_user;
  if not found or v_state='content_approved' or v_approved_at is not null then return false; end if;
  if v_kind='cv' then return v_file in ('cv.pdf','cv.docx'); end if;
  if v_kind='cover_letter' then return v_file in ('cover_letter.pdf','cover_letter.docx','cover-letter.pdf','cover-letter.docx'); end if;
  return false;
end;
$$;
revoke all on function private.can_mutate_application_document_object(text) from public,anon;
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

-- These existing writers remain the supported application-document paths.
-- SECURITY DEFINER is required after authenticated table DML is narrowed;
-- each function already derives auth.uid() and verifies its owned application.
alter function public.create_cv_document_version(uuid,jsonb,text,jsonb,text) security definer;
alter function public.create_cv_document_version(uuid,jsonb,text,jsonb,text) set search_path='';
alter function public.create_application_cover_letter_version(uuid,jsonb,text) security definer;
alter function public.create_application_cover_letter_version(uuid,jsonb,text) set search_path='';
alter function public.save_application_content_package(uuid,jsonb,jsonb,jsonb,text,jsonb,text) security definer;
alter function public.save_application_content_package(uuid,jsonb,jsonb,jsonb,text,jsonb,text) set search_path='';
alter function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) security definer;
alter function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) set search_path='';

create or replace function public.assemble_application_review_package(p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_package public.application_review_packages;
  v_cv_version uuid;
  v_cover_version uuid;
  v_cover_decision text;
  v_cover_exists boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state not in ('preparing','revision_requested','ready_for_review') then
    raise exception 'Application cannot be assembled for review from state %',v_app.state;
  end if;

  select rp.* into v_package from public.application_review_packages rp where rp.application_id=p_application_id for update;
  if not found then
    insert into public.application_review_packages(application_id,created_at,updated_at)
      values(p_application_id,now(),now()) on conflict(application_id) do nothing;
    select rp.* into v_package from public.application_review_packages rp where rp.application_id=p_application_id for update;
  end if;

  if exists(select 1 from public.documents d join public.document_versions dv on dv.document_id=d.id
      where d.application_id=p_application_id and d.kind='cv' and dv.id=v_package.cv_version_id
        and dv.rendered_object_key is not null
        and jsonb_typeof(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))='array'
        and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0) then
    v_cv_version:=v_package.cv_version_id;
  else
    select dv.id into v_cv_version from public.documents d join public.document_versions dv on dv.document_id=d.id
      where d.application_id=p_application_id and d.kind='cv' and dv.rendered_object_key is not null
        and jsonb_typeof(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))='array'
        and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0
      order by dv.version_number desc limit 1;
  end if;
  if v_cv_version is null then raise exception 'A rendered CV without unsupported claims is required for review'; end if;

  select exists(select 1 from public.documents d join public.document_versions dv on dv.document_id=d.id
      where d.application_id=p_application_id and d.kind='cover_letter' and dv.rendered_object_key is not null
        and jsonb_typeof(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))='array'
        and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0) into v_cover_exists;
  if not v_cover_exists then
    v_cover_decision:='not_required';
    v_cover_version:=null;
  elsif v_package.cover_letter_decision='remove' then
    v_cover_decision:='remove';
    v_cover_version:=null;
  elsif exists(select 1 from public.documents d join public.document_versions dv on dv.document_id=d.id
      where d.application_id=p_application_id and d.kind='cover_letter' and dv.id=v_package.cover_letter_version_id
        and dv.rendered_object_key is not null
        and jsonb_typeof(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))='array'
        and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0) then
    v_cover_decision:='use';
    v_cover_version:=v_package.cover_letter_version_id;
  else
    v_cover_decision:='use';
    select dv.id into v_cover_version from public.documents d join public.document_versions dv on dv.document_id=d.id
      where d.application_id=p_application_id and d.kind='cover_letter' and dv.rendered_object_key is not null
        and jsonb_typeof(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))='array'
        and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0
      order by dv.version_number desc limit 1;
  end if;

  update public.application_review_packages set cv_version_id=v_cv_version,
    cover_letter_version_id=v_cover_version,cover_letter_decision=v_cover_decision,
    assembled_at=now(),approved_at=null,approved_by=null,updated_at=now()
   where application_id=p_application_id returning * into v_package;
  if v_app.state<>'ready_for_review' then
    update public.applications set state='ready_for_review',next_action='Review and approve the exact selected application content.',updated_at=now()
      where id=p_application_id;
    insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
      values(v_user,'system','review-centre','application.ready_for_review','application',p_application_id,
        jsonb_build_object('cv_version_id',v_cv_version,'cover_letter_version_id',v_cover_version,'cover_letter_decision',v_cover_decision));
  end if;
  return jsonb_build_object('application_id',p_application_id,'state','ready_for_review','cv_version_id',v_cv_version,
    'cover_letter_version_id',v_cover_version,'cover_letter_decision',v_cover_decision,'assembled_at',v_package.assembled_at);
end;
$$;
revoke all on function public.assemble_application_review_package(uuid) from public,anon,service_role;
grant execute on function public.assemble_application_review_package(uuid) to authenticated;

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
    approved_by=case when p_decision='approve' then v_user else null end where id=p_version_id;
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

create or replace function public.review_application_salary(p_application_id uuid,p_recommended_value integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_salary public.application_salary_contexts;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_recommended_value is null or p_recommended_value<=0 then raise exception 'A positive salary expectation is required'; end if;
  if not exists(select 1 from public.applications where id=p_application_id and user_id=v_user and state in ('ready_for_review','revision_requested')) then
    raise exception 'Salary can only be reviewed during application content review';
  end if;
  insert into public.application_salary_contexts(application_id,source,recommended_value,currency,confidence,trust,basis,approved_at,approved_by,updated_at)
    values(p_application_id,'user_provided',p_recommended_value,'GBP','low','user_required','["entered_by_user"]'::jsonb,now(),v_user,now())
    on conflict(application_id) do update set recommended_value=excluded.recommended_value,
      approved_at=now(),approved_by=v_user,updated_at=now()
    returning * into v_salary;
  update public.application_review_packages set approved_at=null,approved_by=null,updated_at=now() where application_id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'user',v_user::text,'application.salary_approved','application',p_application_id,
      jsonb_build_object('recommended_value',v_salary.recommended_value,'currency',v_salary.currency,'source',v_salary.source));
  return jsonb_build_object('application_id',p_application_id,'recommended_value',v_salary.recommended_value,
    'currency',v_salary.currency,'approved_at',v_salary.approved_at,'source',v_salary.source);
end;
$$;
revoke all on function public.review_application_salary(uuid,integer) from public,anon,service_role;
grant execute on function public.review_application_salary(uuid,integer) to authenticated;

create or replace function public.review_application_answer(p_application_id uuid,p_answer_id uuid,p_answer_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_answer public.application_answers; v_text text:=nullif(btrim(coalesce(p_answer_text,'')),'');
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select aa.* into v_answer from public.application_answers aa join public.applications a on a.id=aa.application_id
   where aa.id=p_answer_id and aa.application_id=p_application_id and a.user_id=v_user
     and a.state in ('ready_for_review','revision_requested');
  if not found then raise exception 'Answer is not reviewable'; end if;
  if v_answer.trust='verified' then
    if v_text is not null and v_text is distinct from v_answer.answer_text then
      raise exception 'Verified answers cannot be edited without changing the underlying verified fact';
    end if;
    v_text:=v_answer.answer_text;
  end if;
  if v_answer.required and v_text is null then raise exception 'A required answer cannot be approved blank'; end if;
  update public.application_answers set answer_text=v_text,approved_at=now(),approved_by=v_user,updated_at=now()
    where id=p_answer_id returning * into v_answer;
  update public.application_review_packages set approved_at=null,approved_by=null,updated_at=now() where application_id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'user',v_user::text,'application.answer_approved','application_answer',p_answer_id,
      jsonb_build_object('application_id',p_application_id,'trust',v_answer.trust,'question_key',v_answer.question_key));
  return jsonb_build_object('answer_id',p_answer_id,'trust',v_answer.trust,'approved_at',v_answer.approved_at);
end;
$$;
revoke all on function public.review_application_answer(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.review_application_answer(uuid,uuid,text) to authenticated;

create or replace function public.set_application_cover_letter_decision(p_application_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_package public.application_review_packages; v_version uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_decision not in ('use','remove') then raise exception 'Cover-letter decision must be use or remove'; end if;
  if not exists(select 1 from public.applications where id=p_application_id and user_id=v_user and state in ('ready_for_review','revision_requested')) then
    raise exception 'Cover-letter decision can only be changed during application content review';
  end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id for update;
  if not found or v_package.assembled_at is null then raise exception 'Assemble the review package before deciding about the cover letter'; end if;
  if p_decision='use' then
    if exists(select 1 from public.documents d join public.document_versions dv on dv.document_id=d.id
        where d.application_id=p_application_id and d.kind='cover_letter' and dv.id=v_package.cover_letter_version_id
          and dv.rendered_object_key is not null) then
      v_version:=v_package.cover_letter_version_id;
    else
      select dv.id into v_version from public.documents d join public.document_versions dv on dv.document_id=d.id
       where d.application_id=p_application_id and d.kind='cover_letter' and dv.rendered_object_key is not null
       order by dv.version_number desc limit 1;
    end if;
    if v_version is null then raise exception 'No rendered cover-letter version exists'; end if;
  end if;
  update public.application_review_packages set cover_letter_decision=p_decision,
    cover_letter_version_id=v_version,approved_at=null,approved_by=null,updated_at=now()
   where application_id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'user',v_user::text,'application.cover_letter_decision','application',p_application_id,
      jsonb_build_object('decision',p_decision,'cover_letter_version_id',v_version));
  return jsonb_build_object('application_id',p_application_id,'decision',p_decision,'cover_letter_version_id',v_version);
end;
$$;
revoke all on function public.set_application_cover_letter_decision(uuid,text) from public,anon,service_role;
grant execute on function public.set_application_cover_letter_decision(uuid,text) to authenticated;

create or replace function public.approve_application_content(p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid()); v_app public.applications; v_package public.application_review_packages;
  v_cv_status text; v_cover_status text; v_unresolved integer; v_unapproved integer;
  v_salary integer; v_answer_ids uuid[];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state<>'ready_for_review' then raise exception 'Application must be Ready for Review before content approval'; end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id for update;
  if not found or v_package.assembled_at is null then raise exception 'Review package has not been assembled'; end if;
  select dv.approval_status into v_cv_status from public.documents d join public.document_versions dv on dv.document_id=d.id
   where d.application_id=p_application_id and d.kind='cv' and dv.id=v_package.cv_version_id
     and dv.rendered_object_key is not null
     and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0;
  if v_cv_status is distinct from 'approved' then raise exception 'Selected CV version is not approved'; end if;
  if v_package.cover_letter_decision='use' then
    select dv.approval_status into v_cover_status from public.documents d join public.document_versions dv on dv.document_id=d.id
     where d.application_id=p_application_id and d.kind='cover_letter' and dv.id=v_package.cover_letter_version_id
       and dv.rendered_object_key is not null
       and jsonb_array_length(coalesce(dv.structured_content->'unsupported_claims','[]'::jsonb))=0;
    if v_cover_status is distinct from 'approved' then raise exception 'Selected cover-letter version is not approved'; end if;
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

create or replace function public.return_application_to_revision(p_application_id uuid,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid()); v_app public.applications; v_package public.application_review_packages;
  v_previous_approved_at timestamptz; v_answer_ids uuid[];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state<>'content_approved' then raise exception 'Only a Gate 1 approved application can be returned to revision'; end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id for update;
  if not found or v_package.approved_at is null then raise exception 'Approved Gate 1 package not found'; end if;
  v_previous_approved_at:=v_package.approved_at;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_answer_ids from public.application_answers
    where application_id=p_application_id and approved_at is not null;
  update public.applications set state='revision_requested',next_action='Revise the selected content and submit it for Gate 1 review again.',updated_at=now()
    where id=p_application_id;
  update public.document_versions set approval_status='needs_review',approved_at=null,approved_by=null
   where id in (v_package.cv_version_id,v_package.cover_letter_version_id) and approval_status='approved';
  update public.application_salary_contexts set approved_at=null,approved_by=null,updated_at=now() where application_id=p_application_id;
  update public.application_answers set approved_at=null,approved_by=null,updated_at=now()
   where application_id=p_application_id and approved_at is not null;
  update public.application_review_packages set approved_at=null,approved_by=null,assembled_at=null,updated_at=now()
   where application_id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
   values(v_user,'user',v_user::text,'application.content_returned_to_revision','application',p_application_id,
    jsonb_build_object('previous_approved_at',v_previous_approved_at,'cv_version_id',v_package.cv_version_id,
      'cover_letter_version_id',v_package.cover_letter_version_id,'cover_letter_decision',v_package.cover_letter_decision,
      'salary_reapproval_required',true,'answer_ids_reapproval_required',v_answer_ids,
      'reason',left(nullif(btrim(coalesce(p_reason,'')),''),500)));
  return jsonb_build_object('application_id',p_application_id,'state','revision_requested','approval_invalidated',true);
end;
$$;
revoke all on function public.return_application_to_revision(uuid,text) from public,anon,service_role;
grant execute on function public.return_application_to_revision(uuid,text) to authenticated;

create or replace function public.transition_application_state(
  p_application_id uuid,p_to_state public.application_state,p_metadata jsonb default '{}'::jsonb
)
returns public.applications language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_app public.applications; v_from public.application_state;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_to_state in ('ready_for_review','content_approved','form_in_progress','form_needs_user','final_review','approved_for_submission','submitted') then
    raise exception 'Target state % is reserved for its validated workflow',p_to_state;
  end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state='content_approved' and p_to_state='revision_requested' then
    raise exception 'Use return_application_to_revision to clear Gate 1 approval and preserve the review timeline';
  end if;
  v_from:=v_app.state;
  if not exists(select 1 from public.application_state_transitions where from_state=v_from and to_state=p_to_state) then
    raise exception 'Invalid application transition: % -> %',v_from,p_to_state;
  end if;
  update public.applications set state=p_to_state,updated_at=now() where id=p_application_id returning * into v_app;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
    values(v_user,'user',v_user::text,'application.state_transition','application',p_application_id,
      jsonb_build_object('from',v_from,'to',p_to_state,'metadata',coalesce(p_metadata,'{}'::jsonb)));
  return v_app;
end;
$$;
revoke all on function public.transition_application_state(uuid,public.application_state,jsonb) from public,anon,service_role;
grant execute on function public.transition_application_state(uuid,public.application_state,jsonb) to authenticated;

notify pgrst,'reload schema';
