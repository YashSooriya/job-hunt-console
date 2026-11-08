-- Repair the M07 Drive lease RPCs in installations whose migration history
-- records 20261107211016 but whose database did not receive its Drive objects.
create table if not exists private.document_drive_publish_leases (
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
  if not found then return jsonb_build_object('claimed',false,'state','retrying'); end if;

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

notify pgrst, 'reload schema';
