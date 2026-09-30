-- Member administration: safe restore/role controls, paused schedules on
-- revocation, owner-only permanent deletion, and storage access fencing.
-- The Website Bridge RPCs and their v3 completion/provenance contract are not
-- modified by this migration.

begin;

-- A deleted approver should not prevent deletion of an otherwise-owned
-- application record. Preserve the approval data, clear only its user link.
alter table public.application_answers
  drop constraint if exists application_answers_approved_by_fkey;
alter table public.application_answers
  add constraint application_answers_approved_by_fkey
  foreign key (approved_by) references auth.users(id) on delete set null;

alter table public.application_review_packages
  drop constraint if exists application_review_packages_approved_by_fkey;
alter table public.application_review_packages
  add constraint application_review_packages_approved_by_fkey
  foreign key (approved_by) references auth.users(id) on delete set null;

alter table public.application_salary_contexts
  drop constraint if exists application_salary_contexts_approved_by_fkey;
alter table public.application_salary_contexts
  add constraint application_salary_contexts_approved_by_fkey
  foreign key (approved_by) references auth.users(id) on delete set null;

alter table public.document_versions
  drop constraint if exists document_versions_approved_by_fkey;
alter table public.document_versions
  add constraint document_versions_approved_by_fkey
  foreign key (approved_by) references auth.users(id) on delete set null;

-- Storage paths are already namespaced by user UUID. This current-user-only
-- predicate makes a revoked member's outstanding JWT unable to read, replace,
-- or upload files while the server is purging their storage before Auth delete.
create or replace function private.current_user_active_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from private.app_memberships m
     where m.user_id = (select auth.uid())
       and m.email = lower(coalesce(auth.jwt()->>'email', ''))
       and m.status = 'active'
  );
$$;
revoke all on function private.current_user_active_member() from public, anon, service_role;
grant execute on function private.current_user_active_member() to authenticated;

-- The private ownership predicates protect the normalized applicant/job
-- tables. Keep that boundary effective for a revoked user with an unexpired
-- JWT as well as for browser-level navigation guards.
create or replace function private.owns_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.candidate_profiles p
     where p.id = p_profile_id and p.user_id = (select auth.uid())
  ) and private.current_user_active_member();
$$;
create or replace function private.owns_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.jobs j
     where j.id = p_job_id and j.user_id = (select auth.uid())
  ) and private.current_user_active_member();
$$;
create or replace function private.owns_application(p_application_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.applications a
     where a.id = p_application_id and a.user_id = (select auth.uid())
  ) and private.current_user_active_member();
$$;
create or replace function private.owns_document(p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.documents d
      left join public.applications a on a.id = d.application_id
      left join public.candidate_profiles p on p.id = d.profile_id
     where d.id = p_document_id
       and (a.user_id = (select auth.uid()) or p.user_id = (select auth.uid()))
  ) and private.current_user_active_member();
$$;

-- Core user_id-owned tables do not use private.owns_*; add the active-member
-- condition directly so all browser REST reads and writes stop at revocation.
alter policy application_preparation_requests_owner on public.application_preparation_requests
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy applications_owner on public.applications
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy audit_owner_read on public.audit_events
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy audit_owner_insert on public.audit_events
  with check (user_id = (select auth.uid()) and actor_type = 'user' and (select private.current_user_active_member()));
alter policy tasks_owner on public.automation_tasks
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy browser_agent_reasoning_owner on public.browser_agent_reasoning
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy candidate_automation_settings_owner on public.candidate_automation_settings
  using (
    exists (select 1 from public.candidate_profiles p where p.id = candidate_automation_settings.profile_id and p.user_id = (select auth.uid()))
    and (select private.current_user_active_member())
  )
  with check (
    exists (select 1 from public.candidate_profiles p where p.id = candidate_automation_settings.profile_id and p.user_id = (select auth.uid()))
    and (select private.current_user_active_member())
  );
alter policy candidate_profiles_owner on public.candidate_profiles
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy companies_owner on public.companies
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy emails_owner on public.emails
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy gmail_sync_state_owner on public.gmail_sync_state
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy job_search_controls_owner on public.job_search_controls
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy job_search_run_jobs_owner on public.job_search_run_jobs
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy job_search_runs_owner on public.job_search_runs
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy job_search_runs_owner_insert on public.job_search_runs
  with check (auth.uid() is not null and user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy job_search_sources_owner on public.job_search_sources
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));
alter policy job_url_inspection_requests_owner_insert on public.job_url_inspection_requests
  with check (auth.uid() is not null and auth.uid() = user_id and (select private.current_user_active_member()));
alter policy job_url_inspection_requests_owner_select on public.job_url_inspection_requests
  using (auth.uid() is not null and auth.uid() = user_id and (select private.current_user_active_member()));
alter policy job_url_inspection_requests_owner_update_dispatch on public.job_url_inspection_requests
  using (auth.uid() is not null and auth.uid() = user_id and (select private.current_user_active_member()))
  with check (auth.uid() is not null and auth.uid() = user_id and (select private.current_user_active_member()));
alter policy jobs_owner on public.jobs
  using (user_id = (select auth.uid()) and (select private.current_user_active_member()))
  with check (user_id = (select auth.uid()) and (select private.current_user_active_member()));

drop policy if exists jobhunt_application_documents_select on storage.objects;
drop policy if exists jobhunt_application_documents_insert on storage.objects;
drop policy if exists jobhunt_application_documents_update on storage.objects;
drop policy if exists jobhunt_application_documents_delete on storage.objects;
create policy jobhunt_application_documents_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );
create policy jobhunt_application_documents_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );
create policy jobhunt_application_documents_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  )
  with check (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );
create policy jobhunt_application_documents_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );

drop policy if exists jobhunt_candidate_sources_select on storage.objects;
drop policy if exists jobhunt_candidate_sources_insert on storage.objects;
drop policy if exists jobhunt_candidate_sources_update on storage.objects;
drop policy if exists jobhunt_candidate_sources_delete on storage.objects;
create policy jobhunt_candidate_sources_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'candidate-source-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );
create policy jobhunt_candidate_sources_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'candidate-source-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );
create policy jobhunt_candidate_sources_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'candidate-source-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  )
  with check (
    bucket_id = 'candidate-source-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );
create policy jobhunt_candidate_sources_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'candidate-source-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.current_user_active_member())
  );

-- Bind membership operations to the active user's email claim, not merely a
-- matching UUID. Replacing these helpers leaves their existing, narrowly
-- scoped grants and the established public wrappers intact.
create or replace function private.get_access_roster_internal()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_role text;
  v_members jsonb;
  v_invites jsonb;
begin
  select m.role into v_role
    from private.app_memberships m
   where m.user_id = v_user
     and m.email = v_email
     and m.status = 'active';
  if coalesce(v_role, '') not in ('owner', 'admin') then
    raise exception 'Administrator membership required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'user_id', m.user_id,
      'email', m.email,
      'role', m.role,
      'status', m.status,
      'joined_at', m.joined_at,
      'revoked_at', m.revoked_at,
      'is_self', m.user_id = v_user
    ) order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.email
  ), '[]'::jsonb)
    into v_members
    from private.app_memberships m;

  -- Expired invitations remain visible so an administrator can renew them.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', i.id,
      'email', i.email,
      'role', i.role,
      'status', i.status,
      'invited_at', i.invited_at,
      'expires_at', i.expires_at
    ) order by i.invited_at desc
  ), '[]'::jsonb)
    into v_invites
    from private.app_invitations i
   where i.status = 'pending';

  return jsonb_build_object('role', v_role, 'members', v_members, 'invitations', v_invites);
end;
$$;

create or replace function private.invite_app_member_internal(p_email text, p_role text default 'member')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email_claim text := lower(coalesce(auth.jwt()->>'email', ''));
  v_actor_role text;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_existing private.app_memberships%rowtype;
  v_invite private.app_invitations%rowtype;
begin
  select m.role into v_actor_role
    from private.app_memberships m
   where m.user_id = v_user and m.email = v_email_claim and m.status = 'active';
  if coalesce(v_actor_role, '') not in ('owner', 'admin') then
    raise exception 'Administrator membership required';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'A valid email address is required';
  end if;
  if coalesce(p_role, '') not in ('member', 'admin') then
    raise exception 'Invited role must be member or admin';
  end if;
  if v_actor_role = 'admin' and p_role <> 'member' then
    raise exception 'Only the owner can invite administrators';
  end if;

  select * into v_existing from private.app_memberships where email = v_email;
  if found and v_existing.status = 'active' then
    return jsonb_build_object('invited', false, 'reason', 'already_member', 'email', v_email, 'role', v_existing.role);
  end if;

  insert into private.app_invitations(email, role, status, invited_by, invited_at, expires_at, updated_at)
  values(v_email, p_role, 'pending', v_user, now(), now() + interval '30 days', now())
  on conflict(email) do update
    set role = excluded.role,
        status = 'pending',
        invited_by = v_user,
        accepted_by = null,
        invited_at = now(),
        accepted_at = null,
        revoked_at = null,
        expires_at = now() + interval '30 days',
        updated_at = now()
  returning * into v_invite;

  return jsonb_build_object(
    'invited', true,
    'id', v_invite.id,
    'email', v_invite.email,
    'role', v_invite.role,
    'expires_at', v_invite.expires_at
  );
end;
$$;

create or replace function private.cancel_app_invitation_internal(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_actor_role text;
  v_invite private.app_invitations%rowtype;
begin
  select m.role into v_actor_role
    from private.app_memberships m
   where m.user_id = v_user and m.email = v_email and m.status = 'active';
  if coalesce(v_actor_role, '') not in ('owner', 'admin') then
    raise exception 'Administrator membership required';
  end if;

  select * into v_invite from private.app_invitations where id = p_invitation_id for update;
  if not found then return jsonb_build_object('cancelled', false, 'reason', 'not_found'); end if;
  if v_invite.role = 'owner' then raise exception 'The owner invitation cannot be cancelled'; end if;
  if v_actor_role = 'admin' and v_invite.role = 'admin' then
    raise exception 'Administrators cannot cancel administrator invitations';
  end if;
  if v_invite.status <> 'pending' then
    return jsonb_build_object('cancelled', false, 'reason', 'not_pending');
  end if;

  update private.app_invitations
     set status = 'revoked', revoked_at = now(), updated_at = now()
   where id = p_invitation_id;
  return jsonb_build_object('cancelled', true, 'id', p_invitation_id, 'email', v_invite.email);
end;
$$;

-- Revocation is repeat-safe and disables background searches immediately.
-- It preserves applicant data and Gmail Vault credentials for possible restore.
create or replace function private.revoke_app_member_internal(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_actor_role text;
  v_target private.app_memberships%rowtype;
  v_was_active boolean;
begin
  select m.role into v_actor_role
    from private.app_memberships m
   where m.user_id = v_user and m.email = v_email and m.status = 'active';
  if coalesce(v_actor_role, '') not in ('owner', 'admin') then
    raise exception 'Administrator membership required';
  end if;
  if p_user_id = v_user then raise exception 'You cannot revoke your own membership'; end if;

  select * into v_target from private.app_memberships where user_id = p_user_id for update;
  if not found then return jsonb_build_object('revoked', false, 'reason', 'not_found'); end if;
  if v_target.role = 'owner' then raise exception 'The owner cannot be revoked'; end if;
  if v_actor_role = 'admin' and v_target.role = 'admin' then
    raise exception 'Administrators cannot revoke other administrators';
  end if;

  v_was_active := v_target.status = 'active';
  update private.app_memberships
     set status = 'revoked', revoked_at = coalesce(revoked_at, now()), updated_at = now()
   where user_id = p_user_id;
  update public.job_search_controls
     set search_schedule_enabled = false,
         next_scheduled_search_at = null,
         last_scheduled_search_error = null,
         updated_at = now()
   where user_id = p_user_id;
  update public.browser_agent_devices
     set revoked_at = coalesce(revoked_at, now()), updated_at = now()
   where user_id = p_user_id and revoked_at is null;
  update public.browser_agent_pairing_codes
     set used_at = coalesce(used_at, now())
   where user_id = p_user_id and used_at is null;
  update public.form_agent_sessions
     set status = 'cancelled',
         completed_at = coalesce(completed_at, now()),
         token_hash = encode(extensions.digest(extensions.gen_random_bytes(32), 'sha256'), 'hex'),
         updated_at = now()
   where user_id = p_user_id
     and status in ('active', 'needs_user', 'final_review', 'approved_for_submission', 'submitting');

  if v_was_active then
    insert into public.audit_events(user_id, actor_type, actor_id, event_type, entity_type, entity_id, metadata)
    values(p_user_id, 'system', 'membership-boundary', 'automation.credentials_revoked', 'user', p_user_id,
      jsonb_build_object('reason', 'membership_revoked', 'gmail_secret_preserved', true, 'search_schedule_paused', true));
  end if;

  return jsonb_build_object('revoked', true, 'user_id', p_user_id, 'email', v_target.email, 'already_revoked', not v_was_active);
end;
$$;
revoke execute on function private.revoke_app_member_internal(uuid) from public, anon, authenticated;
grant execute on function private.revoke_app_member_internal(uuid) to service_role;

-- This is the only client-facing administrative mutation RPC. It derives the
-- actor from the session, verifies the email claim, and enforces each action's
-- role matrix in the database rather than relying on UI visibility.
create or replace function public.manage_app_member(p_action text, p_user_id uuid, p_role text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_actor private.app_memberships%rowtype;
  v_target private.app_memberships%rowtype;
  v_secret_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_actor
    from private.app_memberships
   where user_id = v_user
   for share;
  if not found or v_actor.status <> 'active' or v_actor.email <> v_email then
    raise exception 'Active Job Hunt Console membership required';
  end if;
  if v_actor.role not in ('owner', 'admin') then raise exception 'Administrator membership required'; end if;
  if p_user_id is null then raise exception 'A target member is required'; end if;
  if p_user_id = v_user then raise exception 'You cannot administer or delete your own membership'; end if;
  if coalesce(p_action, '') not in ('restore', 'set_role', 'prepare_delete', 'finalize_delete') then
    raise exception 'Unsupported member action';
  end if;
  if p_action in ('set_role', 'prepare_delete', 'finalize_delete') and v_actor.role <> 'owner' then
    raise exception 'Only the owner can change roles or permanently delete accounts';
  end if;

  select * into v_target from private.app_memberships where user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_target.role = 'owner' then raise exception 'The owner account is protected'; end if;
  if v_actor.role = 'admin' and v_target.role <> 'member' then
    raise exception 'Administrators can only manage member accounts';
  end if;

  if p_action = 'restore' then
    if v_target.status = 'active' then
      return jsonb_build_object('ok', true, 'restored', false, 'reason', 'already_active');
    end if;
    update private.app_memberships
       set status = 'active', revoked_at = null, updated_at = now()
     where user_id = p_user_id;
    update private.app_invitations
       set status = 'revoked', revoked_at = coalesce(revoked_at, now()), updated_at = now()
     where email = v_target.email and status = 'pending';
    -- Restoration never silently resumes unattended job searches.
    update public.job_search_controls
       set search_schedule_enabled = false, next_scheduled_search_at = null, updated_at = now()
     where user_id = p_user_id;
    insert into public.audit_events(user_id, actor_type, actor_id, event_type, entity_type, entity_id, metadata)
    values(v_user, 'user', v_user::text, 'membership.member_restored', 'user', p_user_id,
      jsonb_build_object('role', v_target.role, 'search_schedule_remains_paused', true));
    return jsonb_build_object('ok', true, 'restored', true, 'user_id', p_user_id, 'email', v_target.email);
  end if;

  if p_action = 'set_role' then
    if coalesce(p_role, '') not in ('member', 'admin') then raise exception 'Role must be member or admin'; end if;
    if v_target.status <> 'active' then raise exception 'Restore the member before changing their role'; end if;
    if v_target.role = p_role then
      return jsonb_build_object('ok', true, 'changed', false, 'reason', 'unchanged', 'user_id', p_user_id, 'role', p_role);
    end if;
    update private.app_memberships set role = p_role, updated_at = now() where user_id = p_user_id;
    insert into public.audit_events(user_id, actor_type, actor_id, event_type, entity_type, entity_id, metadata)
    values(v_user, 'user', v_user::text, 'membership.member_role_changed', 'user', p_user_id,
      jsonb_build_object('old_role', v_target.role, 'new_role', p_role));
    return jsonb_build_object('ok', true, 'changed', true, 'user_id', p_user_id, 'role', p_role);
  end if;

  if p_action = 'prepare_delete' then
    perform private.revoke_app_member_internal(p_user_id);
    insert into public.audit_events(user_id, actor_type, actor_id, event_type, entity_type, entity_id, metadata)
    values(v_user, 'user', v_user::text, 'membership.member_delete_prepared', 'user', p_user_id,
      jsonb_build_object('role', v_target.role, 'storage_buckets', jsonb_build_array('candidate-source-documents', 'application-documents')));
    return jsonb_build_object('ok', true, 'prepared', true, 'user_id', p_user_id, 'email', v_target.email, 'role', v_target.role);
  end if;

  -- Called only after both user-owned Storage prefixes have been emptied. The
  -- Vault secret is removed before Auth deletion cascades the reference row.
  if v_target.status <> 'revoked' then raise exception 'Revoke the account before finalizing deletion'; end if;
  select c.refresh_secret_id into v_secret_id
    from private.gmail_oauth_credentials c
   where c.user_id = p_user_id
   for update;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
    delete from private.gmail_oauth_credentials where user_id = p_user_id;
  end if;
  return jsonb_build_object('ok', true, 'finalized', true, 'user_id', p_user_id);
end;
$$;
revoke all on function public.manage_app_member(text, uuid, text) from public, anon, service_role;
grant execute on function public.manage_app_member(text, uuid, text) to authenticated;

commit;
