-- Restore the MCP rate-limit RPC without exposing the private dispatcher
-- schema.  Migration 0057 intentionally revoked direct execution on every
-- chatgpt_internal function, but it also recreated the public wrapper as
-- SECURITY INVOKER.  That left the public MCP endpoint unable to reach its
-- token-validating implementation.
--
-- Keep the private dispatcher and its implementation closed.  The only
-- REST-callable entry point is the public wrapper, which accepts the raw OAuth
-- token only so the existing private implementation can hash, validate and
-- scope it before touching any per-user state.

alter function public.chatgpt_consume_rate_limit(text,text,integer,integer)
  security definer;
alter function public.chatgpt_consume_rate_limit(text,text,integer,integer)
  set search_path = '';

revoke all on function chatgpt_internal.consume_rate_limit(text,text,integer,integer)
  from public, anon, authenticated;
revoke all on function private.chatgpt_consume_rate_limit_internal(text,text,integer,integer)
  from public, anon, authenticated;

revoke execute on function public.chatgpt_consume_rate_limit(text,text,integer,integer)
  from public, authenticated;
grant execute on function public.chatgpt_consume_rate_limit(text,text,integer,integer)
  to anon, service_role;
