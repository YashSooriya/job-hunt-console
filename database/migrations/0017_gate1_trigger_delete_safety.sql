-- Milestone 7 patch: make Gate 1 mutation guard safe for DELETE triggers.
create or replace function public.guard_application_content_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_application_id uuid;
  v_state public.application_state;
begin
  if tg_table_name = 'document_versions' then
    select application_id into v_application_id from public.documents where id = case when tg_op='DELETE' then old.document_id else new.document_id end;
  elsif tg_table_name = 'application_salary_contexts' then
    v_application_id := case when tg_op='DELETE' then old.application_id else new.application_id end;
  elsif tg_table_name = 'application_answers' then
    v_application_id := case when tg_op='DELETE' then old.application_id else new.application_id end;
  end if;
  if v_application_id is null then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  select state into v_state from public.applications where id=v_application_id;
  if v_state not in ('preparing','ready_for_review','revision_requested') then
    raise exception 'Application content is frozen after Approval Gate 1. Return to a revision state before changing it.';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke execute on function public.guard_application_content_mutation() from public, anon, authenticated;
