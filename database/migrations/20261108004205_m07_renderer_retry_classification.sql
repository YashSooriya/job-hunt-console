-- Preserve a captured Bridge response when the renderer has a transient
-- infrastructure failure. Layout validation failures still require user input.
create or replace function public.set_application_document_generation_error(
  p_request_id uuid,p_item_id uuid,p_state text,p_error_code text,p_error_message text
)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_item public.document_generation_items;
begin
  if v_user is null or not private.current_user_active_member() then raise exception 'Active membership required'; end if;
  if p_state not in ('needs_user','failed','rendering') then raise exception 'Invalid document-generation error state'; end if;
  if p_state='rendering' and (p_error_code is distinct from 'document_renderer_retryable_failure' or p_item_id is null) then
    raise exception 'Only a retryable renderer failure may keep a captured document step open';
  end if;
  if length(coalesce(p_error_code,''))>80 or length(coalesce(p_error_message,''))>1000 then raise exception 'Error details exceed their safe length'; end if;
  if p_state='rendering' then
    select * into v_item from public.document_generation_items
      where id=p_item_id and request_id=p_request_id and user_id=v_user for update;
    if not found or v_item.response_hash is null or v_item.response_text is null or v_item.document_version_id is not null then
      raise exception 'A retryable renderer failure requires an exact saved response without a persisted version';
    end if;
    if not exists(select 1 from public.document_generation_requests r
      where r.id=p_request_id and r.user_id=v_user and r.application_id=v_item.application_id
        and r.dispatch_id is not null and r.current_chunk=(
          select min((e.ordinality-1)::integer) from jsonb_array_elements(r.context_chunks) with ordinality e(value,ordinality)
          where e.value->>'phase'='final' and e.value->>'kind'=v_item.document_kind::text
        )) then
      raise exception 'The retryable renderer failure is not bound to the saved final Bridge step';
    end if;
  end if;
  update public.document_generation_requests set state=p_state,error_code=nullif(p_error_code,''),error_message=nullif(p_error_message,''),updated_at=now()
    where id=p_request_id and user_id=v_user;
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
