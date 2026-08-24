-- Milestone 7 hardening: content cannot be regenerated after Gate 1 without returning to a revision state.

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

-- Generated application documents only. Profile/base documents have no application_id and pass through.
drop trigger if exists document_versions_gate1_freeze on public.document_versions;
create trigger document_versions_gate1_freeze
before insert on public.document_versions
for each row execute function public.guard_application_content_mutation();

drop trigger if exists salary_context_gate1_freeze on public.application_salary_contexts;
create trigger salary_context_gate1_freeze
before insert or update or delete on public.application_salary_contexts
for each row execute function public.guard_application_content_mutation();

drop trigger if exists application_answers_gate1_freeze on public.application_answers;
create trigger application_answers_gate1_freeze
before insert or update or delete on public.application_answers
for each row execute function public.guard_application_content_mutation();

revoke execute on function public.guard_application_content_mutation() from public, anon, authenticated;
