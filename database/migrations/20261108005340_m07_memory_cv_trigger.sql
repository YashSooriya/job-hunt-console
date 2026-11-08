-- The original CV trigger predates M07 and only understood database evidence
-- IDs. Keep that branch unchanged for historical evidence-backed documents,
-- while applying the established Memory-support contract to Memory-only CVs.
create or replace function public.validate_cv_structured_content()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_kind public.document_kind;
  v_claim record;
  v_missing integer;
begin
  select kind into v_kind from public.documents where id=new.document_id;
  if v_kind<>'cv' then return new; end if;
  if jsonb_typeof(coalesce(new.structured_content->'unsupported_claims','[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(new.structured_content->'unsupported_claims','[]'::jsonb))>0 then
    raise exception 'CV contains invalid or unsupported material claims';
  end if;

  if new.structured_content->>'source_mode'='chatgpt_memory' then
    if new.structured_content->>'engine_version' is distinct from 'chatgpt-memory-v4'
      or coalesce((new.structured_content->>'memory_review_required')::boolean,false) is not true
      or (tg_op='INSERT' and new.approval_status<>'needs_review')
      or (tg_op='UPDATE' and new.structured_content is distinct from old.structured_content and new.approval_status<>'needs_review') then
      raise exception 'Memory-only CV must remain unverified and require factual review';
    end if;
    if jsonb_typeof(new.structured_content->'headline_memory_support') is distinct from 'array'
      or jsonb_array_length(new.structured_content->'headline_memory_support')=0
      or jsonb_typeof(new.structured_content->'profile_summary'->'memory_support') is distinct from 'array'
      or jsonb_array_length(new.structured_content->'profile_summary'->'memory_support')=0 then
      raise exception 'Memory-only CV headline and profile summary require Memory support';
    end if;
    if coalesce(new.structured_content->'headline_evidence_ids','[]'::jsonb)<>'[]'::jsonb
      or coalesce(new.structured_content->'profile_summary'->'evidence_ids','[]'::jsonb)<>'[]'::jsonb then
      raise exception 'Memory-only CV cannot claim local evidence IDs';
    end if;
    if jsonb_typeof(new.structured_content->'sections') is distinct from 'array' then
      raise exception 'Memory-only CV sections are invalid';
    end if;
    for v_claim in
      select e.value as entry,b.value as bullet
      from jsonb_array_elements(new.structured_content->'sections') s(value)
      cross join jsonb_array_elements(coalesce(s.value->'entries','[]'::jsonb)) e(value)
      cross join jsonb_array_elements(coalesce(e.value->'bullets','[]'::jsonb)) b(value)
    loop
      if jsonb_typeof(v_claim.entry->'memory_support') is distinct from 'array'
        or jsonb_array_length(v_claim.entry->'memory_support')=0
        or jsonb_typeof(v_claim.bullet->'memory_support') is distinct from 'array'
        or jsonb_array_length(v_claim.bullet->'memory_support')=0
        or jsonb_typeof(coalesce(v_claim.bullet->'evidence_ids','[]'::jsonb)) is distinct from 'array'
        or jsonb_array_length(coalesce(v_claim.bullet->'evidence_ids','[]'::jsonb))<>0 then
        raise exception 'Every Memory-only CV entry and claim needs Memory support and no database evidence IDs';
      end if;
      if exists(select 1 from jsonb_array_elements_text(v_claim.entry->'memory_support') x(value) where btrim(x.value)='')
        or exists(select 1 from jsonb_array_elements_text(v_claim.bullet->'memory_support') x(value) where btrim(x.value)='') then
        raise exception 'A Memory-only CV support note is empty';
      end if;
    end loop;
    return new;
  end if;

  if jsonb_array_length(coalesce(new.structured_content->'profile_summary'->'evidence_ids','[]'::jsonb))=0 then
    raise exception 'CV profile summary must have evidence';
  end if;
  select count(*) into v_missing
  from jsonb_array_elements(coalesce(new.structured_content->'sections','[]'::jsonb)) s,
       jsonb_array_elements(coalesce(s->'entries','[]'::jsonb)) e,
       jsonb_array_elements(coalesce(e->'bullets','[]'::jsonb)) b
  where coalesce((b->>'material')::boolean,false)
    and jsonb_array_length(coalesce(b->'evidence_ids','[]'::jsonb))=0;
  if v_missing>0 then raise exception 'CV contains material bullets without evidence'; end if;
  return new;
end;
$$;
revoke execute on function public.validate_cv_structured_content() from public,anon,authenticated;
