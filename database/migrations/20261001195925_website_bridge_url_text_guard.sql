-- Keep public URLs opaque when screening plain-language Bridge instructions.
-- URLs may legitimately contain words that resemble private implementation
-- terms (for example, an employer's jobhuntai or MCP route); the same terms in
-- surrounding instructions remain rejected.
create or replace function public.create_chatgpt_dispatch_request_with_website_instruction(
  p_action_type text,
  p_subject_refs jsonb default '{}'::jsonb,
  p_origin text default 'user_click',
  p_display_title text default null,
  p_idempotency_key text default null,
  p_priority integer default 50,
  p_website_instruction text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
  v_request public.chatgpt_dispatch_requests;
  v_instruction text := nullif(btrim(p_website_instruction),'');
  v_instruction_without_urls text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if v_instruction is not null then
    if length(v_instruction) > 6000 then raise exception 'Website Bridge instruction is too long'; end if;
    v_instruction_without_urls := regexp_replace(v_instruction, 'https?://[^[:space:]]+', '', 'gi');
    if v_instruction_without_urls ~* '(jobhuntai|mcp|dispatch request|claim_dispatch|chatgpt_bridge)' then
      raise exception 'Website Bridge instruction must be a plain-language task';
    end if;
  end if;

  v_result := public.create_chatgpt_dispatch_request(
    p_action_type,p_subject_refs,p_origin,p_display_title,p_idempotency_key,p_priority
  );
  select * into v_request
    from public.chatgpt_dispatch_requests
   where id=(v_result->>'id')::uuid and user_id=v_user
   for update;
  if not found then raise exception 'Dispatch request was not created'; end if;

  if v_instruction is not null and v_request.state in ('queued','claimed_by_extension','opening_chatgpt','composer_ready') then
    update public.chatgpt_dispatch_requests
       set website_instruction=v_instruction,
           manual_instruction=v_instruction,
           updated_at=now()
     where id=v_request.id
     returning * into v_request;
  end if;

  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,
    'action_version',v_request.action_version,'display_title',v_request.display_title,
    'idempotency_key',v_request.idempotency_key,'correlation_id',v_request.correlation_id,
    'website_instruction',v_request.website_instruction,
    'manual_instruction',v_request.manual_instruction,
    'mcp_fallback_instruction',coalesce(v_request.mcp_fallback_instruction,private.chatgpt_build_mcp_fallback_instruction(v_request.id)),
    'progress',v_request.progress_json,'error',v_request.error_json,'output_refs',v_request.output_refs,
    'bridge_response',v_request.bridge_response,'bridge_response_at',v_request.bridge_response_at,
    'created_at',v_request.created_at,'updated_at',v_request.updated_at,
    'idempotent',coalesce((v_result->>'idempotent')::boolean,false)
  );
end;
$$;
