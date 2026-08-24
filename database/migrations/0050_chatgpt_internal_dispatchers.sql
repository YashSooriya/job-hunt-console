-- M19-M24 security follow-up: keep REST-callable public wrappers SECURITY
-- INVOKER while avoiding anonymous usage of the broad private schema. The
-- dedicated non-exposed schema contains only token-bound dispatchers.

create schema if not exists chatgpt_internal;
revoke all on schema chatgpt_internal from public, anon, authenticated;
grant usage on schema chatgpt_internal to anon, authenticated;

create or replace function chatgpt_internal.exchange_authorization_code(p_code text,p_client_id text,p_redirect_uri text,p_code_verifier text)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_exchange_authorization_code_internal(p_code,p_client_id,p_redirect_uri,p_code_verifier); $$;
create or replace function chatgpt_internal.refresh_access_token(p_refresh_token text,p_client_id text)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_refresh_access_token_internal(p_refresh_token,p_client_id); $$;
create or replace function chatgpt_internal.revoke_token(p_token text)
returns boolean language sql security definer set search_path=''
as $$ select private.chatgpt_revoke_token_internal(p_token); $$;
create or replace function chatgpt_internal.mcp_call(p_access_token text,p_tool_name text,p_arguments jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_mcp_call_internal(p_access_token,p_tool_name,p_arguments); $$;
create or replace function chatgpt_internal.ensure_search_run(p_access_token text,p_force boolean default false)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_ensure_search_run_internal(p_access_token,p_force); $$;
create or replace function chatgpt_internal.get_search_context(p_access_token text,p_limit integer default 50)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_search_context_internal(p_access_token,p_limit); $$;
create or replace function chatgpt_internal.prepare_application(p_access_token text,p_job_id uuid,p_package jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_prepare_application_internal(p_access_token,p_job_id,p_package); $$;
create or replace function chatgpt_internal.get_application_preparation_status(p_access_token text,p_application_id uuid)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_application_preparation_status_internal(p_access_token,p_application_id); $$;
create or replace function chatgpt_internal.get_browser_question_context(p_access_token text,p_limit integer default 20)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_browser_question_context_internal(p_access_token,p_limit); $$;
create or replace function chatgpt_internal.propose_browser_reasoning(p_access_token text,p_session_id uuid,p_proposal jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_propose_browser_reasoning_internal(p_access_token,p_session_id,p_proposal); $$;
create or replace function chatgpt_internal.consume_rate_limit(p_access_token text,p_bucket text,p_limit integer,p_window_seconds integer default 3600)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_consume_rate_limit_internal(p_access_token,p_bucket,p_limit,p_window_seconds); $$;
create or replace function chatgpt_internal.recover_stale_work(p_access_token text,p_limit integer default 20)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_recover_stale_work_internal(p_access_token,p_limit); $$;
create or replace function chatgpt_internal.get_pending_work_context(p_access_token text,p_limit integer default 20)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_pending_work_context_internal(p_access_token,p_limit); $$;

revoke all on all functions in schema chatgpt_internal from public, anon, authenticated;
grant execute on function
  chatgpt_internal.exchange_authorization_code(text,text,text,text),
  chatgpt_internal.refresh_access_token(text,text),
  chatgpt_internal.revoke_token(text),
  chatgpt_internal.mcp_call(text,text,jsonb),
  chatgpt_internal.ensure_search_run(text,boolean),
  chatgpt_internal.get_search_context(text,integer),
  chatgpt_internal.prepare_application(text,uuid,jsonb),
  chatgpt_internal.get_application_preparation_status(text,uuid),
  chatgpt_internal.get_browser_question_context(text,integer),
  chatgpt_internal.propose_browser_reasoning(text,uuid,jsonb),
  chatgpt_internal.consume_rate_limit(text,text,integer,integer),
  chatgpt_internal.recover_stale_work(text,integer),
  chatgpt_internal.get_pending_work_context(text,integer)
to anon, authenticated;

create or replace function public.chatgpt_exchange_authorization_code(p_code text,p_client_id text,p_redirect_uri text,p_code_verifier text)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.exchange_authorization_code(p_code,p_client_id,p_redirect_uri,p_code_verifier); $$;
create or replace function public.chatgpt_refresh_access_token(p_refresh_token text,p_client_id text)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.refresh_access_token(p_refresh_token,p_client_id); $$;
create or replace function public.chatgpt_revoke_token(p_token text)
returns boolean language sql security invoker set search_path=''
as $$ select chatgpt_internal.revoke_token(p_token); $$;
create or replace function public.chatgpt_mcp_call(p_access_token text,p_tool_name text,p_arguments jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.mcp_call(p_access_token,p_tool_name,p_arguments); $$;
create or replace function public.chatgpt_ensure_search_run(p_access_token text,p_force boolean default false)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.ensure_search_run(p_access_token,p_force); $$;
create or replace function public.chatgpt_get_search_context(p_access_token text,p_limit integer default 50)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_search_context(p_access_token,p_limit); $$;
create or replace function public.chatgpt_prepare_application(p_access_token text,p_job_id uuid,p_package jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.prepare_application(p_access_token,p_job_id,p_package); $$;
create or replace function public.chatgpt_get_application_preparation_status(p_access_token text,p_application_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_application_preparation_status(p_access_token,p_application_id); $$;
create or replace function public.chatgpt_get_browser_question_context(p_access_token text,p_limit integer default 20)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_browser_question_context(p_access_token,p_limit); $$;
create or replace function public.chatgpt_propose_browser_reasoning(p_access_token text,p_session_id uuid,p_proposal jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.propose_browser_reasoning(p_access_token,p_session_id,p_proposal); $$;
create or replace function public.chatgpt_consume_rate_limit(p_access_token text,p_bucket text,p_limit integer,p_window_seconds integer default 3600)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.consume_rate_limit(p_access_token,p_bucket,p_limit,p_window_seconds); $$;
create or replace function public.chatgpt_recover_stale_work(p_access_token text,p_limit integer default 20)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.recover_stale_work(p_access_token,p_limit); $$;
create or replace function public.chatgpt_get_pending_work_context(p_access_token text,p_limit integer default 20)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_pending_work_context(p_access_token,p_limit); $$;
