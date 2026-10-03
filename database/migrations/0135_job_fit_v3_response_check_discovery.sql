-- Discover the newest *actually safe* exact-turn response recovery for the
-- signed-in member. Dispatch rows deliberately have no direct client access,
-- so discovery and its eligibility decision stay inside this narrowly
-- scoped database function. The create-response-check RPC remains the final
-- authority and repeats its locking checks before creating a ticket.

create index if not exists job_fit_v3_tasks_recovery_discovery
  on public.job_fit_v3_tasks(user_id, updated_at desc, id)
  where state in ('needs_user','waiting_for_bridge')
    and (response_check_source_dispatch_id is not null or active_dispatch_id is not null);

create or replace function private.job_fit_v3_find_response_check_candidate_internal()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_task public.job_fit_v3_tasks%rowtype;
  v_source public.chatgpt_dispatch_requests%rowtype;
  v_ticket public.chatgpt_dispatch_requests%rowtype;
  v_step jsonb;
  v_source_id uuid;
  v_source_attempt integer;
  v_retry_after integer;
  v_stale_completed boolean;
  v_expired_without_response boolean;
  v_fallback jsonb;
  v_status text;
  v_reason text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);

  -- The partial owner/recent index keeps this lookup bounded to saved recovery
  -- work. Continue past invalid newer tasks so they cannot hide an older task
  -- whose exact dispatch is still eligible.
  for v_task in
    select * from public.job_fit_v3_tasks
     where user_id=v_user
       and state in ('needs_user','waiting_for_bridge')
       and (response_check_source_dispatch_id is not null or active_dispatch_id is not null)
     order by updated_at desc,id desc
  loop
    v_step := v_task.steps->v_task.current_step_index;
    if jsonb_typeof(v_step) is distinct from 'object'
      or v_step->>'phase' not in ('criteria','context','assessment')
      or nullif(v_step->>'text','') is null
      or nullif(v_step->>'ordinal','') is null then
      if v_task.state='needs_user' and v_fallback is null then
        v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
          'dispatch_id',coalesce(v_task.response_check_source_dispatch_id,v_task.active_dispatch_id),
          'status','ineligible','reason_code','saved_step_invalid','retry_after_seconds',0);
      end if;
      continue;
    end if;

    if v_task.state='waiting_for_bridge' then
      -- Restore only a real active read-only check. Normal analysis sends do
      -- not qualify as response-recovery progress.
      if coalesce(v_task.response_check_attempt_count,0) < 1
        or v_task.response_check_source_dispatch_id is null
        or v_task.active_dispatch_id is null then continue; end if;
      select * into v_source from public.chatgpt_dispatch_requests
       where id=v_task.response_check_source_dispatch_id and user_id=v_user;
      if not found then continue; end if;
      select * into v_ticket from public.chatgpt_dispatch_requests
       where id=v_task.active_dispatch_id and user_id=v_user;
      if not found or v_ticket.action_type is distinct from 'jobs.analyse_selected'
        or v_ticket.idempotency_key is distinct from 'jobfit-'||v_task.id::text||':'||v_task.attempt_count::text||':'||(v_step->>'ordinal')
        or v_ticket.subject_refs->'job_ids' is distinct from jsonb_build_array(v_task.job_id::text)
        or v_ticket.subject_refs->>'response_check_for' is distinct from v_task.response_check_source_dispatch_id::text
        or coalesce((v_ticket.progress_json->>'response_check_only')::boolean,false) is not true
        or v_ticket.website_instruction is distinct from v_step->>'text'
        or v_ticket.delivery_turn_anchor is distinct from v_source.delivery_turn_anchor
        or v_ticket.delivery_user_turn_fingerprint is distinct from v_source.delivery_user_turn_fingerprint
        or v_ticket.state is null
        or v_ticket.state not in ('queued','claimed_by_extension','opening_chatgpt','composer_ready','sent','acknowledged_by_mcp','running') then
        continue;
      end if;
      return jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
        'dispatch_id',v_task.response_check_source_dispatch_id,'status','active_check','reason_code',null,'retry_after_seconds',0);
    end if;

    v_source_id := coalesce(v_task.response_check_source_dispatch_id,v_task.active_dispatch_id);
    if v_source_id is null then continue; end if;

    -- An immutable capture is already durable. It must be resumed from saved
    -- content by the fit worker, never inspected or resent as a new message.
    if exists(select 1 from public.job_fit_v3_captures c
      where c.task_id=v_task.id and c.user_id=v_user and c.step_index=v_task.current_step_index) then
      if v_fallback is null then
        v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
          'dispatch_id',v_source_id,'status','captured','reason_code','response_already_captured','retry_after_seconds',0);
      end if;
      continue;
    end if;

    if coalesce(v_task.response_check_attempt_count,0) >= 4 then
      if v_fallback is null then
        v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
          'dispatch_id',v_source_id,'status','exhausted','reason_code','read_only_checks_exhausted','retry_after_seconds',0);
      end if;
      continue;
    end if;
    if coalesce(v_task.response_check_attempt_count,0) > 0 and v_task.response_check_source_attempt_count is null then
      if v_fallback is null then
        v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
          'dispatch_id',v_source_id,'status','ineligible','reason_code','source_attempt_unproven','retry_after_seconds',0);
      end if;
      continue;
    end if;

    v_source_attempt := coalesce(v_task.response_check_source_attempt_count,v_task.attempt_count);
    select * into v_source from public.chatgpt_dispatch_requests
     where id=v_source_id and user_id=v_user;
    if not found
      or v_source.action_type is distinct from 'jobs.analyse_selected'
      or v_source.idempotency_key is distinct from 'jobfit-'||v_task.id::text||':'||v_source_attempt::text||':'||(v_step->>'ordinal')
      or v_source.subject_refs->'job_ids' is distinct from jsonb_build_array(v_task.job_id::text)
      or coalesce(v_source.website_instruction,v_source.manual_instruction) is distinct from v_step->>'text'
      or v_source.delivery_turn_anchor is null
      or nullif(v_source.delivery_turn_anchor->>'conversationUrl','') is null
      or nullif(v_source.delivery_user_turn_fingerprint,'') is null
      or (v_source.sent_at is null and v_source.send_attempted_at is null and v_source.sent_confirmed_at is null) then
      if v_fallback is null then
        v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
          'dispatch_id',v_source_id,'status','ineligible','reason_code','source_dispatch_mismatch','retry_after_seconds',0);
      end if;
      continue;
    end if;

    v_stale_completed := v_source.state='completed'
      and v_source.bridge_response is not null
      and coalesce((v_source.output_refs->>'response_provenance_recorded')::boolean,false) is true
      and v_source.response_provenance is not null
      and v_source.response_provenance->>'conversationUrl'=v_source.delivery_turn_anchor->>'conversationUrl'
      and v_source.response_provenance->>'userTurnFingerprint'=v_source.delivery_user_turn_fingerprint
      and coalesce((v_source.response_provenance->>'generationFinished')::boolean,false) is true
      and (
        (v_source.response_provenance->>'source'='assistant_turn'
          and nullif(v_source.delivery_turn_anchor->>'lastAssistantMessageId','') is not null
          and v_source.response_provenance->>'assistantMessageId'=v_source.delivery_turn_anchor->>'lastAssistantMessageId')
        or (v_source.response_provenance->>'source'='assistant_artifact'
          and nullif(v_source.response_provenance->>'artifactKey','') is not null
          and jsonb_typeof(v_source.delivery_turn_anchor->'artifactKeys')='array'
          and exists(select 1 from jsonb_array_elements_text(v_source.delivery_turn_anchor->'artifactKeys') k(value)
            where k.value=v_source.response_provenance->>'artifactKey'))
      );

    v_expired_without_response := v_source.bridge_response is null
      and v_source.completed_at is null
      and v_source.delivery_turn_anchor is not null
      and (
        (v_source.state='sent' and v_source.response_deadline_at is not null and v_source.response_deadline_at<=now())
        or (v_source.state='user_required' and coalesce(v_source.error_json->>'code','') in
          ('response_not_captured','response_capture_failed','delivery_uncertain','delivery_lease_expired','delivery_ambiguous','response_capture_timeout'))
      );

    if not coalesce(v_stale_completed,false) and not coalesce(v_expired_without_response,false) then
      if v_fallback is null then
        v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
          'dispatch_id',v_source_id,'status','ineligible','reason_code','response_not_recoverable','retry_after_seconds',0);
      end if;
      continue;
    end if;

    if v_task.attempt_count>=32767 then
      if v_fallback is null then
        v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
          'dispatch_id',v_source_id,'status','ineligible','reason_code','attempt_limit_reached','retry_after_seconds',0);
      end if;
      continue;
    end if;

    v_retry_after := case
      when v_task.response_check_last_requested_at is not null
        and v_task.response_check_last_requested_at>now()-interval '15 seconds'
      then greatest(1,ceil(extract(epoch from (v_task.response_check_last_requested_at+interval '15 seconds'-now())))::integer)
      else 0 end;
    v_status := case when v_retry_after>0 then 'cooldown' else 'eligible' end;
    v_reason := case when v_retry_after>0 then 'read_only_check_cooldown' else null end;
    if v_status='eligible' then
      return jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
        'dispatch_id',v_source_id,'status',v_status,'reason_code',v_reason,'retry_after_seconds',v_retry_after);
    end if;
    if v_fallback is null then
      v_fallback := jsonb_build_object('task_id',v_task.id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
        'dispatch_id',v_source_id,'status',v_status,'reason_code',v_reason,'retry_after_seconds',v_retry_after);
    end if;
  end loop;

  return v_fallback;
end;
$$;

revoke all on function private.job_fit_v3_find_response_check_candidate_internal() from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_find_response_check_candidate_internal() to authenticated;

-- Exposed entry point follows the existing SECURITY INVOKER wrapper pattern.
create or replace function public.job_fit_v3_find_response_check_candidate()
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.job_fit_v3_find_response_check_candidate_internal(); $$;
revoke all on function public.job_fit_v3_find_response_check_candidate() from public,anon,authenticated,service_role;
grant execute on function public.job_fit_v3_find_response_check_candidate() to authenticated;
