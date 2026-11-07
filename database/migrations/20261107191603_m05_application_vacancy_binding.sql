-- A chosen application remains bound to the vacancy the user chose.
-- Keep authenticated clients' other owner-scoped column updates unchanged.
revoke update on table public.applications from public, anon, authenticated;
revoke update (job_id, chosen_to_apply_at) on table public.applications from public, anon, authenticated;

do $$
declare
  v_update_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_update_columns
    from pg_attribute a
   where a.attrelid = 'public.applications'::regclass
     and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('job_id', 'chosen_to_apply_at');

  if v_update_columns is null then
    raise exception 'Could not resolve permitted application update columns';
  end if;

  execute format(
    'grant update (%s) on table public.applications to authenticated',
    v_update_columns
  );
end;
$$;
