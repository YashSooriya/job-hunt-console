-- Milestone 5: evidence-backed CV versions, validation and private PDF storage.

create unique index if not exists idx_documents_one_application_cv
  on public.documents(application_id)
  where kind = 'cv' and application_id is not null;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('application-documents', 'application-documents', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists jobhunt_application_documents_select on storage.objects;
drop policy if exists jobhunt_application_documents_insert on storage.objects;
drop policy if exists jobhunt_application_documents_update on storage.objects;
drop policy if exists jobhunt_application_documents_delete on storage.objects;

create policy jobhunt_application_documents_select on storage.objects
for select to authenticated
using (bucket_id = 'application-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy jobhunt_application_documents_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'application-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy jobhunt_application_documents_update on storage.objects
for update to authenticated
using (bucket_id = 'application-documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'application-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy jobhunt_application_documents_delete on storage.objects
for delete to authenticated
using (bucket_id = 'application-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create or replace function public.validate_cv_structured_content()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind public.document_kind;
  v_missing integer;
begin
  select kind into v_kind from public.documents where id = new.document_id;
  if v_kind <> 'cv' then return new; end if;

  if jsonb_typeof(coalesce(new.structured_content->'unsupported_claims','[]'::jsonb)) <> 'array' then
    raise exception 'CV unsupported_claims must be an array';
  end if;
  if jsonb_array_length(coalesce(new.structured_content->'unsupported_claims','[]'::jsonb)) > 0 then
    raise exception 'CV contains unsupported material claims';
  end if;
  if jsonb_array_length(coalesce(new.structured_content->'profile_summary'->'evidence_ids','[]'::jsonb)) = 0 then
    raise exception 'CV profile summary must have evidence';
  end if;

  select count(*) into v_missing
  from jsonb_array_elements(coalesce(new.structured_content->'sections','[]'::jsonb)) s,
       jsonb_array_elements(coalesce(s->'entries','[]'::jsonb)) e,
       jsonb_array_elements(coalesce(e->'bullets','[]'::jsonb)) b
  where coalesce((b->>'material')::boolean,false)
    and jsonb_array_length(coalesce(b->'evidence_ids','[]'::jsonb)) = 0;
  if v_missing > 0 then
    raise exception 'CV contains material bullets without evidence';
  end if;
  return new;
end;
$$;

drop trigger if exists document_versions_validate_cv on public.document_versions;
create trigger document_versions_validate_cv
before insert or update of structured_content, approval_status on public.document_versions
for each row execute function public.validate_cv_structured_content();
revoke execute on function public.validate_cv_structured_content() from public, anon, authenticated;

create or replace function public.prevent_locked_document_evidence_changes()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version_id uuid := coalesce(new.document_version_id, old.document_version_id);
  v_locked timestamptz;
begin
  select submission_locked_at into v_locked from public.document_versions where id = v_version_id;
  if v_locked is not null then raise exception 'Submitted document evidence links are immutable'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists document_evidence_immutable_after_submission on public.document_evidence_links;
create trigger document_evidence_immutable_after_submission
before insert or update or delete on public.document_evidence_links
for each row execute function public.prevent_locked_document_evidence_changes();
revoke execute on function public.prevent_locked_document_evidence_changes() from public, anon, authenticated;

create or replace function public.create_cv_document_version(
  p_application_id uuid,
  p_structured_content jsonb,
  p_latex_source text,
  p_evidence_links jsonb,
  p_engine text default 'deterministic_v1'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_profile_id uuid;
  v_document public.documents;
  v_version public.document_versions;
  v_version_number integer;
  v_claim record;
  v_evidence_id_text text;
  v_evidence_id uuid;
  v_link jsonb;
  v_expected_family text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_structured_content is null then raise exception 'Structured CV content is required'; end if;

  select * into v_app from public.applications where id = p_application_id and user_id = v_user;
  if not found then raise exception 'Application not found'; end if;
  if v_app.selected_cv_family is null then raise exception 'Application has no selected CV family'; end if;
  v_expected_family := v_app.selected_cv_family::text;
  if coalesce(p_structured_content->>'base_family','') <> v_expected_family then
    raise exception 'CV base family does not match the application';
  end if;
  if jsonb_array_length(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb)) > 0 then
    raise exception 'CV contains unsupported claims';
  end if;

  select id into v_profile_id from public.candidate_profiles where user_id = v_user limit 1;
  if v_profile_id is null then raise exception 'Candidate profile not found'; end if;

  for v_claim in
    select 'profile_summary'::text as claim_key, coalesce(p_structured_content->'profile_summary'->'evidence_ids','[]'::jsonb) as evidence_ids
    union all
    select b->>'claim_key', coalesce(b->'evidence_ids','[]'::jsonb)
    from jsonb_array_elements(coalesce(p_structured_content->'sections','[]'::jsonb)) s,
         jsonb_array_elements(coalesce(s->'entries','[]'::jsonb)) e,
         jsonb_array_elements(coalesce(e->'bullets','[]'::jsonb)) b
    where coalesce((b->>'material')::boolean,false)
  loop
    if v_claim.claim_key is null or jsonb_array_length(v_claim.evidence_ids)=0 then
      raise exception 'Material CV claim has no evidence';
    end if;
    for v_evidence_id_text in select jsonb_array_elements_text(v_claim.evidence_ids)
    loop
      begin v_evidence_id := v_evidence_id_text::uuid;
      exception when invalid_text_representation then raise exception 'CV evidence ID is not a persistent UUID: %', v_evidence_id_text;
      end;
      if not exists (
        select 1 from public.evidence_items
        where id=v_evidence_id and profile_id=v_profile_id and verification_status='verified'
      ) then raise exception 'CV references unverified or foreign evidence: %', v_evidence_id_text; end if;
      if not exists (
        select 1 from jsonb_array_elements(coalesce(p_evidence_links,'[]'::jsonb)) x
        where x->>'claim_key'=v_claim.claim_key and x->>'evidence_id'=v_evidence_id_text
      ) then raise exception 'CV evidence-link manifest is incomplete for claim %', v_claim.claim_key; end if;
    end loop;
  end loop;

  select * into v_document from public.documents
  where application_id=p_application_id and kind='cv'
  for update;
  if not found then
    insert into public.documents(application_id, kind, title, cv_family)
    values(p_application_id,'cv',coalesce(v_app.selected_cv_family::text,'Tailored') || ' CV',v_app.selected_cv_family)
    returning * into v_document;
  end if;

  select coalesce(max(version_number),0)+1 into v_version_number
  from public.document_versions where document_id=v_document.id;

  insert into public.document_versions(
    document_id, version_number, structured_content, latex_source,
    model, prompt_version, change_summary, approval_status
  ) values (
    v_document.id, v_version_number, p_structured_content, p_latex_source,
    p_engine, coalesce(p_structured_content->>'contract_version','1.0.0'),
    coalesce(p_structured_content->'change_summary','[]'::jsonb), 'needs_review'
  ) returning * into v_version;

  for v_link in select value from jsonb_array_elements(coalesce(p_evidence_links,'[]'::jsonb))
  loop
    insert into public.document_evidence_links(document_version_id,evidence_item_id,claim_key)
    values(v_version.id,(v_link->>'evidence_id')::uuid,v_link->>'claim_key')
    on conflict do nothing;
  end loop;

  update public.automation_tasks
  set state='completed', updated_at=now(), output_json=jsonb_build_object(
    'document_id',v_document.id,'document_version_id',v_version.id,'version_number',v_version_number,
    'unsupported_claims_count',0,'engine',p_engine
  )
  where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_cv';

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'system','cv-engine','document.cv_version_created','document_version',v_version.id,
    jsonb_build_object('application_id',p_application_id,'document_id',v_document.id,'version_number',v_version_number,'engine',p_engine,'cv_family',v_app.selected_cv_family));

  return jsonb_build_object('document_id',v_document.id,'document_version_id',v_version.id,'version_number',v_version_number,'approval_status','needs_review');
end;
$$;

revoke execute on function public.create_cv_document_version(uuid,jsonb,text,jsonb,text) from public, anon;
grant execute on function public.create_cv_document_version(uuid,jsonb,text,jsonb,text) to authenticated;
