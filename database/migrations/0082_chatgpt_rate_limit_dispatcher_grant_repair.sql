-- Safe repair for the rejected historical rate-limit grant proposal.
--
-- Do not grant EXECUTE on chatgpt_internal.consume_rate_limit to API roles.
-- The private dispatcher remains closed; the public wrapper is the sole
-- REST-callable entry point and runs the existing token-validating private
-- implementation as its owner.

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
