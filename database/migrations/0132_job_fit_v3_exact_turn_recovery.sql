-- Forward-only exact-turn recovery for V3 fit tasks. Recovery creates a
-- generic jobs.analyse_selected dispatch marked response_check_only; the
-- Website Bridge inspects the already-sent turn and is never allowed to send.

alter table public.job_fit_v3_tasks
  add column response_check_attempt_count smallint not null default 0
    check (response_check_attempt_count between 0 and 1),
  add column response_check_source_dispatch_id uuid
    references public.chatgpt_dispatch_requests(id) on delete set null;

-- The capture ledger is append-only. Reject stale assistant/artifact identities
-- here as well as in app validation, so a future caller cannot bypass the
-- exact pre-Send boundary.
create or replace function private.job_fit_v3_enforce_exact_turn_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_dispatch public.chatgpt_dispatch_requests;
  v_anchor jsonb;
  v_provenance jsonb;
  v_same_assistant boolean := false;
  v_same_artifact boolean := false;
begin
  select * into v_dispatch
    from public.chatgpt_dispatch_requests
   where id=new.dispatch_id and user_id=new.user_id;
  if not found or v_dispatch.action_type<>'jobs.analyse_selected' then
    raise exception 'The V3 capture is not linked to its owned generic job-analysis dispatch';
  end if;
  v_anchor:=v_dispatch.delivery_turn_anchor;
  v_provenance:=v_dispatch.response_provenance;
  if v_anchor is null or v_provenance is distinct from new.response_provenance then
    raise exception 'The V3 capture does not match its immutable Bridge turn provenance';
  end if;

  if v_provenance->>'source'='assistant_turn' then
    v_same_assistant := (
      nullif(v_anchor->>'lastAssistantMessageId','') is not null
      and v_provenance->>'assistantMessageId'=v_anchor->>'lastAssistantMessageId'
    ) or (
      (nullif(v_anchor->>'lastAssistantMessageId','') is null
        or nullif(v_provenance->>'assistantMessageId','') is null)
      and nullif(v_anchor->>'lastAssistantFingerprint','') is not null
      and v_provenance->>'assistantFingerprint'=v_anchor->>'lastAssistantFingerprint'
    );
  elsif v_provenance->>'source'='assistant_artifact'
    and nullif(v_provenance->>'artifactKey','') is not null
    and jsonb_typeof(v_anchor->'artifactKeys')='array' then
    select exists(
      select 1 from jsonb_array_elements_text(v_anchor->'artifactKeys') k(value)
       where k.value=v_provenance->>'artifactKey'
    ) into v_same_artifact;
  end if;
  if v_same_assistant or v_same_artifact then
    raise exception 'The assistant response already existed at the saved pre-send boundary';
  end if;
  return new;
end;
$$;
revoke all on function private.job_fit_v3_enforce_exact_turn_identity() from public,anon,authenticated,service_role;
drop trigger if exists job_fit_v3_enforce_exact_turn_identity on public.job_fit_v3_captures;
create trigger job_fit_v3_enforce_exact_turn_identity
  before insert on public.job_fit_v3_captures
  for each row execute function private.job_fit_v3_enforce_exact_turn_identity();

create or replace function private.job_fit_v3_create_response_check_internal(
  p_task_id uuid,p_source_dispatch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_task public.job_fit_v3_tasks;
  v_step jsonb;
  v_source public.chatgpt_dispatch_requests;
  v_ticket public.chatgpt_dispatch_requests;
  v_created jsonb;
  v_idempotency_key text;
  v_stale_completed boolean := false;
  v_expired_without_response boolean := false;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_task_id is null or p_source_dispatch_id is null then raise exception 'A saved fit task and source dispatch are required'; end if;

  select * into v_task from public.job_fit_v3_tasks
   where id=p_task_id and user_id=v_user for update;
  if not found then raise exception 'Fit task not found'; end if;

  -- Idempotent recovery after a lost HTTP response must return the same ticket.
  if v_task.response_check_source_dispatch_id=p_source_dispatch_id
    and v_task.response_check_attempt_count=1
    and v_task.state='waiting_for_bridge'
    and v_task.active_dispatch_id is not null then
    select * into v_ticket from public.chatgpt_dispatch_requests
     where id=v_task.active_dispatch_id and user_id=v_user;
    if not found
      or v_ticket.action_type<>'jobs.analyse_selected'
      or v_ticket.subject_refs->>'response_check_for' is distinct from p_source_dispatch_id::text
      or coalesce((v_ticket.progress_json->>'response_check_only')::boolean,false) is not true then
      raise exception 'The existing response-check ticket no longer matches this fit task';
    end if;
    return jsonb_build_object('state',v_task.state,'dispatch_id',v_ticket.id,'correlation_id',v_ticket.correlation_id,'idempotent',true);
  end if;

  if v_task.state<>'needs_user' or v_task.active_dispatch_id is distinct from p_source_dispatch_id
    or v_task.response_check_attempt_count<>0 then
    raise exception 'This fit step is no longer eligible for its one read-only response check';
  end if;
  v_step:=v_task.steps->v_task.current_step_index;
  if jsonb_typeof(v_step) is distinct from 'object'
    or v_step->>'phase' not in ('criteria','context','assessment')
    or nullif(v_step->>'text','') is null
    or nullif(v_step->>'ordinal','') is null then
    raise exception 'The frozen fit step is invalid; start a fresh analysis';
  end if;

  select * into v_source from public.chatgpt_dispatch_requests
   where id=p_source_dispatch_id and user_id=v_user for share;
  if not found or v_source.action_type<>'jobs.analyse_selected'
    or v_source.idempotency_key<>'jobfit-'||v_task.id::text||':'||v_task.attempt_count::text||':'||(v_step->>'ordinal')
    or v_source.subject_refs->'job_ids'<>jsonb_build_array(v_task.job_id::text)
    or coalesce(v_source.website_instruction,v_source.manual_instruction) is distinct from v_step->>'text'
    or v_source.delivery_turn_anchor is null
    or nullif(v_source.delivery_turn_anchor->>'conversationUrl','') is null
    or nullif(v_source.delivery_user_turn_fingerprint,'') is null
    or (v_source.sent_at is null and v_source.send_attempted_at is null and v_source.sent_confirmed_at is null) then
    raise exception 'The saved source is not the exact sent fit step; no new message was sent';
  end if;

  -- Repair only the observed stale-turn failure: the completed assistant ID is
  -- the same ID recorded before Send (or an artifact is explicitly listed in
  -- the pre-send artifact fence). Keep the original immutable dispatch intact.
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

  if not (v_stale_completed or v_expired_without_response) then
    raise exception 'The exact dispatch has no confirmed stale or missing response eligible for read-only recovery';
  end if;
  if exists(select 1 from public.job_fit_v3_captures c
    where c.task_id=v_task.id and c.step_index=v_task.current_step_index) then
    raise exception 'This fit step already has an immutable capture; retry its saved result instead of checking ChatGPT again';
  end if;
  if v_task.attempt_count>=32767 then raise exception 'The fit recovery attempt limit has been reached'; end if;

  v_idempotency_key:='jobfit-'||v_task.id::text||':'||(v_task.attempt_count+1)::text||':'||(v_step->>'ordinal');
  v_created:=public.create_chatgpt_dispatch_request(
    'jobs.analyse_selected',jsonb_build_object('job_ids',jsonb_build_array(v_task.job_id::text)),
    'user_click','Recover completed fit response without resending',v_idempotency_key,80
  );
  if nullif(v_created->>'id','') is null then raise exception 'The generic Website Bridge did not create a response-check ticket'; end if;
  select * into v_ticket from public.chatgpt_dispatch_requests
   where id=(v_created->>'id')::uuid and user_id=v_user for update;
  if not found or v_ticket.action_type<>'jobs.analyse_selected' or v_ticket.idempotency_key<>v_idempotency_key then
    raise exception 'The generic Website Bridge returned a mismatched recovery ticket';
  end if;
  if coalesce(v_created->>'idempotent','false')='true'
    and (v_ticket.subject_refs->>'response_check_for') is distinct from p_source_dispatch_id::text then
    raise exception 'The recovery idempotency key belongs to another source dispatch';
  end if;

  update public.chatgpt_dispatch_requests set
    subject_refs=jsonb_build_object('job_ids',jsonb_build_array(v_task.job_id::text),'response_check_for',p_source_dispatch_id::text),
    website_instruction=v_step->>'text',manual_instruction=v_step->>'text',
    progress_json=jsonb_build_object('stage','queued','protocol','v2','response_check_only',true,'response_check_for',p_source_dispatch_id),
    delivery_turn_anchor=v_source.delivery_turn_anchor,
    delivery_user_turn_fingerprint=v_source.delivery_user_turn_fingerprint,
    delivery_user_turn_message_id=v_source.delivery_user_turn_message_id,
    updated_at=now()
   where id=v_ticket.id and user_id=v_user returning * into v_ticket;

  update public.job_fit_v3_tasks set
    state='waiting_for_bridge',attempt_count=attempt_count+1,active_dispatch_id=v_ticket.id,
    response_check_attempt_count=1,response_check_source_dispatch_id=p_source_dispatch_id,
    error_message=null,finished_at=null,scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
   where id=v_task.id;
  perform private.refresh_job_fit_v3_batch(v_task.batch_id);
  return jsonb_build_object('state','waiting_for_bridge','dispatch_id',v_ticket.id,'correlation_id',v_ticket.correlation_id,'idempotent',false);
end;
$$;
revoke all on function private.job_fit_v3_create_response_check_internal(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_create_response_check_internal(uuid,uuid) to authenticated;

-- The exposed entry point is SECURITY INVOKER. Its narrow user-only helper
-- checks auth.uid(), active membership, exact task ownership and source-turn
-- linkage before it can create or reattach one recovery ticket.
create or replace function public.job_fit_v3_create_response_check(p_task_id uuid,p_source_dispatch_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.job_fit_v3_create_response_check_internal($1,$2); $$;
revoke all on function public.job_fit_v3_create_response_check(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.job_fit_v3_create_response_check(uuid,uuid) to authenticated;
