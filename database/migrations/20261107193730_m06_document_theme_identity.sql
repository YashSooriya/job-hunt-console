-- Recover theme identity for existing saved versions where the durable
-- generation request still records the selected theme. Never touch submitted
-- versions, whose content is immutable by the existing Gate 1 boundary.
update public.document_versions dv
set structured_content = jsonb_set(
  coalesce(dv.structured_content, '{}'::jsonb),
  '{document_template_id}',
  to_jsonb(r.template_id),
  true
)
from public.document_generation_items i
join public.document_generation_requests r on r.id = i.request_id and r.user_id = i.user_id
where i.document_version_id = dv.id
  and dv.submission_locked_at is null
  and dv.structured_content->>'document_template_id' is distinct from r.template_id;

-- The request is authoritative for both new and resumed version persistence.
-- Embed its theme id into the saved version payload so history retains the
-- exact renderer choice even after the application default changes.
create or replace function public.create_application_document_version(
  p_item_id uuid,p_structured_content jsonb,p_evidence_links jsonb,p_plaintext text,p_quality_report jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid()); v_item public.document_generation_items; v_request public.document_generation_requests;
  v_result jsonb; v_version_id uuid; v_version_number integer; v_version_content jsonb;
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

  v_version_content := jsonb_set(p_structured_content,'{document_template_id}',to_jsonb(v_request.template_id),true);
  if v_item.document_kind='cv' then
    v_result:=public.create_cv_document_version(v_item.application_id,v_version_content,'%% JobHuntAI PDF/DOCX rendered from validated structured content',p_evidence_links,'chatgpt-bridge-docx-v1');
  else
    v_result:=public.create_application_cover_letter_version(v_item.application_id,v_version_content,'chatgpt-bridge-docx-v1');
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
