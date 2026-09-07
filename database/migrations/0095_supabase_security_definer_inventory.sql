-- Point 12 follow-up: close the remaining SECURITY DEFINER edges found by the
-- live catalog audit.  Every definer must use an empty search_path, and a
-- private helper that accepts an arbitrary user id must not be callable by a
-- client role.  The public wrappers derive auth.uid() and run as the trusted
-- function owner instead.

-- These predicates are used from RLS policies.  They need the authenticated
-- role, but they must never inherit PUBLIC execution and must not resolve
-- objects through a mutable search path.
alter function private.owns_application(uuid) set search_path = '';
alter function private.owns_document(uuid) set search_path = '';
alter function private.owns_job(uuid) set search_path = '';
alter function private.owns_profile(uuid) set search_path = '';

revoke execute on function private.owns_application(uuid) from public;
revoke execute on function private.owns_document(uuid) from public;
revoke execute on function private.owns_job(uuid) from public;
revoke execute on function private.owns_profile(uuid) from public;
grant execute on function private.owns_application(uuid) to authenticated;
grant execute on function private.owns_document(uuid) to authenticated;
grant execute on function private.owns_job(uuid) to authenticated;
grant execute on function private.owns_profile(uuid) to authenticated;

-- Public wrappers below already derive auth.uid() (or enforce the actor role)
-- before calling their private implementation.  Make that boundary explicit
-- and remove direct authenticated execution from the private helper.
alter function public.get_automation_settings() security definer;
alter function public.revoke_app_member(uuid) security definer;
alter function public.start_job_url_inspection(uuid, text) security definer;
alter function public.set_job_url_inspection_response(uuid, text) security definer;
alter function public.mark_job_url_inspection_failed(uuid, text, boolean) security definer;
alter function public.complete_job_url_inspection(uuid, jsonb, text, text) security definer;

alter function public.get_automation_settings() set search_path = '';
alter function public.revoke_app_member(uuid) set search_path = '';
alter function public.start_job_url_inspection(uuid, text) set search_path = '';
alter function public.set_job_url_inspection_response(uuid, text) set search_path = '';
alter function public.mark_job_url_inspection_failed(uuid, text, boolean) set search_path = '';
alter function public.complete_job_url_inspection(uuid, jsonb, text, text) set search_path = '';

revoke execute on function private.automation_settings_for_user(uuid) from public, anon, authenticated;
revoke execute on function private.complete_job_url_inspection_for_user(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
revoke execute on function private.create_chatgpt_bridge_pairing_code_for_user(uuid) from public, anon, authenticated;
revoke execute on function private.mark_job_url_inspection_failed_for_user(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function private.revoke_app_member_internal(uuid) from public, anon, authenticated;
revoke execute on function private.set_job_url_inspection_response_for_user(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.start_job_url_inspection_for_user(uuid, uuid, text) from public, anon, authenticated;

-- New functions must start closed.  Existing public APIs retain their
-- explicit grants; this only changes defaults for future definitions owned by
-- the migration owner.
alter default privileges for role postgres in schema public
  revoke execute on functions from public;
alter default privileges for role postgres in schema private
  revoke execute on functions from public;
alter default privileges for role postgres in schema chatgpt_internal
  revoke execute on functions from public;
