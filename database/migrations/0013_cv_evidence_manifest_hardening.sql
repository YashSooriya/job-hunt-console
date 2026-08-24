-- Milestone 5 hardening: every persistent CV claim must reference verified evidence,
-- and the evidence-link manifest must exactly cover the structured material claims.

create or replace function public.validate_cv_structured_content()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind public.document_kind;
  v_profile_id uuid;
  v_missing integer;
  v_claim record;
  v_evidence_text text;
  v_evidence_id uuid;
begin
  select d.kind,
         coalesce(d.profile_id, cp.id)
    into v_kind, v_profile_id
  from public.documents d
  left join public.applications a on a.id = d.application_id
  left join public.candidate_profiles cp on cp.user_id = a.user_id
  where d.id = new.document_id;

  if v_kind <> 'cv' then return new; end if;
  if v_profile_id is null then raise exception 'CV document has no candidate profile owner'; end if;

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

  for v_claim in
    select 'profile_summary'::text as claim_key,
           coalesce(new.structured_content->'profile_summary'->'evidence_ids','[]'::jsonb) as evidence_ids
    union all
    select b->>'claim_key', coalesce(b->'evidence_ids','[]'::jsonb)
    from jsonb_array_elements(coalesce(new.structured_content->'sections','[]'::jsonb)) s,
         jsonb_array_elements(coalesce(s->'entries','[]'::jsonb)) e,
         jsonb_array_elements(coalesce(e->'bullets','[]'::jsonb)) b
    where coalesce((b->>'material')::boolean,false)
  loop
    if v_claim.claim_key is null then raise exception 'Material CV claim has no claim key'; end if;
    for v_evidence_text in select jsonb_array_elements_text(v_claim.evidence_ids)
    loop
      begin
        v_evidence_id := v_evidence_text::uuid;
      exception when invalid_text_representation then
        raise exception 'CV evidence ID is not a persistent UUID: %', v_evidence_text;
      end;
      if not exists (
        select 1 from public.evidence_items ei
        where ei.id = v_evidence_id
          and ei.profile_id = v_profile_id
          and ei.verification_status = 'verified'
      ) then
        raise exception 'CV references unverified or foreign evidence: %', v_evidence_text;
      end if;
    end loop;
  end loop;

  return new;
end;
$$;
revoke execute on function public.validate_cv_structured_content() from public, anon, authenticated;

create or replace function public.validate_cv_evidence_manifest_deferred()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_kind public.document_kind;
  v_content jsonb;
  v_claim record;
  v_evidence_text text;
  v_evidence_id uuid;
begin
  if tg_table_name = 'document_versions' then
    v_version_id := coalesce(new.id, old.id);
  else
    v_version_id := coalesce(new.document_version_id, old.document_version_id);
  end if;

  select d.kind, dv.structured_content
    into v_kind, v_content
  from public.document_versions dv
  join public.documents d on d.id = dv.document_id
  where dv.id = v_version_id;

  -- Cascading deletion of a whole version/document has nothing left to validate.
  if not found or v_kind <> 'cv' then return null; end if;

  for v_claim in
    select 'profile_summary'::text as claim_key,
           coalesce(v_content->'profile_summary'->'evidence_ids','[]'::jsonb) as evidence_ids
    union all
    select b->>'claim_key', coalesce(b->'evidence_ids','[]'::jsonb)
    from jsonb_array_elements(coalesce(v_content->'sections','[]'::jsonb)) s,
         jsonb_array_elements(coalesce(s->'entries','[]'::jsonb)) e,
         jsonb_array_elements(coalesce(e->'bullets','[]'::jsonb)) b
    where coalesce((b->>'material')::boolean,false)
  loop
    for v_evidence_text in select jsonb_array_elements_text(v_claim.evidence_ids)
    loop
      v_evidence_id := v_evidence_text::uuid;
      if not exists (
        select 1 from public.document_evidence_links l
        where l.document_version_id = v_version_id
          and l.claim_key = v_claim.claim_key
          and l.evidence_item_id = v_evidence_id
      ) then
        raise exception 'CV evidence manifest is incomplete for claim %', v_claim.claim_key;
      end if;
    end loop;
  end loop;

  return null;
end;
$$;
revoke execute on function public.validate_cv_evidence_manifest_deferred() from public, anon, authenticated;

drop trigger if exists cv_manifest_after_version_change on public.document_versions;
create constraint trigger cv_manifest_after_version_change
after insert or update on public.document_versions
deferrable initially deferred
for each row execute function public.validate_cv_evidence_manifest_deferred();

drop trigger if exists cv_manifest_after_evidence_change on public.document_evidence_links;
create constraint trigger cv_manifest_after_evidence_change
after insert or update or delete on public.document_evidence_links
deferrable initially deferred
for each row execute function public.validate_cv_evidence_manifest_deferred();
