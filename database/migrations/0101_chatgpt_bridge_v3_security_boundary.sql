-- Repair the deployed M39 v3 completion dependency boundary. The public v3
-- wrappers intentionally remain SECURITY INVOKER and are callable only by the
-- service role. Their private membership check is already SECURITY DEFINER and
-- performs the application-level active-membership validation; grant execute
-- on that helper only to service_role so the invoker wrappers can call it.

alter function public.chatgpt_bridge_service_complete_dispatch_v3(
  uuid, uuid, text, uuid, text, text, jsonb
) security invoker;

alter function public.chatgpt_bridge_service_complete_reused_dispatch_v3(
  uuid, uuid, text, uuid, text, text, jsonb
) security invoker;

revoke all on function private.assert_active_app_membership(uuid) from public, anon, authenticated;
grant execute on function private.assert_active_app_membership(uuid) to service_role;

revoke all on function public.chatgpt_bridge_service_complete_dispatch_v3(
  uuid, uuid, text, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_complete_dispatch_v3(
  uuid, uuid, text, uuid, text, text, jsonb
) to service_role;

revoke all on function public.chatgpt_bridge_service_complete_reused_dispatch_v3(
  uuid, uuid, text, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_complete_reused_dispatch_v3(
  uuid, uuid, text, uuid, text, text, jsonb
) to service_role;
