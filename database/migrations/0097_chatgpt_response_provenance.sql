-- M39: bind Website Bridge response completion to the exact rendered turn.
--
-- The v2 delivery fence proves that one user message was sent, but it did not
-- record which rendered assistant turn the response reader accepted. Keep the
-- new proof content-free and additive so old dispatch rows remain inspectable;
-- v3 completion is required for new structured profile imports. These wrappers
-- retain SECURITY INVOKER so their explicit service_role guard and the existing
-- function privileges remain the access boundary. The migration grants the
-- service role the narrowly scoped execute privilege needed for the private
-- membership/provenance helpers below.

alter table public.chatgpt_dispatch_requests
  add column if not exists response_provenance jsonb;

create or replace function private.chatgpt_validate_response_provenance(
  p_provenance jsonb,
  p_request public.chatgpt_dispatch_requests
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
  v_allowed text[] := array[
    'conversationUrl',
    'userTurnFingerprint',
    'userTurnMessageId',
    'assistantMessageId',
    'assistantFingerprint',
    'artifactKey',
    'source',
    'generationFinished'
  ];
begin
  if p_provenance is null or jsonb_typeof(p_provenance) <> 'object' then
    raise exception 'Exact-turn response provenance is required';
  end if;
  if length(p_provenance::text) > 3000 then raise exception 'The response provenance is too large'; end if;
  for v_key in select key from jsonb_object_keys(p_provenance) key loop
    if not (v_key = any(v_allowed)) then raise exception 'Response provenance contains an unsupported field'; end if;
  end loop;
  if length(coalesce(p_provenance->>'conversationUrl','')) < 1 or length(coalesce(p_provenance->>'conversationUrl','')) > 500 then raise exception 'The response provenance conversation URL is invalid'; end if;
  if length(coalesce(p_provenance->>'userTurnFingerprint','')) < 1 or length(coalesce(p_provenance->>'userTurnFingerprint','')) > 200 then raise exception 'The response provenance user-turn fingerprint is invalid'; end if;
  if p_provenance->>'source' not in ('assistant_turn','assistant_artifact') then raise exception 'The response provenance source is invalid'; end if;
  if coalesce((p_provenance->>'generationFinished')::boolean, false) is not true then raise exception 'The ChatGPT generation was not finished when the response was captured'; end if;
  for v_key in select unnest(array['userTurnMessageId','assistantMessageId','assistantFingerprint','artifactKey']) loop
    if p_provenance ? v_key and jsonb_typeof(p_provenance->v_key) not in ('string','null') then raise exception 'The response provenance identity is invalid'; end if;
    if length(coalesce(p_provenance->>v_key,'')) > 500 then raise exception 'The response provenance identity is invalid'; end if;
  end loop;
  if p_provenance->>'source' = 'assistant_turn'
     and nullif(p_provenance->>'assistantMessageId','') is null
     and nullif(p_provenance->>'assistantFingerprint','') is null then
    raise exception 'Assistant-turn response provenance is missing an assistant identity';
  end if;
  if p_provenance->>'source' = 'assistant_artifact'
     and nullif(p_provenance->>'artifactKey','') is null then
    raise exception 'Artifact response provenance is missing an artifact identity';
  end if;

  if p_request.delivery_turn_anchor is null then raise exception 'The dispatch has no durable exact-turn anchor'; end if;
  if p_request.delivery_user_turn_fingerprint is null then raise exception 'The dispatch has no durable user-turn identity'; end if;
  if p_provenance->>'conversationUrl' is distinct from p_request.delivery_turn_anchor->>'conversationUrl' then raise exception 'The response conversation does not match the sent conversation'; end if;
  if p_provenance->>'userTurnFingerprint' is distinct from p_request.delivery_user_turn_fingerprint then raise exception 'The response does not match the sent user turn'; end if;
  if p_request.delivery_user_turn_message_id is not null
     and p_provenance->>'userTurnMessageId' is distinct from p_request.delivery_user_turn_message_id then raise exception 'The response user-turn message id does not match the sent turn'; end if;
  return jsonb_build_object(
    'conversationUrl', p_provenance->>'conversationUrl',
    'userTurnFingerprint', p_provenance->>'userTurnFingerprint',
    'userTurnMessageId', p_provenance->'userTurnMessageId',
    'assistantMessageId', p_provenance->'assistantMessageId',
    'assistantFingerprint', p_provenance->'assistantFingerprint',
    'artifactKey', p_provenance->'artifactKey',
    'source', p_provenance->>'source',
    'generationFinished', true
  );
end;
$$;

revoke all on function private.chatgpt_validate_response_provenance(jsonb,public.chatgpt_dispatch_requests) from public, anon, authenticated;
grant execute on function private.chatgpt_validate_response_provenance(jsonb,public.chatgpt_dispatch_requests) to service_role;

create or replace function public.chatgpt_bridge_service_complete_dispatch_v3(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_attempt_id uuid,
  p_response_text text,
  p_response_hash text,
  p_response_provenance jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_provenance jsonb;
  v_result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  v_provenance := private.chatgpt_validate_response_provenance(p_response_provenance, v_request);
  v_result := public.chatgpt_bridge_service_complete_dispatch_v2(
    p_device_id, p_request_id, p_lease_token_hash, p_attempt_id, p_response_text, p_response_hash
  );
  if coalesce(v_result->>'accepted','true') <> 'false' and v_result->>'state' = 'completed' then
    update public.chatgpt_dispatch_requests
       set response_provenance=v_provenance,
           output_refs=coalesce(output_refs,'{}'::jsonb)||jsonb_build_object('response_provenance_recorded',true),
           updated_at=now()
     where id=p_request_id and user_id=v_device.user_id;
  end if;
  return v_result || jsonb_build_object('response_provenance_recorded',true);
end;
$$;

revoke all on function public.chatgpt_bridge_service_complete_dispatch_v3(uuid,uuid,text,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_complete_dispatch_v3(uuid,uuid,text,uuid,text,text,jsonb) to service_role;

create or replace function public.chatgpt_bridge_service_complete_reused_dispatch_v3(
  p_device_id uuid,
  p_request_id uuid,
  p_lease_token_hash text,
  p_attempt_id uuid,
  p_response_text text,
  p_response_hash text,
  p_response_provenance jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_device public.chatgpt_bridge_devices;
  v_request public.chatgpt_dispatch_requests;
  v_provenance jsonb;
  v_result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_device from public.chatgpt_bridge_devices where id=p_device_id and revoked_at is null;
  if not found then raise exception 'ChatGPT bridge device not found'; end if;
  perform private.assert_active_app_membership(v_device.user_id);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_device.user_id for update;
  if not found then raise exception 'Dispatch request not found'; end if;
  v_provenance := private.chatgpt_validate_response_provenance(p_response_provenance, v_request);
  v_result := public.chatgpt_bridge_service_complete_reused_dispatch_v2(
    p_device_id, p_request_id, p_lease_token_hash, p_attempt_id, p_response_text, p_response_hash
  );
  if coalesce(v_result->>'accepted','true') <> 'false' and v_result->>'state' = 'completed' then
    update public.chatgpt_dispatch_requests
       set response_provenance=v_provenance,
           output_refs=coalesce(output_refs,'{}'::jsonb)||jsonb_build_object('response_provenance_recorded',true),
           updated_at=now()
     where id=p_request_id and user_id=v_device.user_id;
  end if;
  return v_result || jsonb_build_object('response_provenance_recorded',true);
end;
$$;

revoke all on function public.chatgpt_bridge_service_complete_reused_dispatch_v3(uuid,uuid,text,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.chatgpt_bridge_service_complete_reused_dispatch_v3(uuid,uuid,text,uuid,text,text,jsonb) to service_role;

comment on column public.chatgpt_dispatch_requests.response_provenance is
  'Content-free exact-turn identity captured by the Website Bridge; required for new structured profile imports.';
