-- Align authenticated URL-import deduplication with the synchronous
-- job-intelligence key used by manual/batch ingestion. Reuse the existing
-- function definition and replace only its dedupe declaration and lookup
-- block, preserving the ownership checks, write path and function permissions.
-- Existing duplicate rows are deliberately not deleted or merged here.
do $migration$
declare
  v_signature regprocedure := 'private.complete_job_url_inspection_for_user(uuid,uuid,jsonb,text,text)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_declaration text := '  v_dedupe text;';
  v_declaration_replacement text := E'  v_dedupe text;\n  v_legacy_dedupe text;\n  v_company_key text;\n  v_title_key text;\n  v_external_id_key text;\n  v_host_key text;';
  v_lookup text := $old$
  v_dedupe := lower(encode(extensions.digest(convert_to(
    v_company||'|'||v_title||'|'||coalesce(p_extraction->>'application_url',v_request.source_url,''),'utf8'),'sha256'),'hex'));
  select * into v_job
    from public.jobs
   where user_id=p_user_id and dedupe_key=v_dedupe
   for update;
$old$;
  v_lookup_replacement text := $new$
  v_company_key := btrim(regexp_replace(regexp_replace(lower(v_company), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_title_key := btrim(regexp_replace(regexp_replace(lower(v_title), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_external_id_key := btrim(regexp_replace(regexp_replace(lower(coalesce(p_extraction->>'external_job_id','')), '[^a-z0-9+#.]+' , ' ', 'g'), '[[:space:]]+', ' ', 'g'));
  v_host_key := lower(split_part(split_part(split_part(v_request.source_url, '://', 2), '/', 1), '?', 1));
  v_host_key := regexp_replace(v_host_key, ':[0-9]+$', '');
  if left(v_host_key,4)='www.' then v_host_key := substr(v_host_key,5); end if;
  if v_external_id_key <> '' then
    v_dedupe := v_company_key||'|external:'||v_external_id_key;
  else
    v_dedupe := v_company_key||'|'||v_title_key||'|'||coalesce(nullif(v_host_key,''),'no-host');
  end if;
  v_legacy_dedupe := lower(encode(extensions.digest(convert_to(
    v_company||'|'||v_title||'|'||coalesce(p_extraction->>'application_url',v_request.source_url,''),'utf8'),'sha256'),'hex'));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_dedupe,0));
  select * into v_job
    from public.jobs
   where user_id=p_user_id and dedupe_key=v_dedupe
   for update;
  if not found then
    select * into v_job
      from public.jobs
     where user_id=p_user_id and dedupe_key=v_legacy_dedupe
     for update;
    if found then
      update public.jobs set dedupe_key=v_dedupe,updated_at=now()
       where id=v_job.id and user_id=p_user_id
       returning * into v_job;
    end if;
  end if;
$new$;
begin
  if position(v_declaration in v_definition)=0 or position(v_lookup in v_definition)=0 then
    raise exception 'The installed listing-completion function no longer matches the reviewed dedupe patch; no function was changed';
  end if;
  v_definition := replace(v_definition,v_declaration,v_declaration_replacement);
  v_definition := replace(v_definition,v_lookup,v_lookup_replacement);
  if position(v_lookup in v_definition)>0
     or position(v_lookup_replacement in v_definition)=0
     or position('  v_legacy_dedupe text;' in v_definition)=0
     or position('  v_company_key text;' in v_definition)=0 then
    raise exception 'The canonical dedupe patch did not replace all reviewed source fragments';
  end if;
  execute v_definition;
end;
$migration$;
