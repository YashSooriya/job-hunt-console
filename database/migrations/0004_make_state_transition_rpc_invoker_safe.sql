-- Milestone 1 hardening: make the user-facing state-transition RPC security-invoker safe.

create policy audit_owner_insert on public.audit_events
  for insert to authenticated
  with check (user_id = auth.uid() and actor_type = 'user');

create or replace function public.transition_application_state(
  p_application_id uuid,
  p_to_state public.application_state,
  p_metadata jsonb default '{}'::jsonb
)
returns public.applications
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_app public.applications;
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_app from public.applications where id = p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.user_id <> v_user then raise exception 'Not authorised'; end if;
  if v_app.state = p_to_state then return v_app; end if;
  if not exists (
    select 1 from public.application_state_transitions
    where from_state = v_app.state and to_state = p_to_state
  ) then
    raise exception 'Invalid application transition: % -> %', v_app.state, p_to_state;
  end if;
  update public.applications
    set state = p_to_state,
        updated_at = now(),
        submitted_at = case when p_to_state='submitted' then coalesce(submitted_at, now()) else submitted_at end
    where id = p_application_id
    returning * into v_app;
  insert into public.audit_events(user_id, actor_type, actor_id, event_type, entity_type, entity_id, metadata)
    values(v_app.user_id, 'user', v_user::text, 'application.state_changed', 'application', v_app.id,
      jsonb_build_object('to_state', p_to_state) || p_metadata);
  return v_app;
end;
$$;

revoke all on function public.transition_application_state(uuid, public.application_state, jsonb) from public, anon;
grant execute on function public.transition_application_state(uuid, public.application_state, jsonb) to authenticated;
