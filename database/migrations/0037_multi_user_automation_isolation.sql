-- Milestone 18: close cross-user automation privilege paths and bind Gmail/helper/form automation to active membership.

create or replace function private.assert_active_app_membership(p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if p_user is null then raise exception 'Authentication required'; end if;
  if not exists(
    select 1 from private.app_memberships
    where user_id=p_user and status='active'
  ) then
    raise exception 'Active Job Hunt Console membership required';
  end if;
end;
$$;
revoke all on function private.assert_active_app_membership(uuid) from public,anon,authenticated;

-- Gmail credentials remain preserved per user, but only an active member can store or retrieve them.
create or replace function private.store_gmail_refresh_token(p_refresh_token text)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_secret_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if nullif(btrim(coalesce(p_refresh_token,'')), '') is null then return false; end if;

  select refresh_secret_id into v_secret_id
  from private.gmail_oauth_credentials
  where user_id=v_user
  for update;

  if found then
    perform vault.update_secret(
      v_secret_id,
      p_refresh_token,
      null,
      'Google OAuth refresh token for Job Hunt Gmail read-only sync',
      null
    );
    update private.gmail_oauth_credentials set updated_at=now() where user_id=v_user;
  else
    v_secret_id := vault.create_secret(
      p_refresh_token,
      'job-hunt-gmail-refresh-' || v_user::text,
      'Google OAuth refresh token for Job Hunt Gmail read-only sync',
      null
    );
    insert into private.gmail_oauth_credentials(user_id,refresh_secret_id) values(v_user,v_secret_id);
  end if;
  return true;
end;
$$;

create or replace function private.get_gmail_refresh_token()
returns text
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_token text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select ds.decrypted_secret into v_token
  from private.gmail_oauth_credentials c
  join vault.decrypted_secrets ds on ds.id=c.refresh_secret_id
  where c.user_id=v_user;
  return v_token;
end;
$$;

revoke all on function private.store_gmail_refresh_token(text), private.get_gmail_refresh_token() from public,anon,authenticated;

create or replace function public.store_gmail_refresh_token(p_refresh_token text)
returns boolean
language sql
security definer
set search_path=''
as $$ select private.store_gmail_refresh_token(p_refresh_token); $$;

create or replace function public.get_gmail_refresh_token()
returns text
language sql
security definer
set search_path=''
as $$ select private.get_gmail_refresh_token(); $$;

revoke all on function public.store_gmail_refresh_token(text), public.get_gmail_refresh_token() from public,anon;
grant execute on function public.store_gmail_refresh_token(text), public.get_gmail_refresh_token() to authenticated;

-- The private p_user helpers are implementation details. Authenticated callers may only use wrappers that derive auth.uid().
revoke all on function
  private.start_form_agent_session_for_user(uuid,uuid),
  private.get_form_agent_session_status_for_user(uuid,uuid),
  private.approve_form_agent_final_review_for_user(uuid,uuid),
  private.record_form_agent_manual_submission_for_user(uuid,uuid),
  private.create_browser_agent_pairing_code_for_user(uuid),
  private.get_browser_agent_helper_status_for_user(uuid),
  private.revoke_browser_agent_device_for_user(uuid,uuid),
  private.start_form_agent_session_for_paired_device(uuid,uuid,uuid),
  private.resume_form_agent_session_for_user(uuid,uuid),
  private.start_form_agent_acceptance_session_for_paired_device(uuid,uuid,uuid,text),
  private.get_ats_acceptance_status_for_user(uuid)
from public,anon,authenticated;

create or replace function public.start_form_agent_session(p_application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.start_form_agent_session_for_user(v_user,p_application_id);
end $$;

create or replace function public.get_form_agent_session_status(p_application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.get_form_agent_session_status_for_user(v_user,p_application_id);
end $$;

create or replace function public.approve_form_agent_final_review(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.approve_form_agent_final_review_for_user(v_user,p_session_id);
end $$;

create or replace function public.record_form_agent_manual_submission(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.record_form_agent_manual_submission_for_user(v_user,p_session_id);
end $$;

create or replace function public.create_browser_agent_pairing_code()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.create_browser_agent_pairing_code_for_user(v_user);
end $$;

create or replace function public.get_browser_agent_helper_status()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.get_browser_agent_helper_status_for_user(v_user);
end $$;

create or replace function public.revoke_browser_agent_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.revoke_browser_agent_device_for_user(v_user,p_device_id);
end $$;

create or replace function public.start_form_agent_session_for_device(p_application_id uuid,p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.start_form_agent_session_for_paired_device(v_user,p_application_id,p_device_id);
end $$;

create or replace function public.resume_form_agent_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.resume_form_agent_session_for_user(v_user,p_session_id);
end $$;

create or replace function public.start_form_agent_acceptance_session_for_device(
  p_application_id uuid,
  p_device_id uuid,
  p_provider_family text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  return private.start_form_agent_acceptance_session_for_paired_device(v_user,p_application_id,p_device_id,p_provider_family);
end $$;

create or replace function public.get_v1_launch_status()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_cutover jsonb;
  v_helper jsonb;
  v_acceptance jsonb;
  v_cutover_ok boolean;
  v_gmail_ok boolean;
  v_helper_ok boolean;
  v_acceptance_ok boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  v_cutover := private.get_live_cutover_status();
  v_helper := private.get_browser_agent_helper_status_for_user(v_user);
  v_acceptance := private.get_ats_acceptance_status_for_user(v_user);
  v_cutover_ok := coalesce((v_cutover->>'cutover_complete')::boolean,false);
  v_gmail_ok := coalesce((v_cutover->>'gmail_refresh_credential')::boolean,false);
  v_helper_ok := coalesce((v_helper->>'paired')::boolean,false);
  v_acceptance_ok := coalesce((v_acceptance->>'coverage_complete')::boolean,false);
  return jsonb_build_object(
    'data_cutover',v_cutover,
    'browser_helper',v_helper,
    'live_ats_acceptance',v_acceptance,
    'database_launch_ready',(v_cutover_ok and v_gmail_ok and v_helper_ok and v_acceptance_ok),
    'hosted_deployment','external_check_required'
  );
end $$;

revoke all on function
  public.start_form_agent_session(uuid),
  public.get_form_agent_session_status(uuid),
  public.approve_form_agent_final_review(uuid),
  public.record_form_agent_manual_submission(uuid),
  public.create_browser_agent_pairing_code(),
  public.get_browser_agent_helper_status(),
  public.revoke_browser_agent_device(uuid),
  public.start_form_agent_session_for_device(uuid,uuid),
  public.resume_form_agent_session(uuid),
  public.start_form_agent_acceptance_session_for_device(uuid,uuid,text),
  public.get_v1_launch_status()
from public,anon;
grant execute on function
  public.start_form_agent_session(uuid),
  public.get_form_agent_session_status(uuid),
  public.approve_form_agent_final_review(uuid),
  public.record_form_agent_manual_submission(uuid),
  public.create_browser_agent_pairing_code(),
  public.get_browser_agent_helper_status(),
  public.revoke_browser_agent_device(uuid),
  public.start_form_agent_session_for_device(uuid,uuid),
  public.resume_form_agent_session(uuid),
  public.start_form_agent_acceptance_session_for_device(uuid,uuid,text),
  public.get_v1_launch_status()
to authenticated;

-- Service-only bridge RPCs enforce active membership before issuing or accepting helper credentials.
create or replace function public.browser_agent_service_pair_device(
  p_code_hash text,
  p_token_hash text,
  p_display_name text,
  p_platform text,
  p_helper_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_pairing public.browser_agent_pairing_codes;
  v_device public.browser_agent_devices;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if nullif(btrim(coalesce(p_code_hash,'')),'') is null then raise exception 'Pairing-code hash is required'; end if;
  if nullif(btrim(coalesce(p_token_hash,'')),'') is null then raise exception 'Device-token hash is required'; end if;

  select * into v_pairing
  from public.browser_agent_pairing_codes
  where code_hash=p_code_hash and used_at is null and expires_at>now()
  for update;
  if not found then raise exception 'Pairing code is invalid, expired, or already used'; end if;
  perform private.assert_active_app_membership(v_pairing.user_id);

  insert into public.browser_agent_devices(user_id,display_name,platform,helper_version,token_hash,last_seen_at)
  values(
    v_pairing.user_id,
    left(coalesce(nullif(btrim(p_display_name),''),'Job Hunt Browser Helper'),160),
    left(coalesce(nullif(btrim(p_platform),''),'macos'),40),
    nullif(left(coalesce(p_helper_version,''),40),''),
    p_token_hash,
    now()
  ) returning * into v_device;

  update public.browser_agent_pairing_codes set used_at=now() where id=v_pairing.id and used_at is null;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_pairing.user_id,'system','browser-helper-bridge','browser_helper.device_paired','browser_agent_device',v_device.id,
    jsonb_build_object('platform',v_device.platform,'helper_version',v_device.helper_version));

  return jsonb_build_object('id',v_device.id,'user_id',v_device.user_id,'display_name',v_device.display_name,'platform',v_device.platform,'helper_version',v_device.helper_version,'paired_at',v_device.paired_at);
end $$;

create or replace function public.browser_agent_service_authenticate_device(
  p_device_id uuid,
  p_token_hash text,
  p_helper_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_device public.browser_agent_devices;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.browser_agent_devices
   where id=p_device_id and token_hash=p_token_hash and revoked_at is null
   for update;
  if not found then raise exception 'Invalid browser-helper device credentials'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  update public.browser_agent_devices
     set last_seen_at=now(), helper_version=coalesce(nullif(left(coalesce(p_helper_version,''),40),''),helper_version), updated_at=now()
   where id=v_device.id;
  return jsonb_build_object('id',v_device.id,'user_id',v_device.user_id,'display_name',v_device.display_name,'platform',v_device.platform,'helper_version',coalesce(nullif(left(coalesce(p_helper_version,''),40),''),v_device.helper_version),'paired_at',v_device.paired_at,'last_seen_at',now());
end $$;

create or replace function public.browser_agent_service_member_active(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  return exists(select 1 from private.app_memberships where user_id=p_user and status='active');
end $$;

revoke all on function
  public.browser_agent_service_pair_device(text,text,text,text,text),
  public.browser_agent_service_authenticate_device(uuid,text,text),
  public.browser_agent_service_member_active(uuid)
from public,anon,authenticated;
grant execute on function
  public.browser_agent_service_pair_device(text,text,text,text,text),
  public.browser_agent_service_authenticate_device(uuid,text,text),
  public.browser_agent_service_member_active(uuid)
to service_role;

-- Revocation immediately invalidates helper credentials and live form sessions while preserving user data/Gmail secrets for possible re-invitation.
create or replace function private.revoke_app_member_internal(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_actor_role text;
  v_target private.app_memberships%rowtype;
begin
  select role into v_actor_role from private.app_memberships where user_id=v_user and status='active';
  if coalesce(v_actor_role,'') not in ('owner','admin') then raise exception 'Administrator membership required'; end if;
  if p_user_id=v_user then raise exception 'You cannot revoke your own membership'; end if;

  select * into v_target from private.app_memberships where user_id=p_user_id for update;
  if not found then return jsonb_build_object('revoked',false,'reason','not_found'); end if;
  if v_target.role='owner' then raise exception 'The owner cannot be revoked'; end if;
  if v_actor_role='admin' and v_target.role='admin' then raise exception 'Administrators cannot revoke other administrators'; end if;

  update private.app_memberships set status='revoked',revoked_at=now(),updated_at=now() where user_id=p_user_id;
  update public.browser_agent_devices set revoked_at=coalesce(revoked_at,now()),updated_at=now() where user_id=p_user_id and revoked_at is null;
  update public.browser_agent_pairing_codes set used_at=coalesce(used_at,now()) where user_id=p_user_id and used_at is null;
  update public.form_agent_sessions
     set status='cancelled', completed_at=coalesce(completed_at,now()), token_hash=encode(extensions.digest(extensions.gen_random_bytes(32),'sha256'),'hex'), updated_at=now()
   where user_id=p_user_id and status in ('active','needs_user','final_review','approved_for_submission','submitting');

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user_id,'system','membership-boundary','automation.credentials_revoked','user',p_user_id,
    jsonb_build_object('reason','membership_revoked','gmail_secret_preserved',true));

  return jsonb_build_object('revoked',true,'user_id',p_user_id,'email',v_target.email);
end $$;
