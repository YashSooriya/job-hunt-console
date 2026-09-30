-- Idempotent document generation lifecycle, immutable response-to-version link,
-- and per-application Drive folder tracking. All user-facing RPCs remain
-- SECURITY INVOKER and owner-scoped by auth.uid()/RLS.

alter table public.document_generation_requests
  add column if not exists completed_at timestamptz,
  add column if not exists drive_error_code text;

alter table public.document_generation_items
  add column if not exists drive_error_code text;
alter table public.document_generation_items drop constraint if exists document_generation_items_drive_state_check;
alter table public.document_generation_items add constraint document_generation_items_drive_state_check
  check (drive_state in ('pending','ready','retrying','needs_reconnect','not_configured','failed'));

create unique index document_generation_one_active_per_application
  on public.document_generation_requests(user_id,application_id)
  where state in ('queued','preparing_context','writing','validating','rendering','saving_drive');

create table public.document_application_drive_folders (
  user_id uuid not null references auth.users(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  folder_id text not null,
  folder_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, application_id),
  unique (folder_id)
);
alter table public.document_application_drive_folders enable row level security;
revoke all on public.document_application_drive_folders from public,anon,authenticated,service_role;
create policy document_application_drive_folders_owner on public.document_application_drive_folders
  for all to authenticated using (user_id=(select auth.uid()) and private.current_user_active_member())
  with check (user_id=(select auth.uid()) and private.current_user_active_member()
    and exists(select 1 from public.applications a where a.id=application_id and a.user_id=(select auth.uid())));
grant select,insert,update on public.document_application_drive_folders to authenticated;

create or replace function public.create_application_document_generation(
  p_application_id uuid,p_request_key uuid,p_requested_kinds text[],p_template_id text,
  p_input_snapshot jsonb,p_input_hash text,p_context_chunks jsonb,p_testing_mode boolean default false
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_application public.applications;
  v_request public.document_generation_requests;
  v_active_request public.document_generation_requests;
  v_kind text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_request_key is null or p_application_id is null then raise exception 'A valid application and request key are required'; end if;
  if p_template_id not in ('classic-navy','clean-charcoal','technical-slate','research-classic','modern-teal','engineering-blue','quiet-olive','minimal-black') then raise exception 'Choose a valid document theme'; end if;
  if p_requested_kinds is null or cardinality(p_requested_kinds) not between 1 and 2
    or exists(select 1 from unnest(p_requested_kinds) k where k not in ('cv','cover_letter'))
    or (select count(distinct k) from unnest(p_requested_kinds) k)<>cardinality(p_requested_kinds) then
    raise exception 'Choose a CV, cover letter, or both';
  end if;
  if coalesce(p_input_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input_snapshot)<>'object'
    or jsonb_typeof(p_context_chunks)<>'array' or jsonb_array_length(p_context_chunks)=0
    or octet_length(p_input_snapshot::text)>1000000 or octet_length(p_context_chunks::text)>1000000 then
    raise exception 'Document generation context is incomplete or too large';
  end if;
  if exists(select 1 from jsonb_array_elements(p_context_chunks) x
    where coalesce(x->>'kind','') not in ('cv','cover_letter')
      or coalesce(x->>'phase','') not in ('context','final')
      or coalesce(x->>'text','')=''
      or length(x->>'text')>5600
      or coalesce(x->>'sha256','') !~ '^[0-9a-f]{64}$') then
    raise exception 'Document context contains an invalid or oversized Website Bridge step';
  end if;
  select * into v_application from public.applications a
    where a.id=p_application_id and a.user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_application.preparation_origin is distinct from 'manual' then raise exception 'Choose to apply to this job before requesting custom documents'; end if;
  if v_application.state not in ('preparing','ready_for_review','revision_requested') then raise exception 'Documents cannot be generated after application review has been locked'; end if;

  select * into v_request from public.document_generation_requests r where r.user_id=v_user and r.request_key=p_request_key;
  if found then
    if v_request.application_id is distinct from p_application_id
      or v_request.requested_kinds is distinct from p_requested_kinds
      or v_request.template_id is distinct from p_template_id
      or v_request.input_hash is distinct from p_input_hash then
      raise exception 'Request id was already used for different document inputs';
    end if;
    return jsonb_build_object('request_id',v_request.id,'state',v_request.state,'idempotent',true);
  end if;

  -- Serialize requests through the owned application row above and reject a
  -- second tab/request while this application's current one is still active.
  select * into v_active_request from public.document_generation_requests r
    where r.user_id=v_user and r.application_id=p_application_id
      and r.state in ('queued','preparing_context','writing','validating','rendering','saving_drive')
    order by r.created_at desc limit 1;
  if found then raise exception 'A document request is already in progress for this application. Resume it before starting another.'; end if;

  insert into public.document_generation_requests(
    user_id,application_id,request_key,requested_kinds,template_id,input_snapshot,input_hash,context_chunks,testing_mode,
    state,current_kind
  ) values (
    v_user,p_application_id,p_request_key,p_requested_kinds,p_template_id,p_input_snapshot,p_input_hash,p_context_chunks,coalesce(p_testing_mode,false),
    'preparing_context',p_context_chunks->0->>'kind'
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

create or replace function public.record_application_document_dispatch(p_request_id uuid,p_expected_chunk integer,p_dispatch_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_request public.document_generation_requests; v_step jsonb;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_request from public.document_generation_requests where id=p_request_id and user_id=v_user for update;
  if not found then raise exception 'Document request not found'; end if;
  if v_request.current_chunk<>p_expected_chunk then return v_request.dispatch_id=p_dispatch_id; end if;
  if v_request.dispatch_id is not null then return v_request.dispatch_id=p_dispatch_id; end if;
  v_step:=v_request.context_chunks->p_expected_chunk;
  if v_step is null or p_dispatch_id is null then raise exception 'No document-generation step is ready'; end if;
  update public.document_generation_requests set dispatch_id=p_dispatch_id,current_kind=v_step->>'kind',
    state=case when v_step->>'phase'='final' then 'writing' else 'preparing_context' end,
    updated_at=now() where id=p_request_id and user_id=v_user;
  update public.document_generation_items set state=case when v_step->>'phase'='final' then 'writing' else 'preparing_context' end,updated_at=now()
    where request_id=p_request_id and document_kind=v_step->>'kind' and user_id=v_user and state not in ('ready','failed','cancelled');
  return true;
end;
$$;
revoke all on function public.record_application_document_dispatch(uuid,integer,uuid) from public,anon,service_role;
grant execute on function public.record_application_document_dispatch(uuid,integer,uuid) to authenticated;

create or replace function public.capture_application_document_context(p_request_id uuid,p_expected_chunk integer,p_dispatch_id uuid,p_response_text text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_request public.document_generation_requests; v_total integer; v_next integer;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_request from public.document_generation_requests where id=p_request_id and user_id=v_user for update;
  if not found then raise exception 'Document request not found'; end if;
  if v_request.current_chunk<>p_expected_chunk or v_request.dispatch_id is distinct from p_dispatch_id then
    if v_request.last_completed_dispatch_id=p_dispatch_id then return jsonb_build_object('captured',true,'idempotent',true,'next_chunk',v_request.current_chunk); end if;
    raise exception 'Document context step changed; refresh the request';
  end if;
  if v_request.context_chunks->p_expected_chunk->>'phase'<>'context' then raise exception 'The active document step is not a context acknowledgement'; end if;
  if length(coalesce(p_response_text,''))>20000 or lower(btrim(coalesce(p_response_text,''))) !~ '^context received[!. ]*$' then
    raise exception 'ChatGPT did not return the required context acknowledgement. No document was created.';
  end if;
  v_total:=jsonb_array_length(v_request.context_chunks); v_next:=p_expected_chunk+1;
  update public.document_generation_requests set current_chunk=v_next,dispatch_id=null,response_text=null,last_completed_dispatch_id=p_dispatch_id,
    current_kind=case when v_next<v_total then context_chunks->v_next->>'kind' else null end,
    state=case when v_next>=v_total then 'validating' else 'preparing_context' end,updated_at=now()
    where id=p_request_id and user_id=v_user;
  return jsonb_build_object('captured',true,'idempotent',false,'next_chunk',v_next,'total_chunks',v_total);
end;
$$;
revoke all on function public.capture_application_document_context(uuid,integer,uuid,text) from public,anon,service_role;
grant execute on function public.capture_application_document_context(uuid,integer,uuid,text) to authenticated;

create or replace function public.record_application_document_response(p_request_id uuid,p_item_id uuid,p_dispatch_id uuid,p_response_hash text,p_response_text text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_request public.document_generation_requests; v_item public.document_generation_items;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if coalesce(p_response_hash,'') !~ '^[0-9a-f]{64}$' or length(coalesce(p_response_text,''))>300000 then raise exception 'Document response is invalid or too large'; end if;
  select * into v_request from public.document_generation_requests where id=p_request_id and user_id=v_user for update;
  if not found then raise exception 'Document request not found'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and request_id=p_request_id and user_id=v_user for update;
  if not found then raise exception 'Document item not found'; end if;
  if v_item.response_hash is not null then
    if v_item.response_hash<>p_response_hash then raise exception 'A different response is already stored for this document'; end if;
    return true;
  end if;
  if v_request.dispatch_id is distinct from p_dispatch_id or v_request.current_chunk>=jsonb_array_length(v_request.context_chunks)
    or v_request.context_chunks->v_request.current_chunk->>'phase'<>'final'
    or v_request.context_chunks->v_request.current_chunk->>'kind' is distinct from v_item.document_kind then
    raise exception 'Document response does not match the active final turn';
  end if;
  update public.document_generation_items set response_hash=p_response_hash,response_text=p_response_text,state='validating',updated_at=now()
    where id=p_item_id and user_id=v_user;
  update public.document_generation_requests set state='validating',response_text=p_response_text,updated_at=now() where id=p_request_id and user_id=v_user;
  return true;
end;
$$;
revoke all on function public.record_application_document_response(uuid,uuid,uuid,text,text) from public,anon,service_role;
grant execute on function public.record_application_document_response(uuid,uuid,uuid,text,text) to authenticated;

-- Create the document version and persist its id on the generation item in the
-- same transaction. A retry after an interrupted storage upload cannot create
-- a second version or resend the original ChatGPT turn.
create or replace function public.create_application_document_version(
  p_item_id uuid,p_structured_content jsonb,p_evidence_links jsonb,p_plaintext text,p_quality_report jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid()); v_item public.document_generation_items; v_request public.document_generation_requests;
  v_result jsonb; v_version_id uuid; v_version_number integer; v_cv_family text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document item not found'; end if;
  if v_item.document_version_id is not null then
    return jsonb_build_object('document_version_id',v_item.document_version_id,'version_number',v_item.version_number,'idempotent',true);
  end if;
  if v_item.response_hash is null or v_item.state not in ('validating','rendering','saving_drive') then raise exception 'A captured document response is required'; end if;
  if jsonb_typeof(p_structured_content)<>'object' or jsonb_typeof(p_quality_report)<>'object'
    or length(coalesce(p_plaintext,''))>300000 or jsonb_array_length(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb))>0 then
    raise exception 'Document did not pass structural or evidence validation';
  end if;
  select * into v_request from public.document_generation_requests where id=v_item.request_id and user_id=v_user for update;
  if not found or v_request.application_id<>v_item.application_id then raise exception 'Document generation request does not match its item'; end if;
  if v_request.testing_mode and v_item.response_text not ilike '%"document_kind"%' then raise exception 'Test-mode response cannot be saved as an application document'; end if;

  if v_item.document_kind='cv' then
    v_result:=public.create_cv_document_version(v_item.application_id,p_structured_content,'%% JobHuntAI PDF/DOCX rendered from validated structured content',p_evidence_links,'chatgpt-bridge-docx-v1');
  else
    v_result:=public.create_application_cover_letter_version(v_item.application_id,p_structured_content,'chatgpt-bridge-docx-v1');
  end if;
  v_version_id:=(v_result->>'document_version_id')::uuid;
  v_version_number:=(v_result->>'version_number')::integer;
  if v_version_id is null or v_version_number is null then raise exception 'Document version persistence returned no version id'; end if;
  update public.document_generation_items set document_version_id=v_version_id,version_number=v_version_number,
    structured_content=p_structured_content,plaintext=nullif(p_plaintext,''),quality_report=p_quality_report,state='rendering',updated_at=now()
    where id=p_item_id and user_id=v_user;
  update public.document_generation_requests set state='rendering',updated_at=now() where id=v_request.id and user_id=v_user;
  return v_result||jsonb_build_object('idempotent',false);
end;
$$;
revoke all on function public.create_application_document_version(uuid,jsonb,jsonb,text,jsonb) from public,anon,service_role;
grant execute on function public.create_application_document_version(uuid,jsonb,jsonb,text,jsonb) to authenticated;

create or replace function public.finalize_application_document_item(
  p_item_id uuid,p_version_id uuid,p_pdf_key text,p_docx_key text,p_pdf_sha256 text,p_docx_sha256 text,
  p_plaintext text,p_structured_content jsonb,p_quality_report jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_item public.document_generation_items; v_request public.document_generation_requests; v_next integer; v_total integer;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document not found'; end if;
  if v_item.state='ready' then
    if v_item.document_version_id=p_version_id and v_item.pdf_sha256=p_pdf_sha256 and v_item.docx_sha256=p_docx_sha256 then
      return jsonb_build_object('ready',true,'idempotent',true,'document_version_id',p_version_id);
    end if;
    raise exception 'A different rendered document is already finalised';
  end if;
  if v_item.document_version_id is distinct from p_version_id then raise exception 'Document version does not match the captured response'; end if;
  if split_part(p_pdf_key,'/',1)<>v_user::text or split_part(p_docx_key,'/',1)<>v_user::text
    or p_pdf_key<>v_user::text||'/'||v_item.application_id::text||'/'||p_version_id::text||'/'||v_item.document_kind||'.pdf'
    or p_docx_key<>v_user::text||'/'||v_item.application_id::text||'/'||p_version_id::text||'/'||v_item.document_kind||'.docx'
    or coalesce(p_pdf_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_docx_sha256,'') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_quality_report)<>'object' or jsonb_typeof(p_structured_content)<>'object' then
    raise exception 'Generated document assets did not pass ownership or integrity validation';
  end if;
  if not exists(select 1 from public.documents d join public.document_versions dv on dv.document_id=d.id
    where d.application_id=v_item.application_id and d.kind=v_item.document_kind and dv.id=p_version_id) then
    raise exception 'Document version does not belong to this application';
  end if;
  update public.document_versions set rendered_object_key=p_pdf_key where id=p_version_id;
  update public.document_generation_items set state='ready',pdf_object_key=p_pdf_key,docx_object_key=p_docx_key,
    pdf_sha256=p_pdf_sha256,docx_sha256=p_docx_sha256,plaintext=nullif(p_plaintext,''),
    structured_content=p_structured_content,quality_report=p_quality_report,updated_at=now()
    where id=p_item_id and user_id=v_user;
  select * into v_request from public.document_generation_requests where id=v_item.request_id and user_id=v_user for update;
  if not found then raise exception 'Document generation request not found'; end if;
  v_next:=v_request.current_chunk+1; v_total:=jsonb_array_length(v_request.context_chunks);
  update public.document_generation_requests set current_chunk=v_next,dispatch_id=null,response_text=null,last_completed_dispatch_id=v_request.dispatch_id,
    current_kind=case when v_next<v_total then context_chunks->v_next->>'kind' else null end,
    state=case when v_next>=v_total then 'ready' else 'preparing_context' end,
    completed_at=case when v_next>=v_total then now() else null end,updated_at=now()
    where id=v_request.id and user_id=v_user;
  return jsonb_build_object('ready',true,'idempotent',false,'document_version_id',p_version_id,
    'next_chunk',v_next,'total_chunks',v_total,'request_state',case when v_next>=v_total then 'ready' else 'preparing_context' end);
end;
$$;
revoke all on function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) from public,anon,service_role;
grant execute on function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) to authenticated;

create or replace function public.set_application_document_generation_error(
  p_request_id uuid,p_item_id uuid,p_state text,p_error_code text,p_error_message text
)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_state text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_state not in ('needs_user','failed') then raise exception 'Invalid document-generation error state'; end if;
  if length(coalesce(p_error_code,''))>80 or length(coalesce(p_error_message,''))>1000 then raise exception 'Error details exceed their safe length'; end if;
  update public.document_generation_requests set state=p_state,error_code=nullif(p_error_code,''),error_message=nullif(p_error_message,''),updated_at=now()
    where id=p_request_id and user_id=v_user returning state into v_state;
  if not found then raise exception 'Document generation request not found'; end if;
  if p_item_id is not null then
    update public.document_generation_items set state=p_state,error_code=nullif(p_error_code,''),error_message=nullif(p_error_message,''),updated_at=now()
      where id=p_item_id and request_id=p_request_id and user_id=v_user;
  else
    update public.document_generation_items set state=p_state,error_code=nullif(p_error_code,''),error_message=nullif(p_error_message,''),updated_at=now()
      where request_id=p_request_id and user_id=v_user and state not in ('ready','failed','cancelled');
  end if;
  return true;
end;
$$;
revoke all on function public.set_application_document_generation_error(uuid,uuid,text,text,text) from public,anon,service_role;
grant execute on function public.set_application_document_generation_error(uuid,uuid,text,text,text) to authenticated;

create or replace function public.record_application_document_drive_state(
  p_item_id uuid,p_state text,p_folder_id text,p_pdf_id text,p_docx_id text,p_error_code text
)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_item public.document_generation_items;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_state not in ('pending','ready','retrying','needs_reconnect','not_configured','failed') then raise exception 'Invalid Drive publication state'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document item not found'; end if;
  if p_folder_id is not null and length(p_folder_id)>255 then raise exception 'Drive folder id is invalid'; end if;
  if p_pdf_id is not null and length(p_pdf_id)>255 then raise exception 'Drive PDF id is invalid'; end if;
  if p_docx_id is not null and length(p_docx_id)>255 then raise exception 'Drive DOCX id is invalid'; end if;
  update public.document_generation_items set drive_state=p_state,drive_folder_id=coalesce(p_folder_id,drive_folder_id),
    drive_pdf_id=coalesce(p_pdf_id,drive_pdf_id),drive_docx_id=coalesce(p_docx_id,drive_docx_id),
    drive_error_code=nullif(p_error_code,''),updated_at=now() where id=p_item_id and user_id=v_user;
  return true;
end;
$$;
revoke all on function public.record_application_document_drive_state(uuid,text,text,text,text,text) from public,anon,service_role;
grant execute on function public.record_application_document_drive_state(uuid,text,text,text,text,text) to authenticated;

-- A small live status function avoids shipping the full frozen input snapshot
-- back to the browser while allowing safe resume after refresh.
create or replace function public.get_application_document_generation(p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_request public.document_generation_requests; v_step jsonb; v_items jsonb;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_request from public.document_generation_requests where id=p_request_id and user_id=v_user;
  if not found then return null; end if;
  v_step:=v_request.context_chunks->v_request.current_chunk;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'kind',i.document_kind,'state',i.state,'version_id',i.document_version_id,'version_number',i.version_number,
    'pdf_object_key',i.pdf_object_key,'docx_object_key',i.docx_object_key,'plaintext',i.plaintext,'structured_content',i.structured_content,
    'quality_report',i.quality_report,'drive_state',i.drive_state,'drive_folder_id',i.drive_folder_id,'drive_pdf_id',i.drive_pdf_id,'drive_docx_id',i.drive_docx_id,
    'error_code',i.error_code,'error_message',i.error_message) order by i.created_at,i.document_kind),'[]'::jsonb)
    into v_items from public.document_generation_items i where i.request_id=v_request.id and i.user_id=v_user;
  return jsonb_build_object('id',v_request.id,'application_id',v_request.application_id,'requested_kinds',v_request.requested_kinds,
    'template_id',v_request.template_id,'input_hash',v_request.input_hash,
    'state',v_request.state,'current_kind',v_request.current_kind,'current_chunk',v_request.current_chunk,'dispatch_id',v_request.dispatch_id,
    'step',case when v_request.dispatch_id is null and v_step->>'phase' in ('context','final') then v_step else null end,
    'error_code',v_request.error_code,'error_message',v_request.error_message,'testing_mode',v_request.testing_mode,
    'created_at',v_request.created_at,'updated_at',v_request.updated_at,'completed_at',v_request.completed_at,'items',v_items);
end;
$$;
revoke all on function public.get_application_document_generation(uuid) from public,anon,service_role;
grant execute on function public.get_application_document_generation(uuid) to authenticated;

create or replace function public.record_application_document_drive_folder(p_application_id uuid,p_folder_id text,p_folder_url text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_row public.document_application_drive_folders;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if length(coalesce(p_folder_id,'')) not between 1 and 255 or p_folder_url not like 'https://drive.google.com/drive/folders/%' then raise exception 'Google Drive folder reference is invalid'; end if;
  insert into public.document_application_drive_folders(user_id,application_id,folder_id,folder_url)
    select v_user,a.id,p_folder_id,p_folder_url from public.applications a where a.id=p_application_id and a.user_id=v_user
  on conflict(user_id,application_id) do update set folder_id=excluded.folder_id,folder_url=excluded.folder_url,updated_at=now()
  returning * into v_row;
  if not found then raise exception 'Application not found'; end if;
  return jsonb_build_object('folder_id',v_row.folder_id,'folder_url',v_row.folder_url);
end;
$$;
revoke all on function public.record_application_document_drive_folder(uuid,text,text) from public,anon,service_role;
grant execute on function public.record_application_document_drive_folder(uuid,text,text) to authenticated;

comment on table public.document_application_drive_folders is 'Owner-scoped, idempotent Google Drive folder mapping for an application’s generated documents.';
