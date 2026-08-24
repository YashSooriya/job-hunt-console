-- M19-M24 OAuth/MCP hotfix: the REST-callable wrappers are exposed to anon
-- but resolve implementations in the private schema. Keep the private schema
-- closed to anon and run only these explicit, token-validating dispatchers as
-- their definer so PostgreSQL can resolve the private implementation calls.
-- Every wrapper retains an empty search_path and its existing explicit
-- execute grant; the private implementations continue to validate the raw
-- OAuth token, scope, membership, and user-owned identifiers.

alter function public.chatgpt_exchange_authorization_code(text,text,text,text) security definer;
alter function public.chatgpt_refresh_access_token(text,text) security definer;
alter function public.chatgpt_revoke_token(text) security definer;
alter function public.chatgpt_mcp_call(text,text,jsonb) security definer;
alter function public.chatgpt_ensure_search_run(text,boolean) security definer;
alter function public.chatgpt_get_search_context(text,integer) security definer;
alter function public.chatgpt_prepare_application(text,uuid,jsonb) security definer;
alter function public.chatgpt_get_application_preparation_status(text,uuid) security definer;
alter function public.chatgpt_get_browser_question_context(text,integer) security definer;
alter function public.chatgpt_propose_browser_reasoning(text,uuid,jsonb) security definer;
alter function public.chatgpt_consume_rate_limit(text,text,integer,integer) security definer;
alter function public.chatgpt_recover_stale_work(text,integer) security definer;
alter function public.chatgpt_get_pending_work_context(text,integer) security definer;

