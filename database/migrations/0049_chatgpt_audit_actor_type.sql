-- M19-M24 OAuth/MCP hotfix: ChatGPT is a first-class audit actor used by
-- token issuance and the token-authenticated MCP work boundaries.
alter table public.audit_events drop constraint if exists audit_events_actor_type_check;
alter table public.audit_events add constraint audit_events_actor_type_check
  check (actor_type in ('user','system','ai','integration','chatgpt'));

