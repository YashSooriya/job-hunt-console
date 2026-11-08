-- M07 restores the version engine label for Memory-based drafts while keeping
-- the M06 theme identity, version idempotency, and existing content validators.
update public.document_versions
set model = 'chatgpt-memory-v4'
where submission_locked_at is null
  and structured_content->>'source_mode' = 'chatgpt_memory'
  and model is distinct from 'chatgpt-memory-v4';

create or replace function public.create_application_document_version(
  p_item_id uuid,p_structured_content jsonb,p_evidence_links jsonb,p_plaintext text,p_quality_report jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid()); v_item public.document_generation_items; v_request public.document_generation_requests;
  v_result jsonb; v_version_id uuid; v_version_number integer; v_version_content jsonb; v_engine text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document item not found'; end if;
  select * into v_request from public.document_generation_requests where id=v_item.request_id and user_id=v_user for update;
  if not found or v_request.application_id<>v_item.application_id then raise exception 'Document generation request does not match its item'; end if;
  if v_item.document_version_id is not null then
    return jsonb_build_object('document_version_id',v_item.document_version_id,'version_number',v_item.version_number,
      'template_id',v_request.template_id,'idempotent',true);
  end if;
  if v_item.response_hash is null or v_item.state not in ('validating','rendering','saving_drive') then raise exception 'A captured document response is required'; end if;
  if jsonb_typeof(p_structured_content)<>'object' or jsonb_typeof(p_quality_report)<>'object'
    or length(coalesce(p_plaintext,''))>300000 or jsonb_array_length(coalesce(p_structured_content->'unsupported_claims','[]'::jsonb))>0 then
    raise exception 'Document did not pass structural or evidence validation';
  end if;
  if v_request.testing_mode and v_item.response_text not ilike '%"document_kind"%' then raise exception 'Test-mode response cannot be saved as an application document'; end if;

  -- The request is authoritative for the frozen M06 theme. Preserve the
  -- existing evidence or Memory-only validator in the document-version RPCs.
  v_version_content := jsonb_set(p_structured_content,'{document_template_id}',to_jsonb(v_request.template_id),true);
  -- Keep the exact, locally rendered text on the durable version. The UI's
  -- Copy action and downloads can then read one immutable saved version.
  v_version_content := jsonb_set(v_version_content,'{plaintext}',to_jsonb(coalesce(p_plaintext,'')),true);
  v_engine := case when v_version_content->>'source_mode'='chatgpt_memory' then 'chatgpt-memory-v4' else 'chatgpt-bridge-docx-v1' end;
  if v_item.document_kind='cv' then
    v_result:=public.create_cv_document_version(v_item.application_id,v_version_content,'%% JobHuntAI PDF/DOCX rendered from validated structured content',p_evidence_links,v_engine);
  else
    v_result:=public.create_application_cover_letter_version(v_item.application_id,v_version_content,v_engine);
  end if;
  v_version_id:=(v_result->>'document_version_id')::uuid;
  v_version_number:=(v_result->>'version_number')::integer;
  if v_version_id is null or v_version_number is null then raise exception 'Document version persistence returned no version id'; end if;
  update public.document_generation_items set document_version_id=v_version_id,version_number=v_version_number,
    structured_content=v_version_content,plaintext=nullif(p_plaintext,''),quality_report=p_quality_report,state='rendering',updated_at=now()
    where id=p_item_id and user_id=v_user;
  update public.document_generation_requests set state='rendering',updated_at=now() where id=v_request.id and user_id=v_user;
  return v_result||jsonb_build_object('idempotent',false,'template_id',v_request.template_id);
end;
$$;
revoke all on function public.create_application_document_version(uuid,jsonb,jsonb,text,jsonb) from public,anon,service_role;
grant execute on function public.create_application_document_version(uuid,jsonb,jsonb,text,jsonb) to authenticated;

-- Expose the durable version payload for preview/copy after refresh. Retain
-- the item fields as a fallback for M06 versions created before plaintext was
-- embedded in structured_content.
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
    'pdf_object_key',i.pdf_object_key,'docx_object_key',i.docx_object_key,
    'plaintext',coalesce(dv.structured_content->>'plaintext',i.plaintext),
    'structured_content',coalesce(dv.structured_content,i.structured_content),
    'quality_report',i.quality_report,'drive_state',i.drive_state,'drive_folder_id',i.drive_folder_id,'drive_pdf_id',i.drive_pdf_id,'drive_docx_id',i.drive_docx_id,
    'error_code',i.error_code,'error_message',i.error_message) order by i.created_at,i.document_kind),'[]'::jsonb)
    into v_items from public.document_generation_items i
    left join public.document_versions dv on dv.id=i.document_version_id
    where i.request_id=v_request.id and i.user_id=v_user;
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

-- Drive API calls cross a network boundary, so a database transaction cannot
-- hold the application row lock for their duration. This short owner-scoped
-- lease serializes all item publishes for one application across app workers.
create table private.document_drive_publish_leases (
  user_id uuid not null references auth.users(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  claim_token uuid not null,
  claimed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  primary key (user_id, application_id),
  check (lease_expires_at > claimed_at)
);
revoke all on private.document_drive_publish_leases from public,anon,authenticated,service_role;

create or replace function public.claim_application_document_drive_publish(p_item_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_item public.document_generation_items;
  v_lease private.document_drive_publish_leases;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_claim_token is null then raise exception 'A Drive publication claim token is required'; end if;
  select * into v_item from public.document_generation_items
    where id=p_item_id and user_id=v_user and state='ready' for update;
  if not found then raise exception 'Generated document not found'; end if;

  insert into private.document_drive_publish_leases(user_id,application_id,claim_token,claimed_at,lease_expires_at)
    values(v_user,v_item.application_id,p_claim_token,now(),now()+interval '15 minutes')
  on conflict(user_id,application_id) do update
    set claim_token=excluded.claim_token,claimed_at=excluded.claimed_at,lease_expires_at=excluded.lease_expires_at
    where private.document_drive_publish_leases.lease_expires_at<=now()
  returning * into v_lease;
  if not found then
    return jsonb_build_object('claimed',false,'state','retrying');
  end if;

  update public.document_generation_items set drive_state='retrying',drive_error_code=null,updated_at=now()
    where id=p_item_id and user_id=v_user;
  return jsonb_build_object('claimed',true,'state','retrying','folder_id',v_item.drive_folder_id,
    'pdf_id',v_item.drive_pdf_id,'docx_id',v_item.drive_docx_id);
end;
$$;
revoke all on function public.claim_application_document_drive_publish(uuid,uuid) from public,anon,service_role;
grant execute on function public.claim_application_document_drive_publish(uuid,uuid) to authenticated;

create or replace function public.finish_application_document_drive_publish(
  p_item_id uuid,p_claim_token uuid,p_state text,p_folder_id text,p_pdf_id text,p_docx_id text,p_error_code text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_item public.document_generation_items;
  v_folder text; v_pdf text; v_docx text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_state not in ('ready','needs_reconnect','not_configured','failed') then raise exception 'Invalid final Drive publication state'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document item not found'; end if;
  perform 1 from private.document_drive_publish_leases
    where user_id=v_user and application_id=v_item.application_id and claim_token=p_claim_token for update;
  if not found then raise exception 'Drive publication claim expired or belongs to another attempt'; end if;
  if p_folder_id is not null and length(p_folder_id)>255 then raise exception 'Drive folder id is invalid'; end if;
  if p_pdf_id is not null and length(p_pdf_id)>255 then raise exception 'Drive PDF id is invalid'; end if;
  if p_docx_id is not null and length(p_docx_id)>255 then raise exception 'Drive DOCX id is invalid'; end if;
  if (v_item.drive_folder_id is not null and p_folder_id is not null and v_item.drive_folder_id<>p_folder_id)
    or (v_item.drive_pdf_id is not null and p_pdf_id is not null and v_item.drive_pdf_id<>p_pdf_id)
    or (v_item.drive_docx_id is not null and p_docx_id is not null and v_item.drive_docx_id<>p_docx_id) then
    raise exception 'A Drive retry cannot replace a previously saved folder or file identity';
  end if;
  v_folder:=coalesce(p_folder_id,v_item.drive_folder_id);
  v_pdf:=coalesce(p_pdf_id,v_item.drive_pdf_id);
  v_docx:=coalesce(p_docx_id,v_item.drive_docx_id);
  if p_state='ready' and (coalesce(v_folder,'')='' or coalesce(v_pdf,'')='' or coalesce(v_docx,'')='') then
    raise exception 'Drive publication is missing a folder or document file';
  end if;
  update public.document_generation_items set drive_state=p_state,drive_folder_id=v_folder,
    drive_pdf_id=v_pdf,drive_docx_id=v_docx,drive_error_code=nullif(p_error_code,''),updated_at=now()
    where id=p_item_id and user_id=v_user;
  delete from private.document_drive_publish_leases where user_id=v_user and application_id=v_item.application_id and claim_token=p_claim_token;
  return true;
end;
$$;
revoke all on function public.finish_application_document_drive_publish(uuid,uuid,text,text,text,text,text) from public,anon,service_role;
grant execute on function public.finish_application_document_drive_publish(uuid,uuid,text,text,text,text,text) to authenticated;
