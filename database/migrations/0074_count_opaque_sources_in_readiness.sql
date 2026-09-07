-- A source is ready for the Website Bridge as soon as its bytes are stored;
-- local text extraction is not part of the onboarding contract.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
    into v_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_onboarding_readiness'
     and pg_get_function_identity_arguments(p.oid) = '';

  if v_definition is not null then
    v_definition := replace(
      v_definition,
      'extraction_status=''extracted''',
      'extraction_status in (''stored'',''extracted'')'
    );
    execute v_definition;
  end if;
end;
$$;
