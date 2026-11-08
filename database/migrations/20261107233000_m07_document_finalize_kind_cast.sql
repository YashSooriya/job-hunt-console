-- The generation item stores document_kind as text while documents.kind is
-- the public.document_kind enum. Compare through text during finalization so
-- retrying persisted documents does not fail on the enum/text operator.
create or replace function public.finalize_application_document_item(
  p_item_id uuid,p_version_id uuid,p_pdf_key text,p_docx_key text,p_pdf_sha256 text,p_docx_sha256 text,
  p_plaintext text,p_structured_content jsonb,p_quality_report jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_item public.document_generation_items;
  v_request public.document_generation_requests;
  v_next integer;
  v_total integer;
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
    where d.application_id=v_item.application_id and d.kind::text=v_item.document_kind and dv.id=p_version_id) then
    raise exception 'Document version does not belong to this application';
  end if;
  update public.document_versions set rendered_object_key=p_pdf_key where id=p_version_id;
  update public.document_generation_items set state='ready',pdf_object_key=p_pdf_key,docx_object_key=p_docx_key,
    pdf_sha256=p_pdf_sha256,docx_sha256=p_docx_sha256,plaintext=nullif(p_plaintext,''),
    structured_content=p_structured_content,quality_report=p_quality_report,updated_at=now()
    where id=p_item_id and user_id=v_user;
  select * into v_request from public.document_generation_requests where id=v_item.request_id and user_id=v_user for update;
  if not found then raise exception 'Document generation request not found'; end if;
  v_next:=v_request.current_chunk+1;
  v_total:=jsonb_array_length(v_request.context_chunks);
  update public.document_generation_requests set current_chunk=v_next,dispatch_id=null,response_text=null,
    last_completed_dispatch_id=v_request.dispatch_id,
    current_kind=case when v_next<v_total then context_chunks->v_next->>'kind' else null end,
    state=case when v_next>=v_total then 'ready' else 'preparing_context' end,
    completed_at=case when v_next>=v_total then now() else null end,updated_at=now()
    where id=v_request.id and user_id=v_user;
  return jsonb_build_object('ready',true,'idempotent',false,'document_version_id',p_version_id,
    'next_chunk',v_next,'total_chunks',v_total,
    'request_state',case when v_next>=v_total then 'ready' else 'preparing_context' end);
end;
$$;
revoke all on function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) from public,anon,service_role;
grant execute on function public.finalize_application_document_item(uuid,uuid,text,text,text,text,text,jsonb,jsonb) to authenticated;

-- The recovery and Drive lease RPCs from the preceding migration are new to
-- PostgREST. Reload its schema cache before the app can call them.
notify pgrst, 'reload schema';
