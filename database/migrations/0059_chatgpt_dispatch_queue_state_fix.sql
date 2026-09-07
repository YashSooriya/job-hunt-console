-- Fix the universal ChatGPT dispatch creator. The work-item insert declares a
-- state column, so every new dispatch must explicitly start in queued state.

create or replace function public.create_chatgpt_dispatch_request(
  p_action_type text,
  p_subject_refs jsonb default '{}'::jsonb,
  p_origin text default 'user_click',
  p_display_title text default null,
  p_idempotency_key text default null,
  p_priority integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_policy jsonb;
  v_existing public.chatgpt_dispatch_requests;
  v_request public.chatgpt_dispatch_requests;
  v_target uuid;
  v_work public.chatgpt_work_items;
  v_work_kind text;
  v_key text := nullif(btrim(p_idempotency_key),'');
  v_inspection uuid;
  v_id uuid;
  v_item text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if nullif(btrim(p_action_type),'') is null then raise exception 'Dispatch action type is required'; end if;
  v_policy := private.chatgpt_dispatch_policy(p_action_type);
  if p_origin not in ('user_click','explicit_automation','diagnostic') then raise exception 'Unsupported dispatch origin'; end if;
  if length(coalesce(p_display_title,'')) > 160 then raise exception 'Dispatch display title is too long'; end if;
  if jsonb_typeof(coalesce(p_subject_refs,'{}'::jsonb)) <> 'object' then raise exception 'subject_refs must be an object'; end if;
  if length(coalesce(p_subject_refs,'{}'::jsonb)::text) > 10000 then raise exception 'Dispatch references are too large'; end if;
  if p_action_type in ('jobs.search.manual','tracker.sync_now','bridge.diagnostic') and p_subject_refs <> '{}'::jsonb then raise exception 'This dispatch action does not accept subject references'; end if;
  if p_action_type='job.inspect_url' and (not (p_subject_refs ? 'inspection_id') or (select count(*) from jsonb_object_keys(p_subject_refs)) <> 1) then raise exception 'job.inspect_url accepts only inspection_id'; end if;
  if p_action_type='jobs.analyse_selected' and (not (p_subject_refs ? 'job_ids') or (select count(*) from jsonb_object_keys(p_subject_refs)) <> 1) then raise exception 'jobs.analyse_selected accepts only job_ids'; end if;
  if p_action_type in ('documents.cv.create','documents.cover_letter.create') and (not (p_subject_refs ? 'application_ids') or (select count(*) from jsonb_object_keys(p_subject_refs)) <> 1) then raise exception 'Document dispatches accept only application_ids'; end if;
  if p_action_type='emails.process_now' and exists(select 1 from jsonb_object_keys(p_subject_refs) key where key <> 'email_ids') then raise exception 'emails.process_now accepts only email_ids'; end if;
  if p_idempotency_key is not null and (length(p_idempotency_key)<1 or length(p_idempotency_key)>200 or p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$') then raise exception 'Invalid dispatch idempotency key'; end if;
  if p_priority is null or p_priority < 0 or p_priority > 100 then raise exception 'Dispatch priority is invalid'; end if;
  if v_key is null then v_key := 'dispatch:' || p_action_type || ':' || md5(coalesce(p_subject_refs,'{}'::jsonb)::text); end if;
  if length(v_key) > 200 then raise exception 'Dispatch idempotency key is too long'; end if;

  select * into v_existing from public.chatgpt_dispatch_requests where user_id=v_user and idempotency_key=v_key for update;
  if found then
    return jsonb_build_object(
      'id',v_existing.id,'state',v_existing.state,'action_type',v_existing.action_type,'action_version',v_existing.action_version,
      'display_title',v_existing.display_title,'idempotency_key',v_existing.idempotency_key,'correlation_id',v_existing.correlation_id,
      'manual_instruction',v_existing.manual_instruction,'progress',v_existing.progress_json,'error',v_existing.error_json,
      'output_refs',v_existing.output_refs,'created_at',v_existing.created_at,'updated_at',v_existing.updated_at,'idempotent',true
    );
  end if;

  if p_action_type='job.inspect_url' then
    if not ((p_subject_refs ? 'inspection_id') and (p_subject_refs->>'inspection_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then raise exception 'inspection_id must be a UUID'; end if;
    v_inspection := (p_subject_refs->>'inspection_id')::uuid;
    if not exists(select 1 from public.job_url_inspection_requests where id=v_inspection and user_id=v_user and status in ('queued','processing')) then raise exception 'Owned queued URL inspection not found'; end if;
    v_work_kind := 'helper_run';
  elsif p_action_type='jobs.analyse_selected' then
    if jsonb_typeof(p_subject_refs->'job_ids') <> 'array' or jsonb_array_length(p_subject_refs->'job_ids') < 1 or jsonb_array_length(p_subject_refs->'job_ids') > 20 then raise exception 'job_ids must contain 1-20 jobs'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_subject_refs->'job_ids') x(value) where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or not exists(select 1 from public.jobs j where j.id=value::uuid and j.user_id=v_user)) then raise exception 'Every selected job must be an owned UUID'; end if;
    v_work_kind := 'job_analysis';
  elsif p_action_type in ('documents.cv.create','documents.cover_letter.create') then
    if jsonb_typeof(p_subject_refs->'application_ids') <> 'array' or jsonb_array_length(p_subject_refs->'application_ids') < 1 or jsonb_array_length(p_subject_refs->'application_ids') > 10 then raise exception 'application_ids must contain 1-10 applications'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_subject_refs->'application_ids') x(value) where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or not exists(select 1 from public.applications a where a.id=value::uuid and a.user_id=v_user)) then raise exception 'Every selected application must be an owned UUID'; end if;
    v_work_kind := 'application_package';
  elsif p_action_type='emails.process_now' then
    if p_subject_refs ? 'email_ids' then
      if jsonb_typeof(p_subject_refs->'email_ids') <> 'array' or jsonb_array_length(p_subject_refs->'email_ids') < 1 or jsonb_array_length(p_subject_refs->'email_ids') > 25 then raise exception 'email_ids must contain 1-25 messages'; end if;
      if exists(select 1 from jsonb_array_elements_text(p_subject_refs->'email_ids') x(value) where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or not exists(select 1 from public.emails e where e.id=value::uuid and e.user_id=v_user)) then raise exception 'Every selected email must be owned'; end if;
    end if;
    v_work_kind := 'helper_run';
  elsif p_action_type='jobs.search.manual' then
    v_work_kind := 'search_run';
  elsif p_action_type='tracker.sync_now' then
    v_work_kind := 'helper_run';
  elsif p_action_type='bridge.diagnostic' then
    v_work_kind := 'helper_run';
  end if;

  select id into v_target from public.chatgpt_bridge_devices where user_id=v_user and revoked_at is null and preferred order by last_seen_at desc nulls last limit 1;
  v_id := extensions.gen_random_uuid();
  insert into public.chatgpt_work_items(user_id,kind,state,idempotency_key,input_json)
  values(v_user,v_work_kind,'queued',left('dispatch:'||v_key,200),jsonb_build_object('dispatch_request_id',v_id,'action_type',p_action_type))
  on conflict(user_id,idempotency_key) do update set updated_at=excluded.updated_at
  returning * into v_work;

  insert into public.chatgpt_dispatch_requests(
    id,user_id,schema_version,action_type,action_version,display_title,origin,subject_refs,state,idempotency_key,priority,
    confirmation_policy,allowed_effects,required_mcp_tools,expected_outputs,timeout_seconds,retry_policy,target_device_id,manual_instruction,work_item_id
  ) values (
    v_id,v_user,'1.0.0',p_action_type,v_policy->>'action_version',coalesce(nullif(btrim(p_display_title),''),v_policy->>'display_title'),p_origin,
    coalesce(p_subject_refs,'{}'::jsonb),'queued',v_key,p_priority,v_policy->>'confirmation_policy',v_policy->'allowed_effects',
    v_policy->'required_mcp_tools',v_policy->'expected_outputs',(v_policy->>'timeout_seconds')::integer,v_policy->>'retry_policy',v_target,
    private.chatgpt_dispatch_instruction(v_id),v_work.id
  ) on conflict(user_id,idempotency_key) do nothing returning * into v_request;

  if not found then
    select * into v_request from public.chatgpt_dispatch_requests where user_id=v_user and idempotency_key=v_key;
    delete from public.chatgpt_work_items where id=v_work.id and input_json->>'dispatch_request_id'=v_id::text;
    return jsonb_build_object(
      'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,'action_version',v_request.action_version,
      'display_title',v_request.display_title,'idempotency_key',v_request.idempotency_key,'correlation_id',v_request.correlation_id,
      'manual_instruction',v_request.manual_instruction,'progress',v_request.progress_json,'error',v_request.error_json,
      'output_refs',v_request.output_refs,'created_at',v_request.created_at,'updated_at',v_request.updated_at,'idempotent',true
    );
  end if;

  update public.chatgpt_work_items set input_json=input_json || jsonb_build_object('dispatch_request_id',v_request.id) where id=v_work.id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'chatgpt_bridge.dispatch_created','chatgpt_dispatch_request',v_request.id,
    jsonb_build_object('correlation_id',v_request.correlation_id,'action_type',v_request.action_type,'origin',v_request.origin,'subject_keys',(
      select coalesce(jsonb_agg(key order by key),'[]'::jsonb) from jsonb_object_keys(v_request.subject_refs) key
    )));
  return jsonb_build_object(
    'id',v_request.id,'state',v_request.state,'action_type',v_request.action_type,'action_version',v_request.action_version,
    'display_title',v_request.display_title,'idempotency_key',v_request.idempotency_key,'correlation_id',v_request.correlation_id,
    'manual_instruction',v_request.manual_instruction,'progress',v_request.progress_json,'error',v_request.error_json,'output_refs',v_request.output_refs,
    'created_at',v_request.created_at,'updated_at',v_request.updated_at,'idempotent',false
  );
end;
$$;

revoke all on function public.create_chatgpt_dispatch_request(text,jsonb,text,text,text,integer) from public, anon;
grant execute on function public.create_chatgpt_dispatch_request(text,jsonb,text,text,text,integer) to authenticated;
