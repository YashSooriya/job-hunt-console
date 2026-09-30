-- Explicit, owner-scoped custom application documents and versioned theme choice.
-- ChatGPT dispatch remains on the existing Website Bridge.

create table public.document_generation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  request_key uuid not null,
  requested_kinds text[] not null check (cardinality(requested_kinds) between 1 and 2),
  template_id text not null check (template_id in (
    'classic-navy','clean-charcoal','technical-slate','research-classic',
    'modern-teal','engineering-blue','quiet-olive','minimal-black'
  )),
  input_snapshot jsonb not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  context_chunks jsonb not null default '[]'::jsonb,
  state text not null default 'queued' check (state in (
    'queued','preparing_context','writing','validating','rendering','saving_drive',
    'ready','partial','needs_user','failed','cancelled'
  )),
  current_kind text check (current_kind is null or current_kind in ('cv','cover_letter')),
  current_chunk integer not null default 0 check (current_chunk >= 0),
  dispatch_id uuid,
  response_text text,
  last_completed_dispatch_id uuid,
  session_epoch integer not null default 1 check (session_epoch > 0),
  attempts integer not null default 0 check (attempts >= 0),
  error_code text,
  error_message text,
  testing_mode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, request_key),
  check (requested_kinds <@ array['cv','cover_letter']::text[]),
  check (jsonb_typeof(context_chunks) = 'array'),
  check (octet_length(input_snapshot::text) <= 1000000),
  check (octet_length(context_chunks::text) <= 1000000)
);

create table public.document_generation_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null references public.document_generation_requests(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  document_kind text not null check (document_kind in ('cv','cover_letter')),
  state text not null default 'queued' check (state in (
    'queued','preparing_context','writing','validating','rendering','saving_drive',
    'ready','needs_user','failed','cancelled'
  )),
  response_hash text check (response_hash is null or response_hash ~ '^[0-9a-f]{64}$'),
  response_text text,
  structured_content jsonb,
  plaintext text,
  document_version_id uuid references public.document_versions(id) on delete set null,
  pdf_object_key text,
  docx_object_key text,
  preview_object_keys jsonb not null default '[]'::jsonb,
  pdf_sha256 text,
  docx_sha256 text,
  quality_report jsonb not null default '{}'::jsonb,
  drive_folder_id text,
  drive_pdf_id text,
  drive_docx_id text,
  drive_state text not null default 'pending' check (drive_state in ('pending','ready','retrying','needs_reconnect','not_configured')),
  error_code text,
  error_message text,
  version_number integer check (version_number is null or version_number > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, document_kind),
  unique (application_id, document_kind, version_number),
  check (pdf_object_key is null or split_part(pdf_object_key,'/',1)=user_id::text),
  check (docx_object_key is null or split_part(docx_object_key,'/',1)=user_id::text),
  check (jsonb_typeof(preview_object_keys)='array'),
  check (jsonb_typeof(quality_report)='object')
);

create table public.document_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_template_id text not null default 'classic-navy' check (default_template_id in (
    'classic-navy','clean-charcoal','technical-slate','research-classic',
    'modern-teal','engineering-blue','quiet-olive','minimal-black'
  )),
  updated_at timestamptz not null default now()
);

create index document_generation_requests_owner_recent
  on public.document_generation_requests(user_id,created_at desc);
create index document_generation_requests_active
  on public.document_generation_requests(state,updated_at)
  where state in ('queued','preparing_context','writing','validating','rendering','saving_drive');
create index document_generation_items_application_recent
  on public.document_generation_items(user_id,application_id,document_kind,created_at desc);

alter table public.document_generation_requests enable row level security;
alter table public.document_generation_items enable row level security;
alter table public.document_preferences enable row level security;
revoke all on public.document_generation_requests, public.document_generation_items, public.document_preferences from public, anon, authenticated, service_role;

create policy document_generation_requests_owner_select on public.document_generation_requests
  for select to authenticated using (user_id=(select auth.uid()) and private.current_user_active_member());
create policy document_generation_items_owner_select on public.document_generation_items
  for select to authenticated using (user_id=(select auth.uid()) and private.current_user_active_member());
create policy document_preferences_owner_select on public.document_preferences
  for select to authenticated using (user_id=(select auth.uid()) and private.current_user_active_member());

grant select on public.document_generation_requests, public.document_generation_items, public.document_preferences to authenticated;
grant insert,update on public.document_generation_requests, public.document_generation_items, public.document_preferences to authenticated;
create policy document_generation_requests_owner_write on public.document_generation_requests
  for all to authenticated
  using (user_id=(select auth.uid()) and private.current_user_active_member())
  with check (user_id=(select auth.uid()) and private.current_user_active_member()
    and exists(select 1 from public.applications a where a.id=application_id and a.user_id=(select auth.uid())));
create policy document_generation_items_owner_write on public.document_generation_items
  for all to authenticated
  using (user_id=(select auth.uid()) and private.current_user_active_member())
  with check (user_id=(select auth.uid()) and private.current_user_active_member()
    and exists(select 1 from public.applications a where a.id=application_id and a.user_id=(select auth.uid()))
    and exists(select 1 from public.document_generation_requests r where r.id=request_id and r.user_id=(select auth.uid())));
create policy document_preferences_owner_write on public.document_preferences
  for all to authenticated
  using (user_id=(select auth.uid()) and private.current_user_active_member())
  with check (user_id=(select auth.uid()) and private.current_user_active_member());

create or replace function public.create_application_document_generation(
  p_application_id uuid,
  p_request_key uuid,
  p_requested_kinds text[],
  p_template_id text,
  p_input_snapshot jsonb,
  p_input_hash text,
  p_context_chunks jsonb,
  p_testing_mode boolean default false
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_application public.applications;
  v_request public.document_generation_requests;
  v_kind text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_request_key is null or p_application_id is null then raise exception 'A valid application and request key are required'; end if;
  if p_template_id not in ('classic-navy','clean-charcoal','technical-slate','research-classic','modern-teal','engineering-blue','quiet-olive','minimal-black') then raise exception 'Choose a valid document theme'; end if;
  if p_requested_kinds is null or cardinality(p_requested_kinds) not between 1 and 2
     or exists(select 1 from unnest(p_requested_kinds) k where k not in ('cv','cover_letter'))
     or (select count(distinct k) from unnest(p_requested_kinds) k) <> cardinality(p_requested_kinds) then
    raise exception 'Choose a CV, cover letter, or both';
  end if;
  if coalesce(p_input_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input_snapshot)<>'object'
     or jsonb_typeof(p_context_chunks)<>'array' or octet_length(p_input_snapshot::text)>1000000
     or octet_length(p_context_chunks::text)>1000000 then
    raise exception 'Document generation context is incomplete or too large';
  end if;

  select * into v_application from public.applications a
   where a.id=p_application_id and a.user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_application.preparation_origin <> 'manual' then
    raise exception 'Choose to apply to this job before requesting custom documents';
  end if;
  if v_application.state not in ('preparing','ready_for_review','revision_requested') then
    raise exception 'Documents cannot be generated after application review has been locked';
  end if;

  select * into v_request from public.document_generation_requests r
   where r.user_id=v_user and r.request_key=p_request_key;
  if found then return jsonb_build_object('request_id',v_request.id,'state',v_request.state,'idempotent',true); end if;

  insert into public.document_generation_requests(
    user_id,application_id,request_key,requested_kinds,template_id,input_snapshot,input_hash,context_chunks,testing_mode
  ) values (
    v_user,p_application_id,p_request_key,p_requested_kinds,p_template_id,p_input_snapshot,p_input_hash,p_context_chunks,coalesce(p_testing_mode,false)
  ) returning * into v_request;

  foreach v_kind in array p_requested_kinds loop
    insert into public.document_generation_items(user_id,request_id,application_id,document_kind)
    values(v_user,v_request.id,p_application_id,v_kind);
  end loop;

  return jsonb_build_object('request_id',v_request.id,'state',v_request.state,'idempotent',false);
end;
$$;

revoke all on function public.create_application_document_generation(uuid,uuid,text[],text,jsonb,text,jsonb,boolean) from public,anon,service_role;
grant execute on function public.create_application_document_generation(uuid,uuid,text[],text,jsonb,text,jsonb,boolean) to authenticated;

create or replace function public.record_application_document_dispatch(
  p_request_id uuid, p_expected_chunk integer, p_dispatch_id uuid
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_request public.document_generation_requests;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_request from public.document_generation_requests
   where id=p_request_id and user_id=v_user for update;
  if not found then raise exception 'Document request not found'; end if;
  if v_request.current_chunk<>p_expected_chunk then return v_request.dispatch_id=p_dispatch_id; end if;
  if v_request.dispatch_id is not null then return v_request.dispatch_id=p_dispatch_id; end if;
  update public.document_generation_requests set dispatch_id=p_dispatch_id,state='writing',updated_at=now()
   where id=p_request_id and user_id=v_user;
  return true;
end;
$$;
revoke all on function public.record_application_document_dispatch(uuid,integer,uuid) from public,anon,service_role;
grant execute on function public.record_application_document_dispatch(uuid,integer,uuid) to authenticated;

create or replace function public.capture_application_document_context(
  p_request_id uuid, p_expected_chunk integer, p_dispatch_id uuid, p_response_text text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_request public.document_generation_requests; v_chunks integer;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if length(coalesce(p_response_text,''))>20000 then raise exception 'Context acknowledgement exceeded the allowed size'; end if;
  select * into v_request from public.document_generation_requests
   where id=p_request_id and user_id=v_user for update;
  if not found then raise exception 'Document request not found'; end if;
  if v_request.current_chunk<>p_expected_chunk or v_request.dispatch_id<>p_dispatch_id then
    if v_request.last_completed_dispatch_id=p_dispatch_id then return jsonb_build_object('captured',true,'idempotent',true,'next_chunk',v_request.current_chunk); end if;
    raise exception 'Document context step changed; refresh the request';
  end if;
  if coalesce(v_request.context_chunks->p_expected_chunk->>'kind','') not in ('context','final') then
    raise exception 'Document context step metadata is invalid';
  end if;
  v_chunks:=jsonb_array_length(v_request.context_chunks);
  update public.document_generation_requests
     set current_chunk=current_chunk+1,dispatch_id=null,response_text=null,
         last_completed_dispatch_id=p_dispatch_id,
         state=case when current_chunk+1>=v_chunks then 'validating' else 'preparing_context' end,
         updated_at=now()
   where id=p_request_id and user_id=v_user;
  return jsonb_build_object('captured',true,'idempotent',false,'next_chunk',p_expected_chunk+1,'total_chunks',v_chunks);
end;
$$;
revoke all on function public.capture_application_document_context(uuid,integer,uuid,text) from public,anon,service_role;
grant execute on function public.capture_application_document_context(uuid,integer,uuid,text) to authenticated;

create or replace function public.record_application_document_response(
  p_request_id uuid, p_item_id uuid, p_dispatch_id uuid, p_response_hash text, p_response_text text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_request public.document_generation_requests;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if coalesce(p_response_hash,'') !~ '^[0-9a-f]{64}$' or length(coalesce(p_response_text,''))>300000 then raise exception 'Document response is invalid or too large'; end if;
  select * into v_request from public.document_generation_requests r
   where r.id=p_request_id and r.user_id=v_user for update;
  if not found then raise exception 'Document request not found'; end if;
  if v_request.dispatch_id is distinct from p_dispatch_id or v_request.current_chunk<jsonb_array_length(v_request.context_chunks)
     or v_request.context_chunks->(v_request.current_chunk-1)->>'kind' <> 'final' then
    raise exception 'Document response does not match the active final turn';
  end if;
  update public.document_generation_items i set response_hash=p_response_hash,response_text=p_response_text,
      state='validating',updated_at=now()
    where i.id=p_item_id and i.request_id=p_request_id and i.user_id=v_user and i.document_kind=v_request.current_kind
      and (i.response_hash is null or i.response_hash=p_response_hash);
  if not found then raise exception 'Document response conflicted with an existing captured result'; end if;
  update public.document_generation_requests set state='validating',response_text=p_response_text,updated_at=now()
   where id=p_request_id and user_id=v_user;
  return true;
end;
$$;
revoke all on function public.record_application_document_response(uuid,uuid,uuid,text,text) from public,anon,service_role;
grant execute on function public.record_application_document_response(uuid,uuid,uuid,text,text) to authenticated;

create or replace function public.create_application_cover_letter_version(
  p_application_id uuid, p_structured_content jsonb, p_engine text default 'chatgpt-bridge-v1'
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_user uuid := (select auth.uid()); v_app public.applications; v_profile_id uuid;
  v_document public.documents; v_version public.document_versions; v_number integer;
  v_paragraph jsonb; v_key text; v_evidence text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.preparation_origin<>'manual' or v_app.state not in ('preparing','ready_for_review','revision_requested') then
    raise exception 'Choose to apply and keep the application open before generating documents';
  end if;
  if jsonb_typeof(p_structured_content)<>'object' or jsonb_typeof(p_structured_content->'paragraphs')<>'array'
     or jsonb_array_length(p_structured_content->'paragraphs')<3 or jsonb_array_length(p_structured_content->'paragraphs')>8
     or jsonb_array_length(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb))>0 then
    raise exception 'Cover letter content did not pass structural validation';
  end if;
  select id into v_profile_id from public.candidate_profiles where user_id=v_user;
  if v_profile_id is null then raise exception 'Candidate profile not found'; end if;
  for v_paragraph in select value from jsonb_array_elements(p_structured_content->'paragraphs') loop
    if coalesce((v_paragraph->>'material')::boolean,false) then
      v_key:=v_paragraph->>'paragraph_key';
      if v_key is null or jsonb_array_length(coalesce(v_paragraph->'evidence_ids','[]'::jsonb))=0 then raise exception 'A material paragraph has no evidence'; end if;
      for v_evidence in select jsonb_array_elements_text(v_paragraph->'evidence_ids') loop
        if not exists(select 1 from public.evidence_items e where e.id=v_evidence::uuid and e.profile_id=v_profile_id and e.verification_status='verified') then
          raise exception 'Cover letter references unverified evidence';
        end if;
      end loop;
    end if;
  end loop;

  select * into v_document from public.documents where application_id=p_application_id and kind='cover_letter' for update;
  if not found then insert into public.documents(application_id,kind,title) values(p_application_id,'cover_letter','Tailored Cover Letter') returning * into v_document; end if;
  select coalesce(max(version_number),0)+1 into v_number from public.document_versions where document_id=v_document.id;
  insert into public.document_versions(document_id,version_number,structured_content,model,prompt_version,change_summary,approval_status)
  values(v_document.id,v_number,p_structured_content,p_engine,coalesce(p_structured_content->>'contract_version','1.0.0'),
    coalesce(p_structured_content->'change_summary','[]'::jsonb),'needs_review') returning * into v_version;
  for v_paragraph in select value from jsonb_array_elements(p_structured_content->'paragraphs') loop
    if coalesce((v_paragraph->>'material')::boolean,false) then
      for v_evidence in select jsonb_array_elements_text(v_paragraph->'evidence_ids') loop
        insert into public.document_evidence_links(document_version_id,evidence_item_id,claim_key)
        values(v_version.id,v_evidence::uuid,v_paragraph->>'paragraph_key') on conflict do nothing;
      end loop;
    end if;
  end loop;
  update public.automation_tasks set state='completed',updated_at=now(),last_error=null,
    output_json=jsonb_build_object('document_id',v_document.id,'document_version_id',v_version.id,'engine',p_engine)
   where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_cover_letter';
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'system','document-generation','document.cover_letter_version_created','document_version',v_version.id,
    jsonb_build_object('application_id',p_application_id,'document_id',v_document.id,'version_number',v_number,'engine',p_engine));
  return jsonb_build_object('document_id',v_document.id,'document_version_id',v_version.id,'version_number',v_number,'approval_status','needs_review');
end;
$$;
revoke all on function public.create_application_cover_letter_version(uuid,jsonb,text) from public,anon,service_role;
grant execute on function public.create_application_cover_letter_version(uuid,jsonb,text) to authenticated;

create or replace function public.finalize_application_document_item(
  p_item_id uuid, p_version_id uuid, p_pdf_key text, p_docx_key text,
  p_pdf_sha256 text, p_docx_sha256 text, p_plaintext text, p_structured_content jsonb, p_quality_report jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_item public.document_generation_items;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document not found'; end if;
  if split_part(p_pdf_key,'/',1)<>v_user::text or split_part(p_docx_key,'/',1)<>v_user::text
     or p_pdf_key not like v_user::text||'/'||v_item.application_id::text||'/'||p_version_id::text||'/%'
     or p_docx_key not like v_user::text||'/'||v_item.application_id::text||'/'||p_version_id::text||'/%'
     or coalesce(p_pdf_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_docx_sha256,'') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_quality_report)<>'object' or jsonb_typeof(p_structured_content)<>'object' then
    raise exception 'Generated document assets did not pass ownership or integrity validation';
  end if;
  if not exists(select 1 from public.documents d join public.document_versions dv on dv.document_id=d.id
    where d.application_id=v_item.application_id and d.kind=v_item.document_kind and dv.id=p_version_id) then
    raise exception 'Document version does not belong to this application';
  end if;
  update public.document_generation_items set state='ready',document_version_id=p_version_id,
    pdf_object_key=p_pdf_key,docx_object_key=p_docx_key,pdf_sha256=p_pdf_sha256,docx_sha256=p_docx_sha256,
    plaintext=p_plaintext,structured_content=p_structured_content,quality_report=p_quality_report,
    updated_at=now() where id=p_item_id and user_id=v_user;
  update public.document_generation_requests r set
    state=case when not exists(select 1 from public.document_generation_items x where x.request_id=r.id and x.state<>'ready') then 'ready'
      when exists(select 1 from public.document_generation_items x where x.request_id=r.id and x.state='failed') then 'partial'
      else r.state end,
    updated_at=now()
   where r.id=v_item.request_id and r.user_id=v_user;
  return jsonb_build_object('ready',true,'document_version_id',p_version_id);
end;
$$;
revoke all on function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) from public,anon,service_role;
grant execute on function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('application-documents','application-documents',false,10485760,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/webp'])
on conflict(id) do update set file_size_limit=greatest(storage.buckets.file_size_limit,excluded.file_size_limit),
  allowed_mime_types=(select array_agg(distinct allowed_type) from unnest(storage.buckets.allowed_mime_types || excluded.allowed_mime_types) allowed_type);
