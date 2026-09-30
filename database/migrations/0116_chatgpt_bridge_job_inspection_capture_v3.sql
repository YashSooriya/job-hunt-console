-- Persist a strict, v3-proven Website Bridge listing response as soon as the
-- Bridge uploads it. The service-only helper accepts only an already-completed
-- job.inspect_url dispatch and an inspection explicitly linked to that exact
-- dispatch; it delegates the existing owner/membership-checked persistence
-- logic rather than creating a second job-write implementation.

create or replace function private.chatgpt_bridge_apply_job_url_inspection_v3(
  p_dispatch_id uuid,
  p_request_id uuid,
  p_response_hash text,
  p_result_status text,
  p_extraction jsonb,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dispatch public.chatgpt_dispatch_requests;
  v_request public.job_url_inspection_requests;
  v_first_request_id uuid;
  v_user_id uuid;
  v_result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_dispatch_id is null or p_request_id is null then
    raise exception 'A dispatch id and inspection request id are required';
  end if;
  if length(coalesce(p_response_hash, '')) <> 64 then
    raise exception 'A completed v3 response hash is required';
  end if;

  select * into v_dispatch
    from public.chatgpt_dispatch_requests
   where id = p_dispatch_id;
  if not found
     or v_dispatch.action_type <> 'job.inspect_url'
     or v_dispatch.state <> 'completed'
     or v_dispatch.bridge_response is null
     or v_dispatch.response_hash is distinct from p_response_hash
     or encode(extensions.digest(convert_to(btrim(v_dispatch.bridge_response), 'utf8'), 'sha256'), 'hex') is distinct from p_response_hash
     or v_dispatch.response_provenance is null
     or v_dispatch.output_refs->>'response_provenance_recorded' is distinct from 'true' then
    raise exception 'A completed, exact-turn v3 job-inspection response is required';
  end if;
  perform private.chatgpt_validate_response_provenance(v_dispatch.response_provenance, v_dispatch);

  v_user_id := v_dispatch.user_id;
  perform private.assert_active_app_membership(v_user_id);

  select id into v_first_request_id
    from public.job_url_inspection_requests
   where user_id = v_user_id
     and dispatch_request_id = p_dispatch_id
   order by batch_position nulls first, created_at, id
   limit 1;
  if v_first_request_id is null
     or v_dispatch.subject_refs->>'inspection_id' is distinct from v_first_request_id::text then
    raise exception 'The completed bridge dispatch is not linked to its exact inspection batch';
  end if;

  select * into v_request
    from public.job_url_inspection_requests
   where id = p_request_id
     and user_id = v_user_id
     and dispatch_request_id = p_dispatch_id
   for update;
  if not found then
    raise exception 'Inspection request is not linked to this completed bridge dispatch';
  end if;
  if v_request.status = 'completed' then
    return jsonb_build_object('request_id', v_request.id, 'status', v_request.status, 'job_id', v_request.job_id, 'idempotent', true);
  end if;

  -- The legacy owner-scoped persistence routines intentionally require
  -- auth.uid(). This service-only helper has already proven dispatch and
  -- inspection ownership, so provide that user identity only for the current
  -- database transaction before delegating to those existing routines.
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user_id, 'role', 'service_role')::text, true);

  if p_result_status = 'found' then
    if jsonb_typeof(p_extraction) is distinct from 'object'
       or p_extraction->>'request_id' is distinct from p_request_id::text then
      raise exception 'The extracted listing does not match its inspection request';
    end if;
    if v_request.status in ('failed', 'user_required') then
      update public.job_url_inspection_requests
         set status = 'processing', error_json = null, updated_at = now()
       where id = p_request_id and user_id = v_user_id;
    end if;
    v_result := private.complete_job_url_inspection_for_user(
      v_user_id, p_request_id, p_extraction, 'chatgpt_direct', null
    );
    return v_result || jsonb_build_object('captured_v3_result', true);
  end if;

  if p_result_status not in ('unavailable', 'not_a_job_listing', 'invalid_response') then
    raise exception 'Unsupported captured listing result status';
  end if;
  if length(coalesce(p_message, '')) < 1 or length(p_message) > 2000 then
    raise exception 'A bounded explanation is required for an unavailable listing';
  end if;
  v_result := private.mark_job_url_inspection_failed_for_user(
    v_user_id, p_request_id, p_message, false
  );
  return v_result || jsonb_build_object('captured_v3_result', true);
end;
$$;

revoke all on function private.chatgpt_bridge_apply_job_url_inspection_v3(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function private.chatgpt_bridge_apply_job_url_inspection_v3(uuid, uuid, text, text, jsonb, text)
  to service_role;

-- PostgREST exposes only the narrow SECURITY INVOKER service wrapper. The
-- actual write authority stays in the private helper above and is available
-- only to service_role; no user-facing role can invoke either boundary.
create or replace function public.chatgpt_bridge_service_apply_job_url_inspection_v3(
  p_dispatch_id uuid,
  p_request_id uuid,
  p_response_hash text,
  p_result_status text,
  p_extraction jsonb,
  p_message text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  return private.chatgpt_bridge_apply_job_url_inspection_v3(
    p_dispatch_id, p_request_id, p_response_hash, p_result_status, p_extraction, p_message
  );
end;
$$;

revoke all on function public.chatgpt_bridge_service_apply_job_url_inspection_v3(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.chatgpt_bridge_service_apply_job_url_inspection_v3(uuid, uuid, text, text, jsonb, text)
  to service_role;

comment on function public.chatgpt_bridge_service_apply_job_url_inspection_v3(uuid, uuid, text, text, jsonb, text) is
  'Persists one listing from an already-completed, exact-turn-v3 Website Bridge dispatch; available only to service_role.';
