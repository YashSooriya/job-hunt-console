-- The document-version wrapper is the one privileged write boundary needed
-- to let the existing document creators record their system audit events.
-- Keep it owner-scoped, membership-checked, and behind the explicit apply
-- choice even when an authenticated caller invokes this RPC directly.
create or replace function public.create_application_document_version(
  p_item_id uuid,p_structured_content jsonb,p_evidence_links jsonb,p_plaintext text,p_quality_report jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_item public.document_generation_items;
  v_request public.document_generation_requests;
  v_application public.applications;
  v_result jsonb;
  v_version_id uuid;
  v_version_number integer;
  v_version_content jsonb;
  v_engine text;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  select * into v_item from public.document_generation_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'Document item not found'; end if;
  select * into v_request from public.document_generation_requests where id=v_item.request_id and user_id=v_user for update;
  if not found or v_request.application_id<>v_item.application_id then raise exception 'Document generation request does not match its item'; end if;
  select * into v_application from public.applications where id=v_request.application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_application.chosen_to_apply_at is null
    or v_application.state not in ('preparing','ready_for_review','revision_requested') then
    raise exception 'Choose to apply and keep the application open before generating documents';
  end if;
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
    v_result:=public.create_cv_document_version(v_item.application_id,v_version_content,
      '%% JobHuntAI PDF/DOCX rendered from validated structured content',p_evidence_links,v_engine);
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
