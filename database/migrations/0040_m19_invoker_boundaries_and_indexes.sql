-- Milestone 19 security follow-up: keep REST-callable wrappers SECURITY INVOKER
-- while isolating privileged implementation bodies in the private schema.

create index if not exists chatgpt_oauth_codes_user_idx
  on private.chatgpt_oauth_authorization_codes(user_id);
create index if not exists chatgpt_reasoning_results_work_item_idx
  on public.chatgpt_reasoning_results(work_item_id);

alter function public.chatgpt_issue_authorization_code(text,text,text,text,text) set schema private;
alter function private.chatgpt_issue_authorization_code(text,text,text,text,text) rename to chatgpt_issue_authorization_code_internal;
alter function public.chatgpt_exchange_authorization_code(text,text,text,text) set schema private;
alter function private.chatgpt_exchange_authorization_code(text,text,text,text) rename to chatgpt_exchange_authorization_code_internal;
alter function public.chatgpt_refresh_access_token(text,text) set schema private;
alter function private.chatgpt_refresh_access_token(text,text) rename to chatgpt_refresh_access_token_internal;
alter function public.chatgpt_revoke_token(text) set schema private;
alter function private.chatgpt_revoke_token(text) rename to chatgpt_revoke_token_internal;
alter function public.chatgpt_connection_status() set schema private;
alter function private.chatgpt_connection_status() rename to chatgpt_connection_status_internal;
alter function public.chatgpt_mcp_call(text,text,jsonb) set schema private;
alter function private.chatgpt_mcp_call(text,text,jsonb) rename to chatgpt_mcp_call_internal;

revoke all on function private.chatgpt_issue_authorization_code_internal(text,text,text,text,text) from public, anon, authenticated;
grant execute on function private.chatgpt_issue_authorization_code_internal(text,text,text,text,text) to authenticated;
revoke all on function private.chatgpt_exchange_authorization_code_internal(text,text,text,text) from public, anon, authenticated;
grant execute on function private.chatgpt_exchange_authorization_code_internal(text,text,text,text) to anon, authenticated;
revoke all on function private.chatgpt_refresh_access_token_internal(text,text) from public, anon, authenticated;
grant execute on function private.chatgpt_refresh_access_token_internal(text,text) to anon, authenticated;
revoke all on function private.chatgpt_revoke_token_internal(text) from public, anon, authenticated;
grant execute on function private.chatgpt_revoke_token_internal(text) to anon, authenticated;
revoke all on function private.chatgpt_connection_status_internal() from public, anon, authenticated;
grant execute on function private.chatgpt_connection_status_internal() to authenticated;
revoke all on function private.chatgpt_mcp_call_internal(text,text,jsonb) from public, anon, authenticated;
grant execute on function private.chatgpt_mcp_call_internal(text,text,jsonb) to anon, authenticated;

create or replace function public.chatgpt_issue_authorization_code(
  p_client_id text,
  p_redirect_uri text,
  p_code_challenge text,
  p_code_challenge_method text,
  p_scope text default 'profile:read work:write'
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.chatgpt_issue_authorization_code_internal($1,$2,$3,$4,$5);
$$;
revoke all on function public.chatgpt_issue_authorization_code(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.chatgpt_issue_authorization_code(text,text,text,text,text) to authenticated;

create or replace function public.chatgpt_exchange_authorization_code(
  p_code text,
  p_client_id text,
  p_redirect_uri text,
  p_code_verifier text
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.chatgpt_exchange_authorization_code_internal($1,$2,$3,$4);
$$;
revoke all on function public.chatgpt_exchange_authorization_code(text,text,text,text) from public, authenticated;
grant execute on function public.chatgpt_exchange_authorization_code(text,text,text,text) to anon, authenticated;

create or replace function public.chatgpt_refresh_access_token(
  p_refresh_token text,
  p_client_id text
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.chatgpt_refresh_access_token_internal($1,$2);
$$;
revoke all on function public.chatgpt_refresh_access_token(text,text) from public, authenticated;
grant execute on function public.chatgpt_refresh_access_token(text,text) to anon, authenticated;

create or replace function public.chatgpt_revoke_token(p_token text)
returns boolean
language sql
security invoker
set search_path=''
as $$
  select private.chatgpt_revoke_token_internal($1);
$$;
revoke all on function public.chatgpt_revoke_token(text) from public, authenticated;
grant execute on function public.chatgpt_revoke_token(text) to anon, authenticated;

create or replace function public.chatgpt_connection_status()
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.chatgpt_connection_status_internal();
$$;
revoke all on function public.chatgpt_connection_status() from public, anon, authenticated;
grant execute on function public.chatgpt_connection_status() to authenticated;

create or replace function public.chatgpt_mcp_call(
  p_access_token text,
  p_tool_name text,
  p_arguments jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select private.chatgpt_mcp_call_internal($1,$2,$3);
$$;
revoke all on function public.chatgpt_mcp_call(text,text,jsonb) from public, authenticated;
grant execute on function public.chatgpt_mcp_call(text,text,jsonb) to anon, authenticated;

comment on function public.chatgpt_mcp_call(text,text,jsonb) is
  'M19 invoker boundary for the token-authenticated ChatGPT MCP router; privileged logic is private.';
