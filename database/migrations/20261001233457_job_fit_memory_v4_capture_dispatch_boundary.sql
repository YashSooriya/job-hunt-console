-- Keep the public capture API SECURITY INVOKER and preserve the dispatch
-- table's closed client grants. A private owner-scoped reader supplies only
-- the fields needed to validate and capture this user's exact completed turn.
create or replace function private.job_fit_memory_v4_get_dispatch_for_capture(
  p_dispatch_id uuid,
  p_idempotency_key text,
  p_job_ids uuid[],
  p_instruction text
)
returns table (
  id uuid,
  state text,
  output_refs jsonb,
  bridge_response text,
  bridge_response_at timestamptz,
  response_provenance jsonb,
  delivery_turn_anchor jsonb,
  delivery_user_turn_fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null or not (select private.current_user_active_member()) then
    raise exception 'Active membership required';
  end if;

  return query
  select d.id,d.state,d.output_refs,d.bridge_response,d.bridge_response_at,
         d.response_provenance,d.delivery_turn_anchor,d.delivery_user_turn_fingerprint
    from public.chatgpt_dispatch_requests d
   where d.id=p_dispatch_id
     and d.user_id=v_user
     and d.action_type='jobs.analyse_selected'
     and d.idempotency_key=p_idempotency_key
     and d.subject_refs->'job_ids'=to_jsonb(p_job_ids)
     and coalesce(d.website_instruction,d.manual_instruction)=p_instruction;
end;
$$;
revoke all on function private.job_fit_memory_v4_get_dispatch_for_capture(uuid,text,uuid[],text) from public,anon,service_role;
grant execute on function private.job_fit_memory_v4_get_dispatch_for_capture(uuid,text,uuid[],text) to authenticated;
comment on function private.job_fit_memory_v4_get_dispatch_for_capture(uuid,text,uuid[],text) is
  'Internal current-user lookup returning only the exact completed Memory-fit dispatch fields required by the SECURITY INVOKER capture wrapper.';

-- This is an additive replacement of the original Memory V4 capture RPC.
-- The dispatch lookup now crosses the protected table boundary through the
-- narrowly scoped private helper; all Memory V4 writes remain under the
-- authenticated caller's grants and owner RLS policies.
create or replace function public.capture_job_fit_memory_v4_chunk(p_chunk_id uuid,p_dispatch_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_chunk public.job_fit_memory_v4_chunks;
  v_dispatch record;
  v_provenance jsonb;
  v_anchor jsonb;
  v_response text;
begin
  if v_user is null or not (select private.current_user_active_member()) then raise exception 'Active membership required'; end if;
  select * into v_chunk from public.job_fit_memory_v4_chunks where id=p_chunk_id and user_id=v_user for update;
  if not found then raise exception 'Memory-fit message group not found'; end if;
  if v_chunk.state in ('saving','completed','needs_user') and v_chunk.captured_response is not null then
    if v_chunk.dispatch_id is distinct from p_dispatch_id then raise exception 'A different dispatch is already captured for this message group'; end if;
    return jsonb_build_object('state',v_chunk.state,'idempotent',true);
  end if;
  if v_chunk.state is distinct from 'waiting_for_bridge' or v_chunk.dispatch_id is distinct from p_dispatch_id then raise exception 'Memory-fit message group is not waiting for this exact dispatch'; end if;

  select * into v_dispatch
    from private.job_fit_memory_v4_get_dispatch_for_capture(
      p_dispatch_id,v_chunk.idempotency_key,v_chunk.job_ids,v_chunk.instruction
    );
  if not found or v_dispatch.state is distinct from 'completed'
    or coalesce(v_dispatch.output_refs->>'response_provenance_recorded','false')<>'true'
    or nullif(btrim(v_dispatch.bridge_response),'') is null or v_dispatch.bridge_response_at is null then
    raise exception 'The dispatch is not the exact completed Memory-fit request';
  end if;

  v_provenance:=v_dispatch.response_provenance;
  v_anchor:=coalesce(v_dispatch.delivery_turn_anchor,'{}'::jsonb);
  if jsonb_typeof(v_provenance) is distinct from 'object' or jsonb_typeof(v_anchor) is distinct from 'object'
    or nullif(v_provenance->>'conversationUrl','') is null or nullif(v_provenance->>'userTurnFingerprint','') is null
    or v_provenance->>'generationFinished' is distinct from 'true'
    or v_provenance->>'source' not in ('assistant_turn','assistant_artifact')
    or (v_provenance->>'source'='assistant_turn' and coalesce(nullif(v_provenance->>'assistantMessageId',''),nullif(v_provenance->>'assistantFingerprint','')) is null)
    or (v_provenance->>'source'='assistant_artifact' and nullif(v_provenance->>'artifactKey','') is null)
    or v_anchor->>'conversationUrl' is distinct from v_provenance->>'conversationUrl'
    or (v_dispatch.delivery_user_turn_fingerprint is not null and v_dispatch.delivery_user_turn_fingerprint is distinct from v_provenance->>'userTurnFingerprint')
    or (v_anchor->>'lastAssistantMessageId' is not null and v_anchor->>'lastAssistantMessageId'=v_provenance->>'assistantMessageId')
    or (v_anchor->>'lastAssistantFingerprint' is not null and v_anchor->>'lastAssistantFingerprint'=v_provenance->>'assistantFingerprint')
    or (v_provenance->>'source'='assistant_artifact' and coalesce(v_anchor->'artifactKeys','[]'::jsonb) ? (v_provenance->>'artifactKey')) then
    raise exception 'The dispatch lacks exact sent-user-turn and finished-assistant-turn provenance';
  end if;

  v_response:=v_dispatch.bridge_response;
  update public.job_fit_memory_v4_chunks set state='saving',captured_response=v_response,
    captured_response_hash=encode(extensions.digest(convert_to(v_response,'UTF8'),'sha256'),'hex'),
    captured_response_at=v_dispatch.bridge_response_at,response_provenance=v_provenance,delivery_turn_anchor=v_anchor,
    error_message=null,updated_at=now() where id=v_chunk.id;
  update public.job_fit_memory_v4_items set state='saving',updated_at=now() where chunk_id=v_chunk.id and state='queued';
  update public.job_fit_memory_v4_batches set state='processing',updated_at=now() where id=v_chunk.batch_id;
  return jsonb_build_object('state','saving','idempotent',false);
end;
$$;
revoke all on function public.capture_job_fit_memory_v4_chunk(uuid,uuid) from public,anon,service_role;
grant execute on function public.capture_job_fit_memory_v4_chunk(uuid,uuid) to authenticated;
