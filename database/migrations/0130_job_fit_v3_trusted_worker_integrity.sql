-- Forward-only hardening for V3. Keep the v3 Website Bridge protocol and
-- migration 0101 untouched; all ChatGPT requests remain generic dispatches.

create table public.job_fit_v3_inputs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.job_fit_v3_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  generation integer not null check (generation > 0),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  input_payload jsonb not null check (jsonb_typeof(input_payload)='object' and octet_length(input_payload::text)<=1000000),
  steps jsonb not null check (jsonb_typeof(steps)='array' and jsonb_array_length(steps) between 1 and 500 and octet_length(steps::text)<=2000000),
  created_at timestamptz not null default now(),
  unique(task_id,generation),
  unique(task_id,id)
);

alter table public.job_fit_v3_tasks
  add column current_input_id uuid,
  add column input_generation integer not null default 1 check(input_generation>0),
  add column conversation_url text,
  add column scheduler_lease_token uuid,
  add column scheduler_lease_expires_at timestamptz,
  add column safe_unsent_retry_count smallint not null default 0 check(safe_unsent_retry_count between 0 and 1);

-- Criteria preparation adds frozen context and final-assessment steps after
-- every source unit has been reviewed. Give that complete plan the same
-- explicit upper bound as the append-only input ledger.
alter table public.job_fit_v3_tasks drop constraint job_fit_v3_tasks_steps_check;
alter table public.job_fit_v3_tasks add constraint job_fit_v3_tasks_steps_check
  check (jsonb_typeof(steps)='array' and jsonb_array_length(steps) between 1 and 500 and octet_length(steps::text)<=2000000);

insert into public.job_fit_v3_inputs(task_id,user_id,generation,input_hash,input_payload,steps,created_at)
select id,user_id,1,input_hash,input_payload,steps,created_at
  from public.job_fit_v3_tasks
on conflict(task_id,generation) do nothing;
update public.job_fit_v3_tasks t
   set current_input_id=i.id
  from public.job_fit_v3_inputs i
 where i.task_id=t.id and i.generation=1 and t.current_input_id is null;
alter table public.job_fit_v3_tasks
  add constraint job_fit_v3_tasks_current_input_owner_fk
  foreign key(id,current_input_id) references public.job_fit_v3_inputs(task_id,id)
  on delete set null (current_input_id) deferrable initially immediate;

create table public.job_fit_v3_captures (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.job_fit_v3_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_index integer not null check(step_index>=0),
  attempt_count integer not null check(attempt_count>0),
  dispatch_id uuid not null references public.chatgpt_dispatch_requests(id) on delete cascade,
  phase text not null check(phase in ('criteria','context','assessment')),
  response_hash text not null check(response_hash ~ '^[0-9a-f]{64}$'),
  bridge_response text not null check(length(bridge_response)<=250000),
  conversation_url text not null check(length(conversation_url) between 1 and 500),
  response_provenance jsonb not null check(jsonb_typeof(response_provenance)='object'),
  captured_at timestamptz not null default now(),
  unique(task_id,dispatch_id),
  unique(task_id,step_index)
);

create table public.job_fit_v3_results (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references public.job_fit_v3_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
  result_json jsonb not null check(jsonb_typeof(result_json)='object' and octet_length(result_json::text)<=1000000),
  -- Keep the historical ID without an FK action: this result row is immutable
  -- and must not be rewritten by a later deletion of an analysis projection.
  analysis_id uuid,
  created_at timestamptz not null default now()
);

create table public.job_fit_v3_evidence_references (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references public.job_fit_v3_results(id) on delete cascade,
  task_id uuid not null references public.job_fit_v3_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_reference text not null,
  evidence_reference text not null,
  quote text not null,
  created_at timestamptz not null default now(),
  unique(result_id,analysis_reference,evidence_reference,quote)
);

insert into public.job_fit_v3_results(task_id,user_id,input_hash,result_json,analysis_id,created_at)
select id,user_id,input_hash,result_json,analysis_id,coalesce(finished_at,updated_at,created_at)
  from public.job_fit_v3_tasks where result_json is not null
on conflict(task_id) do nothing;
insert into public.job_fit_v3_evidence_references(result_id,task_id,user_id,analysis_reference,evidence_reference,quote)
select r.id,r.task_id,r.user_id,requirement->>'analysis_reference',evidence->>'reference',evidence->>'quote'
  from public.job_fit_v3_results r
  cross join lateral jsonb_array_elements(case when jsonb_typeof(r.result_json->'requirements')='array' then r.result_json->'requirements' else '[]'::jsonb end) requirement
  cross join lateral jsonb_array_elements(case when jsonb_typeof(requirement->'evidence_quotes')='array' then requirement->'evidence_quotes' else '[]'::jsonb end) evidence
 where jsonb_typeof(requirement)='object'
   and jsonb_typeof(evidence)='object'
   and nullif(requirement->>'analysis_reference','') is not null
   and nullif(evidence->>'reference','') is not null
   and nullif(evidence->>'quote','') is not null
on conflict(result_id,analysis_reference,evidence_reference,quote) do nothing;

create index job_fit_v3_inputs_owner_task on public.job_fit_v3_inputs(user_id,task_id,generation);
create index job_fit_v3_captures_owner_task on public.job_fit_v3_captures(user_id,task_id,step_index);
create index job_fit_v3_results_owner_recent on public.job_fit_v3_results(user_id,created_at desc);
create index job_fit_v3_evidence_owner_task on public.job_fit_v3_evidence_references(user_id,task_id,analysis_reference);
create index job_fit_v3_tasks_scheduler on public.job_fit_v3_tasks(state,scheduler_lease_expires_at,created_at)
  where state in ('queued','waiting_for_bridge','saving');

alter table public.job_fit_v3_inputs enable row level security;
alter table public.job_fit_v3_captures enable row level security;
alter table public.job_fit_v3_results enable row level security;
alter table public.job_fit_v3_evidence_references enable row level security;

revoke all on public.job_fit_v3_batches,public.job_fit_v3_tasks,
  public.job_fit_v3_inputs,public.job_fit_v3_captures,
  public.job_fit_v3_results,public.job_fit_v3_evidence_references
  from public,anon,authenticated,service_role;
drop policy if exists job_fit_v3_batches_owner_insert on public.job_fit_v3_batches;
drop policy if exists job_fit_v3_batches_owner_update on public.job_fit_v3_batches;
drop policy if exists job_fit_v3_tasks_owner_insert on public.job_fit_v3_tasks;
drop policy if exists job_fit_v3_tasks_owner_update on public.job_fit_v3_tasks;
create policy job_fit_v3_inputs_owner_select on public.job_fit_v3_inputs
  for select to authenticated using(user_id=(select auth.uid()) and (select private.current_user_active_member())
    and exists(select 1 from public.job_fit_v3_tasks t where t.id=task_id and t.user_id=(select auth.uid())));
create policy job_fit_v3_captures_owner_select on public.job_fit_v3_captures
  for select to authenticated using(user_id=(select auth.uid()) and (select private.current_user_active_member())
    and exists(select 1 from public.job_fit_v3_tasks t where t.id=task_id and t.user_id=(select auth.uid())));
create policy job_fit_v3_results_owner_select on public.job_fit_v3_results
  for select to authenticated using(user_id=(select auth.uid()) and (select private.current_user_active_member())
    and exists(select 1 from public.job_fit_v3_tasks t where t.id=task_id and t.user_id=(select auth.uid())));
create policy job_fit_v3_evidence_owner_select on public.job_fit_v3_evidence_references
  for select to authenticated using(user_id=(select auth.uid()) and (select private.current_user_active_member())
    and exists(select 1 from public.job_fit_v3_tasks t where t.id=task_id and t.user_id=(select auth.uid())));

grant select on public.job_fit_v3_batches,public.job_fit_v3_tasks,
  public.job_fit_v3_inputs,public.job_fit_v3_captures,
  public.job_fit_v3_results,public.job_fit_v3_evidence_references to authenticated;

-- Existing rows remain queryable. Owner direct DML is deliberately removed;
-- the legacy user RPCs are now callable only from the trusted worker internals.
revoke all on function public.create_job_fit_v3_batch(uuid,text,uuid[],jsonb) from public,anon,authenticated,service_role;
revoke all on function public.save_job_fit_v3_result(uuid) from public,anon,authenticated,service_role;

create or replace function private.job_fit_v3_immutable_row()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
  raise exception 'V3 frozen inputs, response captures, results and evidence references are append-only';
end;
$$;
revoke all on function private.job_fit_v3_immutable_row() from public,anon,authenticated,service_role;
create trigger job_fit_v3_inputs_append_only before update or delete on public.job_fit_v3_inputs
  for each row execute function private.job_fit_v3_immutable_row();
create trigger job_fit_v3_captures_append_only before update or delete on public.job_fit_v3_captures
  for each row execute function private.job_fit_v3_immutable_row();
create trigger job_fit_v3_results_append_only before update or delete on public.job_fit_v3_results
  for each row execute function private.job_fit_v3_immutable_row();
create trigger job_fit_v3_evidence_append_only before update or delete on public.job_fit_v3_evidence_references
  for each row execute function private.job_fit_v3_immutable_row();

create or replace function private.refresh_job_fit_v3_batch(p_batch_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_state text;
begin
  update public.job_fit_v3_batches b set state=case
      when exists(select 1 from public.job_fit_v3_tasks t where t.batch_id=b.id and t.state in ('queued','waiting_for_bridge','saving')) then 'processing'
      when exists(select 1 from public.job_fit_v3_tasks t where t.batch_id=b.id and t.state in ('failed','needs_user','cancelled')) then 'partial'
      else 'completed' end,
    updated_at=now()
   where b.id=p_batch_id returning b.state into v_state;
  return v_state;
end;
$$;
revoke all on function private.refresh_job_fit_v3_batch(uuid) from public,anon,authenticated,service_role;

create or replace function private.job_fit_v3_worker_create_batch_internal(
  p_user_id uuid,p_request_id uuid,p_mode text,p_job_ids uuid[],p_tasks jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_batch_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_user_id is null then raise exception 'User is required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  v_result:=public.create_job_fit_v3_batch(p_request_id,p_mode,p_job_ids,p_tasks);
  v_batch_id:=(v_result->>'batch_id')::uuid;
  insert into public.job_fit_v3_inputs(task_id,user_id,generation,input_hash,input_payload,steps)
  select t.id,t.user_id,1,t.input_hash,t.input_payload,t.steps
    from public.job_fit_v3_tasks t where t.batch_id=v_batch_id
  on conflict(task_id,generation) do nothing;
  update public.job_fit_v3_tasks t set current_input_id=i.id
    from public.job_fit_v3_inputs i
   where i.task_id=t.id and i.generation=1 and t.batch_id=v_batch_id and t.current_input_id is null;
  return v_result;
end;
$$;
revoke all on function private.job_fit_v3_worker_create_batch_internal(uuid,uuid,text,uuid[],jsonb) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_create_batch_internal(uuid,uuid,text,uuid[],jsonb) to service_role;

create or replace function private.job_fit_v3_save_result_internal(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_task public.job_fit_v3_tasks; v_result_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  if p_lease_token is null then raise exception 'A fit scheduler lease is required to publish a captured result'; end if;
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id for update;
  if not found then raise exception 'Fit task not found'; end if;
  if v_task.scheduler_lease_token is distinct from p_lease_token
    or v_task.scheduler_lease_expires_at is null or v_task.scheduler_lease_expires_at<=now() then
    raise exception 'Fit scheduler lease expired before result publication';
  end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  v_result:=public.save_job_fit_v3_result(p_task_id);
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id;
  if v_task.state='completed' and v_task.result_json is not null then
    insert into public.job_fit_v3_results(task_id,user_id,input_hash,result_json,analysis_id)
    values(v_task.id,v_task.user_id,v_task.input_hash,v_task.result_json,v_task.analysis_id)
    on conflict(task_id) do nothing returning id into v_result_id;
    if v_result_id is null then select id into v_result_id from public.job_fit_v3_results where task_id=v_task.id; end if;
    insert into public.job_fit_v3_evidence_references(result_id,task_id,user_id,analysis_reference,evidence_reference,quote)
    select v_result_id,v_task.id,v_task.user_id,requirement->>'analysis_reference',evidence->>'reference',evidence->>'quote'
      from jsonb_array_elements(v_task.result_json->'requirements') requirement
      cross join lateral jsonb_array_elements(coalesce(requirement->'evidence_quotes','[]'::jsonb)) evidence
     where jsonb_typeof(evidence)='object'
    on conflict(result_id,analysis_reference,evidence_reference,quote) do nothing;
  end if;
  update public.job_fit_v3_tasks set scheduler_lease_token=null,scheduler_lease_expires_at=null where id=p_task_id and user_id=p_user_id;
  return v_result;
end;
$$;
revoke all on function private.job_fit_v3_save_result_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_save_result_internal(uuid,uuid,uuid) to service_role;

create or replace function private.job_fit_v3_worker_transition_internal(
  p_user_id uuid,p_task_id uuid,p_expected_state text,p_expected_step_index integer,
  p_dispatch_id uuid,p_action text,p_error text default null,
  p_input_payload jsonb default null,p_steps jsonb default null,p_input_hash text default null,
  p_result_json jsonb default null,p_capture jsonb default null,p_lease_token uuid default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_task public.job_fit_v3_tasks;
  v_dispatch public.chatgpt_dispatch_requests;
  v_step jsonb;
  v_state text;
  v_phase text;
  v_next integer;
  v_conversation text;
  v_result jsonb;
  v_capture_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id for update;
  if not found then raise exception 'Fit task not found'; end if;
  if v_task.state is distinct from p_expected_state or v_task.current_step_index is distinct from p_expected_step_index then
    raise exception 'Fit task changed before the requested transition';
  end if;
  if p_lease_token is null then
    if v_task.scheduler_lease_token is not null and v_task.scheduler_lease_expires_at>now() then
      raise exception 'The fit task is currently leased to the background scheduler';
    end if;
  elsif v_task.scheduler_lease_token is distinct from p_lease_token
    or v_task.scheduler_lease_expires_at is null or v_task.scheduler_lease_expires_at<=now() then
    raise exception 'Fit scheduler lease expired before the requested transition';
  end if;
  if p_action in ('attach','mark_waiting') then
    if p_dispatch_id is null then raise exception 'The fit task is not attached to this dispatch'; end if;
    if p_action='mark_waiting' and (v_task.state<>'needs_user' or v_task.active_dispatch_id is distinct from p_dispatch_id) then
      raise exception 'The saved unsent retry is not attached to the exact blocked fit step';
    end if;
    if p_action='attach' and (v_task.state<>'queued' or v_task.active_dispatch_id is not null) then
      raise exception 'Only an unassigned queued fit task can attach a dispatch';
    end if;
    v_step:=v_task.steps->v_task.current_step_index;
    select * into v_dispatch from public.chatgpt_dispatch_requests where id=p_dispatch_id and user_id=p_user_id;
    if not found or v_dispatch.action_type<>'jobs.analyse_selected'
      or v_dispatch.idempotency_key<>'jobfit-'||v_task.id::text||':'||v_task.attempt_count::text||':'||(v_step->>'ordinal')
      or v_dispatch.subject_refs->'job_ids'<>jsonb_build_array(v_task.job_id::text)
      or coalesce(v_dispatch.website_instruction,v_dispatch.manual_instruction) is distinct from v_step->>'text' then
      raise exception 'The dispatch does not match the exact saved fit step';
    end if;
    if p_action='mark_waiting' and v_dispatch.state not in ('queued','claimed_by_extension','opening_chatgpt','composer_ready','sent','running','completed') then
      raise exception 'The generic Bridge dispatch is not resumable';
    end if;
    if p_action='mark_waiting' then
      if v_task.state<>'needs_user' or p_lease_token is not null or v_task.safe_unsent_retry_count>=1
        or v_dispatch.state<>'queued' or v_dispatch.progress_json->>'protocol'<>'v2'
        or v_dispatch.progress_json->>'stage'<>'requeued_by_user'
        or v_dispatch.sent_at is not null or v_dispatch.send_attempted_at is not null
        or v_dispatch.sent_confirmed_at is not null or v_dispatch.delivery_turn_anchor is not null
        or v_dispatch.response_hash is not null or v_dispatch.bridge_response is not null then
        raise exception 'Only one server-confirmed unsent V2 dispatch may resume this fit step';
      end if;
    end if;
    update public.job_fit_v3_tasks set state='waiting_for_bridge',active_dispatch_id=p_dispatch_id,error_message=null,finished_at=null,
      safe_unsent_retry_count=safe_unsent_retry_count+case when p_action='mark_waiting' then 1 else 0 end,
      scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
      where id=v_task.id;
    v_state:='waiting_for_bridge';
  elsif p_action in ('needs_user','failed') then
    if p_dispatch_id is not null and v_task.active_dispatch_id is distinct from p_dispatch_id then raise exception 'The terminal update does not match the active dispatch'; end if;
    update public.job_fit_v3_tasks set state=p_action,error_message=left(coalesce(p_error,'Fit analysis needs review.'),1000),finished_at=now(),
      scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
      where id=v_task.id;
    v_state:=p_action;
  elsif p_action in ('capture_context','capture_criteria','capture_assessment') then
    if p_dispatch_id is null or v_task.state<>'waiting_for_bridge' or v_task.active_dispatch_id is distinct from p_dispatch_id then
      if exists(select 1 from public.job_fit_v3_captures c where c.task_id=v_task.id and c.dispatch_id=p_dispatch_id) then
        return jsonb_build_object('state',v_task.state,'idempotent',true);
      end if;
      raise exception 'The captured response is not attached to the active frozen fit step';
    end if;
    v_step:=v_task.steps->v_task.current_step_index;
    v_phase:=case p_action when 'capture_context' then 'context' when 'capture_criteria' then 'criteria' else 'assessment' end;
    if v_step->>'phase' is distinct from v_phase then raise exception 'The response phase differs from the saved fit step'; end if;
    select * into v_dispatch from public.chatgpt_dispatch_requests where id=p_dispatch_id and user_id=p_user_id for share;
    if not found or v_dispatch.state<>'completed' or v_dispatch.action_type<>'jobs.analyse_selected'
      or v_dispatch.idempotency_key<>'jobfit-'||v_task.id::text||':'||v_task.attempt_count::text||':'||(v_step->>'ordinal')
      or v_dispatch.subject_refs->'job_ids'<>jsonb_build_array(v_task.job_id::text)
      or v_dispatch.bridge_response is null or length(v_dispatch.bridge_response)>250000 or v_dispatch.response_hash is null
      or coalesce((v_dispatch.output_refs->>'response_provenance_recorded')::boolean,false) is not true
      or v_dispatch.response_provenance is null or v_dispatch.delivery_turn_anchor is null
      or v_dispatch.response_provenance->>'conversationUrl' is distinct from v_dispatch.delivery_turn_anchor->>'conversationUrl'
      or v_dispatch.response_provenance->>'userTurnFingerprint' is distinct from v_dispatch.delivery_user_turn_fingerprint
      or nullif(v_dispatch.response_provenance->>'userTurnFingerprint','') is null
      or nullif(v_dispatch.delivery_user_turn_fingerprint,'') is null
      or coalesce((v_dispatch.response_provenance->>'generationFinished')::boolean,false) is not true then
      raise exception 'The completed Bridge result lacks exact response provenance';
    end if;
    if (v_dispatch.response_provenance->>'source'='assistant_turn'
        and nullif(v_dispatch.response_provenance->>'assistantMessageId','') is null
        and nullif(v_dispatch.response_provenance->>'assistantFingerprint','') is null)
      or (v_dispatch.response_provenance->>'source'='assistant_artifact'
        and nullif(v_dispatch.response_provenance->>'artifactKey','') is null) then
      raise exception 'The completed Bridge result has no assistant-turn identity';
    end if;
    v_conversation:=v_dispatch.response_provenance->>'conversationUrl';
    if v_task.conversation_url is not null and v_task.conversation_url is distinct from v_conversation then
      raise exception 'The fit task changed conversations; replay context in a new attempt';
    end if;
    if p_capture is null or p_capture->>'response_text' is distinct from v_dispatch.bridge_response
      or p_capture->>'response_hash' is distinct from v_dispatch.response_hash
      or p_capture->'response_provenance' is distinct from v_dispatch.response_provenance then
      raise exception 'The saved capture differs from the exact completed Bridge response';
    end if;
    if (v_phase='context' and length(v_dispatch.bridge_response)>100)
      or (v_phase='criteria' and length(v_dispatch.bridge_response)>20000) then
      raise exception 'The captured response exceeds this phase safe size';
    end if;
    insert into public.job_fit_v3_captures(task_id,user_id,step_index,attempt_count,dispatch_id,phase,response_hash,bridge_response,conversation_url,response_provenance)
    values(v_task.id,v_task.user_id,v_task.current_step_index,v_task.attempt_count,p_dispatch_id,v_phase,v_dispatch.response_hash,v_dispatch.bridge_response,v_conversation,v_dispatch.response_provenance)
    on conflict(task_id,dispatch_id) do nothing returning id into v_capture_id;
    if v_capture_id is null then return jsonb_build_object('state',v_task.state,'idempotent',true); end if;
    v_next:=v_task.current_step_index+1;
    if p_action in ('capture_context','capture_criteria') then
      if p_action='capture_criteria' then
        if p_input_payload is not null then
          if jsonb_typeof(p_input_payload)<>'object' or p_steps is null or jsonb_typeof(p_steps)<>'array'
            or p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$'
            or (p_input_payload->'fit_input'->>'job_id') is distinct from v_task.job_id::text
            or jsonb_array_length(p_steps)<=v_next then
            raise exception 'Prepared criteria did not provide a valid frozen assessment input';
          end if;
          if v_task.steps->v_next is not null and v_task.steps->v_next->>'phase'='criteria' then
            raise exception 'Prepared assessment input was supplied before all source units were reviewed';
          end if;
          if not exists(select 1 from jsonb_array_elements(p_steps) step where step->>'phase' in ('context','assessment')) then
            raise exception 'Prepared assessment steps are missing';
          end if;
          insert into public.job_fit_v3_inputs(task_id,user_id,generation,input_hash,input_payload,steps)
          values(v_task.id,v_task.user_id,v_task.input_generation+1,p_input_hash,p_input_payload,p_steps);
          update public.job_fit_v3_tasks set state='queued',current_step_index=v_next,active_dispatch_id=null,
            captured_responses=captured_responses||jsonb_build_array(jsonb_build_object('dispatch_id',p_dispatch_id,'step_index',v_task.current_step_index,'response_hash',v_dispatch.response_hash,'conversation_url',v_conversation)),
            conversation_url=coalesce(conversation_url,v_conversation),input_payload=p_input_payload,steps=p_steps,input_hash=p_input_hash,
            input_generation=input_generation+1,current_input_id=(select i.id from public.job_fit_v3_inputs i where i.task_id=v_task.id and i.generation=v_task.input_generation+1),
            scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now(),error_message=null where id=v_task.id;
        else
          if p_steps is not null or p_input_hash is not null then raise exception 'Partial frozen-input update is not allowed'; end if;
          if v_task.steps->v_next is null or v_task.steps->v_next->>'phase' is distinct from 'criteria' then
            raise exception 'The final source unit must freeze the prepared assessment input';
          end if;
          update public.job_fit_v3_tasks set state='queued',current_step_index=v_next,active_dispatch_id=null,
            captured_responses=captured_responses||jsonb_build_array(jsonb_build_object('dispatch_id',p_dispatch_id,'step_index',v_task.current_step_index,'response_hash',v_dispatch.response_hash,'conversation_url',v_conversation)),
            conversation_url=coalesce(conversation_url,v_conversation),scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now(),error_message=null where id=v_task.id;
        end if;
      else
        update public.job_fit_v3_tasks set state='queued',current_step_index=v_next,active_dispatch_id=null,
          captured_responses=captured_responses||jsonb_build_array(jsonb_build_object('dispatch_id',p_dispatch_id,'step_index',v_task.current_step_index,'response_hash',v_dispatch.response_hash,'conversation_url',v_conversation)),
          conversation_url=coalesce(conversation_url,v_conversation),scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now(),error_message=null where id=v_task.id;
      end if;
      v_state:='queued';
    else
      if p_result_json is null or jsonb_typeof(p_result_json)<>'object' then raise exception 'The validated fit result is missing'; end if;
      update public.job_fit_v3_tasks set state='saving',active_dispatch_id=null,
        captured_responses=captured_responses||jsonb_build_array(jsonb_build_object('dispatch_id',p_dispatch_id,'step_index',v_task.current_step_index,'response_hash',v_dispatch.response_hash,'conversation_url',v_conversation)),
        conversation_url=coalesce(conversation_url,v_conversation),result_json=p_result_json,scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now(),error_message=null where id=v_task.id;
      v_state:='saving';
    end if;
  elsif p_action='save' then
    v_result:=private.job_fit_v3_save_result_internal(p_user_id,v_task.id,p_lease_token);
    v_state:=coalesce(v_result->>'state',v_task.state);
  else
    raise exception 'Unsupported V3 worker transition';
  end if;
  if v_state in ('needs_user','failed') then
    update public.job_fit_v3_tasks set scheduler_lease_token=null,scheduler_lease_expires_at=null where id=v_task.id;
  end if;
  perform private.refresh_job_fit_v3_batch(v_task.batch_id);
  return jsonb_build_object('state',v_state,'capture_id',v_capture_id,'analysis_id',v_result->>'analysis_id','idempotent',false);
end;
$$;
revoke all on function private.job_fit_v3_worker_transition_internal(uuid,uuid,text,integer,uuid,text,text,jsonb,jsonb,text,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_transition_internal(uuid,uuid,text,integer,uuid,text,text,jsonb,jsonb,text,jsonb,jsonb,uuid) to service_role;

create or replace function public.job_fit_v3_worker_create_batch(
  p_user_id uuid,p_request_id uuid,p_mode text,p_job_ids uuid[],p_tasks jsonb
)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin return private.job_fit_v3_worker_create_batch_internal($1,$2,$3,$4,$5); end;
$$;
revoke all on function public.job_fit_v3_worker_create_batch(uuid,uuid,text,uuid[],jsonb) from public,anon,authenticated,service_role;
grant execute on function public.job_fit_v3_worker_create_batch(uuid,uuid,text,uuid[],jsonb) to service_role;

create or replace function public.job_fit_v3_worker_transition(
  p_user_id uuid,p_task_id uuid,p_expected_state text,p_expected_step_index integer,
  p_dispatch_id uuid,p_action text,p_error text default null,
  p_input_payload jsonb default null,p_steps jsonb default null,p_input_hash text default null,
  p_result_json jsonb default null,p_capture jsonb default null,p_lease_token uuid default null
)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin return private.job_fit_v3_worker_transition_internal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13); end;
$$;
revoke all on function public.job_fit_v3_worker_transition(uuid,uuid,text,integer,uuid,text,text,jsonb,jsonb,text,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.job_fit_v3_worker_transition(uuid,uuid,text,integer,uuid,text,text,jsonb,jsonb,text,jsonb,jsonb,uuid) to service_role;

create or replace function public.job_fit_v3_worker_save_result(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin return private.job_fit_v3_save_result_internal($1,$2,$3); end;
$$;
revoke all on function public.job_fit_v3_worker_save_result(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.job_fit_v3_worker_save_result(uuid,uuid,uuid) to service_role;

-- Add the immutable exact-turn proof to the authenticated status response.
create or replace function public.get_chatgpt_dispatch_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.chatgpt_dispatch_requests;
  v_protocol text;
  v_response_check_available boolean;
  v_retry_allowed boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select * into v_request from public.chatgpt_dispatch_requests where id=p_request_id and user_id=v_user;
  if not found then raise exception 'Dispatch request not found'; end if;
  v_protocol:=coalesce(nullif(v_request.progress_json->>'protocol',''),case when v_request.delivery_attempt_id is null then 'v1' else 'v2' end);
  v_response_check_available:=v_request.action_type='profile.background'
    and coalesce((v_request.progress_json->>'response_check_only')::boolean,false) is not true
    and v_request.state in ('user_required','sent') and v_request.bridge_response is null and v_request.completed_at is null
    and v_request.delivery_turn_anchor is not null
    and (v_request.state='sent' or coalesce(v_request.error_json->>'code','') in ('response_not_captured','response_capture_failed','delivery_uncertain','delivery_lease_expired','delivery_ambiguous','response_capture_timeout'));
  v_retry_allowed:=v_request.state in ('user_required','failed','expired') and v_request.attempt_count<5
    and v_request.sent_at is null and v_request.send_attempted_at is null and v_request.delivery_turn_anchor is null
    and not(v_protocol<>'v2' and v_request.state='user_required' and coalesce(v_request.error_json->>'code','') in ('delivery_uncertain','delivery_lease_expired','delivery_ambiguous'));
  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,'action_version',v_request.action_version,
    'display_title',v_request.display_title,'origin',v_request.origin,'subject_refs',v_request.subject_refs,
    'idempotency_key',v_request.idempotency_key,'priority',v_request.priority,'confirmation_policy',v_request.confirmation_policy,
    'allowed_effects',v_request.allowed_effects,'required_mcp_tools',v_request.required_mcp_tools,'expected_outputs',v_request.expected_outputs,
    'attempt_count',v_request.attempt_count,'target_device_id',v_request.target_device_id,'progress',v_request.progress_json,
    'output_refs',v_request.output_refs,'error',v_request.error_json,'website_instruction',coalesce(v_request.website_instruction,v_request.manual_instruction),
    'manual_instruction',v_request.manual_instruction,'mcp_fallback_instruction',coalesce(v_request.mcp_fallback_instruction,private.chatgpt_build_mcp_fallback_instruction(v_request.id)),
    'bridge_response',v_request.bridge_response,'bridge_response_at',v_request.bridge_response_at,'response_hash',v_request.response_hash,
    'response_provenance',v_request.response_provenance,'delivery_turn_anchor',v_request.delivery_turn_anchor,
    'delivery_user_turn_fingerprint',v_request.delivery_user_turn_fingerprint,'delivery_user_turn_message_id',v_request.delivery_user_turn_message_id,
    'correlation_id',v_request.correlation_id,'created_at',v_request.created_at,'claimed_at',v_request.claimed_at,
    'sent_at',v_request.sent_at,'send_attempted_at',v_request.send_attempted_at,'sent_confirmed_at',v_request.sent_confirmed_at,
    'protocol',v_protocol,'has_delivery_turn_anchor',v_request.delivery_turn_anchor is not null,
    'response_check_available',v_response_check_available,'retry_allowed',v_retry_allowed,
    'manual_review_required',(v_request.state='user_required' and not v_response_check_available and not v_retry_allowed),
    'delivery_deadline_at',v_request.delivery_deadline_at,'response_deadline_at',v_request.response_deadline_at,
    'acknowledged_at',v_request.acknowledged_at,'running_at',v_request.running_at,'completed_at',v_request.completed_at,
    'user_required_at',v_request.user_required_at,'failed_at',v_request.failed_at,'cancelled_at',v_request.cancelled_at,
    'expires_at',v_request.expires_at,'updated_at',v_request.updated_at
  );
end;
$$;
revoke all on function public.get_chatgpt_dispatch_request(uuid) from public,anon;
grant execute on function public.get_chatgpt_dispatch_request(uuid) to authenticated;

comment on table public.job_fit_v3_inputs is 'Append-only frozen profile, listing and step snapshots for V3 fit attempts.';
comment on table public.job_fit_v3_captures is 'Append-only exact Website Bridge response captures with v3 turn provenance.';
comment on table public.job_fit_v3_results is 'Immutable validated V3 evidence assessments; score calculation and publication are app-owned.';

-- The browser is a progress display, never the owner of a multi-minute ChatGPT
-- send loop. A short DB lease lets the Cloudflare Cron scheduler advance one
-- exact generic Bridge dispatch at a time, even after the web page closes.
create or replace function private.job_fit_v3_worker_claim_internal(p_limit integer,p_only_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user_id uuid;
  v_task public.job_fit_v3_tasks;
  v_input public.job_fit_v3_inputs;
  v_token uuid;
  v_claims jsonb:='[]'::jsonb;
  v_batch_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_limit is null or p_limit<1 or p_limit>5 then raise exception 'Fit scheduler claim limit must be between 1 and 5'; end if;

  -- Stop new prompts/results after a member is revoked. An already-sent generic
  -- dispatch is not cancelled or resent; it remains available for review.
  for v_batch_id in
    update public.job_fit_v3_tasks t
       set state='needs_user',error_message='Membership is no longer active. Sign in with an active JobHuntAI membership before resuming this fit assessment.',
           finished_at=now(),scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
     where t.state in ('queued','waiting_for_bridge','saving')
       and not exists(select 1 from private.app_memberships m where m.user_id=t.user_id and m.status='active')
     returning t.batch_id
  loop
    perform private.refresh_job_fit_v3_batch(v_batch_id);
  end loop;

  for v_user_id in
    select t.user_id
      from public.job_fit_v3_tasks t
      join private.app_memberships m on m.user_id=t.user_id and m.status='active'
     where t.state in ('queued','waiting_for_bridge','saving')
       and (t.scheduler_lease_token is null or t.scheduler_lease_expires_at<=now())
       and (p_only_user_id is null or t.user_id=p_only_user_id)
       and not exists(select 1 from public.job_fit_v3_tasks active
         where active.user_id=t.user_id and active.id<>t.id
           and active.state in ('queued','waiting_for_bridge','saving')
           and active.scheduler_lease_token is not null and active.scheduler_lease_expires_at>now())
     group by t.user_id
     order by min(t.created_at),t.user_id
     limit p_limit*8
  loop
    if not pg_try_advisory_xact_lock(hashtextextended('job-fit-v3:'||v_user_id::text,0)) then continue; end if;
    select * into v_task
      from public.job_fit_v3_tasks t
     where t.user_id=v_user_id and t.state in ('queued','waiting_for_bridge','saving')
       and (p_only_user_id is null or t.user_id=p_only_user_id)
       and (t.scheduler_lease_token is null or t.scheduler_lease_expires_at<=now())
       and not exists(select 1 from public.job_fit_v3_tasks active
         where active.user_id=t.user_id and active.id<>t.id
           and active.state in ('queued','waiting_for_bridge','saving')
           and active.scheduler_lease_token is not null and active.scheduler_lease_expires_at>now())
     order by t.created_at,t.id
     for update skip locked limit 1;
    if not found then continue; end if;
    v_token:=gen_random_uuid();
    update public.job_fit_v3_tasks set scheduler_lease_token=v_token,scheduler_lease_expires_at=now()+interval '90 seconds'
      where id=v_task.id returning * into v_task;
    select * into v_input from public.job_fit_v3_inputs where id=v_task.current_input_id and task_id=v_task.id;
    if not found then
      update public.job_fit_v3_tasks set state='needs_user',error_message='The frozen fit-analysis input is missing. Start a fresh analysis; no ChatGPT message was resent.',
        scheduler_lease_token=null,scheduler_lease_expires_at=null,finished_at=now(),updated_at=now() where id=v_task.id;
      perform private.refresh_job_fit_v3_batch(v_task.batch_id);
      continue;
    end if;
    v_claims:=v_claims||jsonb_build_array(jsonb_build_object(
      'id',v_task.id,'user_id',v_task.user_id,'batch_id',v_task.batch_id,'job_id',v_task.job_id,
      'state',v_task.state,'current_step_index',v_task.current_step_index,'attempt_count',v_task.attempt_count,
      'active_dispatch_id',v_task.active_dispatch_id,'conversation_url',v_task.conversation_url,
      'assessment_as_of',v_task.assessment_as_of,'job_revision',v_task.job_revision,'profile_revision',v_task.profile_revision,
      'testing_mode',v_task.testing_mode,'input_hash',v_task.input_hash,'input_payload',v_input.input_payload,
      'steps',v_input.steps,'lease_token',v_token
    ));
    exit when jsonb_array_length(v_claims)>=p_limit;
  end loop;
  return v_claims;
end;
$$;
revoke all on function private.job_fit_v3_worker_claim_internal(integer,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_claim_internal(integer,uuid) to service_role;

create or replace function private.job_fit_v3_worker_dispatch_internal(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_task public.job_fit_v3_tasks;
  v_job public.jobs;
  v_profile public.candidate_profiles;
  v_step jsonb;
  v_operation_id uuid:=gen_random_uuid();
  v_operation jsonb;
  v_dispatch jsonb;
  v_dispatch_id uuid;
  v_title text;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id for update;
  if not found or v_task.state<>'queued' or v_task.active_dispatch_id is not null then raise exception 'Fit task is not ready for a new saved step'; end if;
  if p_lease_token is null or v_task.scheduler_lease_token is distinct from p_lease_token
    or v_task.scheduler_lease_expires_at is null or v_task.scheduler_lease_expires_at<=now() then
    raise exception 'Fit scheduler lease expired before dispatch';
  end if;
  select * into v_job from public.jobs where id=v_task.job_id and user_id=p_user_id;
  select * into v_profile from public.candidate_profiles where user_id=p_user_id;
  if not found or v_job.id is null or v_profile.id is null
    or v_job.analysis_revision is distinct from v_task.job_revision
    or v_profile.analysis_revision is distinct from v_task.profile_revision
    or v_job.current_snapshot_id is distinct from (v_task.input_payload->'fit_input'->>'job_snapshot_id')::uuid then
    update public.job_fit_v3_tasks set state='needs_user',error_message='Your verified profile or saved listing changed before this step. Start a fresh fit analysis to use the latest information.',
      scheduler_lease_token=null,scheduler_lease_expires_at=null,finished_at=now(),updated_at=now() where id=v_task.id;
    perform private.refresh_job_fit_v3_batch(v_task.batch_id);
    return jsonb_build_object('state','needs_user','dispatch_id',null,'error','Frozen input changed');
  end if;
  v_step:=v_task.steps->v_task.current_step_index;
  if jsonb_typeof(v_step) is distinct from 'object' or jsonb_typeof(v_step->'text') is distinct from 'string'
    or v_step->>'phase' not in ('criteria','context','assessment') then
    update public.job_fit_v3_tasks set state='needs_user',error_message='The next frozen assessment step is invalid. Start a fresh analysis; no message was sent.',
      scheduler_lease_token=null,scheduler_lease_expires_at=null,finished_at=now(),updated_at=now() where id=v_task.id;
    perform private.refresh_job_fit_v3_batch(v_task.batch_id);
    return jsonb_build_object('state','needs_user','dispatch_id',null,'error','Invalid frozen step');
  end if;

  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  v_operation:=private.manage_chatgpt_user_operation_internal(v_operation_id,'begin','Analyse job fit','{}'::uuid[]);
  if coalesce((v_operation->>'ok')::boolean,false) is not true then
    update public.job_fit_v3_tasks set scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now() where id=v_task.id;
    return jsonb_build_object('state','queued','blocked',true,'reason','another_chatgpt_action_active');
  end if;
  v_title:=case v_step->>'phase' when 'criteria' then 'Prepare job requirements' when 'context' then 'Prepare verified fit context' else 'Assess job fit from verified evidence' end;
  v_dispatch:=public.create_chatgpt_dispatch_request_with_website_instruction(
    'jobs.analyse_selected',jsonb_build_object('job_ids',jsonb_build_array(v_task.job_id::text)),
    'user_click',v_title,
    'jobfit-'||v_task.id::text||':'||v_task.attempt_count::text||':'||(v_step->>'ordinal'),
    50,v_step->>'text'
  );
  v_dispatch_id:=nullif(v_dispatch->>'id','')::uuid;
  if v_dispatch_id is null or coalesce(v_dispatch->>'state','') not in ('queued','claimed_by_extension','opening_chatgpt','composer_ready') then
    perform private.manage_chatgpt_user_operation_internal(v_operation_id,'release',null,'{}'::uuid[]);
    raise exception 'The generic Website Bridge did not create the exact queued fit step';
  end if;
  perform private.manage_chatgpt_user_operation_internal(v_operation_id,'track',v_title,array[v_dispatch_id]);
  update public.job_fit_v3_tasks set state='waiting_for_bridge',active_dispatch_id=v_dispatch_id,error_message=null,finished_at=null,
    scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now() where id=v_task.id;
  perform private.refresh_job_fit_v3_batch(v_task.batch_id);
  return jsonb_build_object('state','waiting_for_bridge','dispatch_id',v_dispatch_id,'correlation_id',v_dispatch->>'correlation_id');
end;
$$;
revoke all on function private.job_fit_v3_worker_dispatch_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_dispatch_internal(uuid,uuid,uuid) to service_role;

create or replace function private.job_fit_v3_worker_status_internal(p_user_id uuid,p_task_id uuid,p_dispatch_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.job_fit_v3_tasks; v_step jsonb; v_dispatch jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id for share;
  if not found or v_task.state<>'waiting_for_bridge' or v_task.active_dispatch_id is distinct from p_dispatch_id
    or v_task.scheduler_lease_token is distinct from p_lease_token or v_task.scheduler_lease_expires_at is null or v_task.scheduler_lease_expires_at<=now() then
    raise exception 'The fit status request does not own the active task lease';
  end if;
  v_step:=v_task.steps->v_task.current_step_index;
  if p_dispatch_id is null or v_step->>'phase' not in ('criteria','context','assessment') then raise exception 'The saved fit step is invalid'; end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  v_dispatch:=public.get_chatgpt_dispatch_request(p_dispatch_id);
  if v_dispatch->>'id' is distinct from p_dispatch_id::text
    or v_dispatch->>'action_type' is distinct from 'jobs.analyse_selected'
    or v_dispatch->>'idempotency_key' is distinct from 'jobfit-'||v_task.id::text||':'||v_task.attempt_count::text||':'||(v_step->>'ordinal')
    or v_dispatch->'subject_refs'->'job_ids'<>jsonb_build_array(v_task.job_id::text)
    or coalesce(v_dispatch->>'website_instruction',v_dispatch->>'manual_instruction') is distinct from v_step->>'text' then
    raise exception 'The Bridge dispatch no longer matches its exact saved fit step';
  end if;
  return v_dispatch;
end;
$$;
revoke all on function private.job_fit_v3_worker_status_internal(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_status_internal(uuid,uuid,uuid,uuid) to service_role;

create or replace function private.job_fit_v3_worker_captures_internal(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.job_fit_v3_tasks; v_captures jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  select * into v_task from public.job_fit_v3_tasks where id=p_task_id and user_id=p_user_id for share;
  if not found or v_task.scheduler_lease_token is distinct from p_lease_token
    or v_task.scheduler_lease_expires_at is null or v_task.scheduler_lease_expires_at<=now() then
    raise exception 'Fit scheduler lease expired before reading prior captures';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('step_index',c.step_index,'dispatch_id',c.dispatch_id,'bridge_response',c.bridge_response) order by c.step_index),'[]'::jsonb)
    into v_captures from public.job_fit_v3_captures c where c.task_id=p_task_id and c.user_id=p_user_id and c.phase='criteria';
  return v_captures;
end;
$$;
revoke all on function private.job_fit_v3_worker_captures_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_captures_internal(uuid,uuid,uuid) to service_role;

create or replace function private.job_fit_v3_worker_release_internal(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.job_fit_v3_tasks;
begin
  if (select auth.role()) is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform private.assert_active_app_membership(p_user_id);
  update public.job_fit_v3_tasks set scheduler_lease_token=null,scheduler_lease_expires_at=null,updated_at=now()
   where id=p_task_id and user_id=p_user_id and scheduler_lease_token=p_lease_token returning * into v_task;
  if not found then raise exception 'Fit scheduler lease is no longer current'; end if;
  return jsonb_build_object('state',v_task.state,'released',true);
end;
$$;
revoke all on function private.job_fit_v3_worker_release_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.job_fit_v3_worker_release_internal(uuid,uuid,uuid) to service_role;

-- Exposed scheduler wrappers remain SECURITY INVOKER. service_role can call
-- only these specific worker functions; it has no direct table DML grants.
create or replace function public.job_fit_v3_worker_claim(p_limit integer default 5,p_user_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$ select private.job_fit_v3_worker_claim_internal($1,$2); $$;
create or replace function public.job_fit_v3_worker_dispatch(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.job_fit_v3_worker_dispatch_internal($1,$2,$3); $$;
create or replace function public.job_fit_v3_worker_status(p_user_id uuid,p_task_id uuid,p_dispatch_id uuid,p_lease_token uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.job_fit_v3_worker_status_internal($1,$2,$3,$4); $$;
create or replace function public.job_fit_v3_worker_captures(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.job_fit_v3_worker_captures_internal($1,$2,$3); $$;
create or replace function public.job_fit_v3_worker_release(p_user_id uuid,p_task_id uuid,p_lease_token uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.job_fit_v3_worker_release_internal($1,$2,$3); $$;

revoke all on function public.job_fit_v3_worker_claim(integer,uuid) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_v3_worker_dispatch(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_v3_worker_status(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_v3_worker_captures(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.job_fit_v3_worker_release(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.job_fit_v3_worker_claim(integer,uuid) to service_role;
grant execute on function public.job_fit_v3_worker_dispatch(uuid,uuid,uuid) to service_role;
grant execute on function public.job_fit_v3_worker_status(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.job_fit_v3_worker_captures(uuid,uuid,uuid) to service_role;
grant execute on function public.job_fit_v3_worker_release(uuid,uuid,uuid) to service_role;
