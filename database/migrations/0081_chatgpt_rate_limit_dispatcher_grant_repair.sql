-- Restore the internal rate-limit dispatcher grant when the historical grant
-- migration was not present in the hosted migration history.
-- Keep the schema private to the intended MCP API roles.

grant usage on schema chatgpt_internal to anon, authenticated;
grant execute on function chatgpt_internal.consume_rate_limit(text,text,integer,integer) to anon, authenticated;
