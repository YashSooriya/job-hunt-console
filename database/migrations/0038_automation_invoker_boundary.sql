-- Milestone 18 follow-up: keep exposed public RPCs SECURITY INVOKER while routing through safe current-user private definers.

-- Gmail private helpers already derive auth.uid() and do not accept a caller-controlled user id.
grant execute on function private.store_gmail_refresh_token(text), private.get_gmail_refresh_token() to authenticated;
create or replace function public.store_gmail_refresh_token(p_refresh_token text)
returns boolean language sql security invoker set search_path='' as $$ select private.store_gmail_refresh_token(p_refresh_token); $$;
create or replace function public.get_gmail_refresh_token()
returns text language sql security invoker set search_path='' as $$ select private.get_gmail_refresh_token(); $$;

create or replace function private.start_form_agent_session_current_user(p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.start_form_agent_session_for_user(v_user,p_application_id); end $$;
create or replace function private.get_form_agent_session_status_current_user(p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.get_form_agent_session_status_for_user(v_user,p_application_id); end $$;
create or replace function private.approve_form_agent_final_review_current_user(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.approve_form_agent_final_review_for_user(v_user,p_session_id); end $$;
create or replace function private.record_form_agent_manual_submission_current_user(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.record_form_agent_manual_submission_for_user(v_user,p_session_id); end $$;
create or replace function private.create_browser_agent_pairing_code_current_user()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.create_browser_agent_pairing_code_for_user(v_user); end $$;
create or replace function private.get_browser_agent_helper_status_current_user()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.get_browser_agent_helper_status_for_user(v_user); end $$;
create or replace function private.revoke_browser_agent_device_current_user(p_device_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.revoke_browser_agent_device_for_user(v_user,p_device_id); end $$;
create or replace function private.start_form_agent_session_for_device_current_user(p_application_id uuid,p_device_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.start_form_agent_session_for_paired_device(v_user,p_application_id,p_device_id); end $$;
create or replace function private.resume_form_agent_session_current_user(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.resume_form_agent_session_for_user(v_user,p_session_id); end $$;
create or replace function private.start_form_agent_acceptance_session_for_device_current_user(p_application_id uuid,p_device_id uuid,p_provider_family text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); begin if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user); return private.start_form_agent_acceptance_session_for_paired_device(v_user,p_application_id,p_device_id,p_provider_family); end $$;
create or replace function private.get_v1_launch_status_current_user()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := (select auth.uid()); v_cutover jsonb; v_helper jsonb; v_acceptance jsonb; v_cutover_ok boolean; v_gmail_ok boolean; v_helper_ok boolean; v_acceptance_ok boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if; perform private.assert_active_app_membership(v_user);
  v_cutover := private.get_live_cutover_status(); v_helper := private.get_browser_agent_helper_status_for_user(v_user); v_acceptance := private.get_ats_acceptance_status_for_user(v_user);
  v_cutover_ok := coalesce((v_cutover->>'cutover_complete')::boolean,false); v_gmail_ok := coalesce((v_cutover->>'gmail_refresh_credential')::boolean,false); v_helper_ok := coalesce((v_helper->>'paired')::boolean,false); v_acceptance_ok := coalesce((v_acceptance->>'coverage_complete')::boolean,false);
  return jsonb_build_object('data_cutover',v_cutover,'browser_helper',v_helper,'live_ats_acceptance',v_acceptance,'database_launch_ready',(v_cutover_ok and v_gmail_ok and v_helper_ok and v_acceptance_ok),'hosted_deployment','external_check_required');
end $$;

revoke all on function
  private.start_form_agent_session_current_user(uuid),
  private.get_form_agent_session_status_current_user(uuid),
  private.approve_form_agent_final_review_current_user(uuid),
  private.record_form_agent_manual_submission_current_user(uuid),
  private.create_browser_agent_pairing_code_current_user(),
  private.get_browser_agent_helper_status_current_user(),
  private.revoke_browser_agent_device_current_user(uuid),
  private.start_form_agent_session_for_device_current_user(uuid,uuid),
  private.resume_form_agent_session_current_user(uuid),
  private.start_form_agent_acceptance_session_for_device_current_user(uuid,uuid,text),
  private.get_v1_launch_status_current_user()
from public,anon,authenticated;
grant execute on function
  private.start_form_agent_session_current_user(uuid),
  private.get_form_agent_session_status_current_user(uuid),
  private.approve_form_agent_final_review_current_user(uuid),
  private.record_form_agent_manual_submission_current_user(uuid),
  private.create_browser_agent_pairing_code_current_user(),
  private.get_browser_agent_helper_status_current_user(),
  private.revoke_browser_agent_device_current_user(uuid),
  private.start_form_agent_session_for_device_current_user(uuid,uuid),
  private.resume_form_agent_session_current_user(uuid),
  private.start_form_agent_acceptance_session_for_device_current_user(uuid,uuid,text),
  private.get_v1_launch_status_current_user()
to authenticated;

create or replace function public.start_form_agent_session(p_application_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.start_form_agent_session_current_user(p_application_id); $$;
create or replace function public.get_form_agent_session_status(p_application_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.get_form_agent_session_status_current_user(p_application_id); $$;
create or replace function public.approve_form_agent_final_review(p_session_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.approve_form_agent_final_review_current_user(p_session_id); $$;
create or replace function public.record_form_agent_manual_submission(p_session_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.record_form_agent_manual_submission_current_user(p_session_id); $$;
create or replace function public.create_browser_agent_pairing_code()
returns jsonb language sql security invoker set search_path='' as $$ select private.create_browser_agent_pairing_code_current_user(); $$;
create or replace function public.get_browser_agent_helper_status()
returns jsonb language sql security invoker set search_path='' as $$ select private.get_browser_agent_helper_status_current_user(); $$;
create or replace function public.revoke_browser_agent_device(p_device_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.revoke_browser_agent_device_current_user(p_device_id); $$;
create or replace function public.start_form_agent_session_for_device(p_application_id uuid,p_device_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.start_form_agent_session_for_device_current_user(p_application_id,p_device_id); $$;
create or replace function public.resume_form_agent_session(p_session_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.resume_form_agent_session_current_user(p_session_id); $$;
create or replace function public.start_form_agent_acceptance_session_for_device(p_application_id uuid,p_device_id uuid,p_provider_family text)
returns jsonb language sql security invoker set search_path='' as $$ select private.start_form_agent_acceptance_session_for_device_current_user(p_application_id,p_device_id,p_provider_family); $$;
create or replace function public.get_v1_launch_status()
returns jsonb language sql security invoker set search_path='' as $$ select private.get_v1_launch_status_current_user(); $$;
