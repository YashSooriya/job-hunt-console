-- Milestone 24: per-user reliability controls, rate limits and operations status.

create table if not exists public.automation_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null check (bucket in ('mcp_read','mcp_write','search_run','browser_reasoning')),
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key(user_id,bucket)
);

create index if not exists automation_rate_limits_user_idx
  on public.automation_rate_limits(user_id, updated_at desc);

alter table public.automation_rate_limits enable row level security;
revoke all on public.automation_rate_limits from public,anon,authenticated;
drop policy if exists automation_rate_limits_no_direct_client_access on public.automation_rate_limits;
create policy automation_rate_limits_no_direct_client_access on public.automation_rate_limits
  as restrictive for all to authenticated using (false) with check (false);

create or replace function private.consume_automation_rate_limit_for_user(
  p_user uuid,
  p_bucket text,
  p_limit integer,
  p_window_seconds integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_row public.automation_rate_limits;
  v_limit integer:=greatest(1,least(coalesce(p_limit,60),1000));
  v_window integer:=greatest(1,least(coalesce(p_window_seconds,3600),86400));
  v_reset timestamptz;
begin
  if p_bucket not in ('mcp_read','mcp_write','search_run','browser_reasoning') then raise exception 'Invalid automation rate-limit bucket'; end if;
  perform private.assert_active_app_membership(p_user);
  insert into public.automation_rate_limits(user_id,bucket,window_started_at,request_count,updated_at)
  values(p_user,p_bucket,now(),0,now()) on conflict(user_id,bucket) do nothing;
  select * into v_row from public.automation_rate_limits where user_id=p_user and bucket=p_bucket for update;
  if v_row.window_started_at + make_interval(secs=>v_window) <= now() then
    update public.automation_rate_limits set window_started_at=now(),request_count=0,updated_at=now()
      where user_id=p_user and bucket=p_bucket returning * into v_row;
  end if;
  v_reset:=v_row.window_started_at + make_interval(secs=>v_window);
  if v_row.request_count >= v_limit then
    return jsonb_build_object('allowed',false,'bucket',p_bucket,'limit',v_limit,'remaining',0,'reset_at',v_reset);
  end if;
  update public.automation_rate_limits set request_count=request_count+1,updated_at=now()
    where user_id=p_user and bucket=p_bucket returning * into v_row;
  return jsonb_build_object('allowed',true,'bucket',p_bucket,'limit',v_limit,'remaining',greatest(0,v_limit-v_row.request_count),'reset_at',v_reset);
end;
$$;
revoke all on function private.consume_automation_rate_limit_for_user(uuid,text,integer,integer) from public,anon,authenticated;

create or replace function private.chatgpt_consume_rate_limit_internal(p_access_token text,p_bucket text,p_limit integer,p_window_seconds integer default 3600)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_token private.chatgpt_oauth_access_tokens;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  return private.consume_automation_rate_limit_for_user(v_token.user_id,p_bucket,p_limit,p_window_seconds);
end;
$$;
revoke all on function private.chatgpt_consume_rate_limit_internal(text,text,integer,integer) from public,anon,authenticated;
grant execute on function private.chatgpt_consume_rate_limit_internal(text,text,integer,integer) to anon,authenticated;

create or replace function public.chatgpt_consume_rate_limit(p_access_token text,p_bucket text,p_limit integer,p_window_seconds integer default 3600)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_consume_rate_limit_internal($1,$2,$3,$4); $$;
revoke all on function public.chatgpt_consume_rate_limit(text,text,integer,integer) from public,authenticated;
grant execute on function public.chatgpt_consume_rate_limit(text,text,integer,integer) to anon,authenticated;

create or replace function private.recover_stale_chatgpt_work_for_user(p_user uuid,p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_requeued integer:=0; v_failed integer:=0; v_limit integer:=greatest(1,least(coalesce(p_limit,20),100));
begin
  perform private.assert_active_app_membership(p_user);
  with stale as (
    select id from public.chatgpt_work_items
    where user_id=p_user and state in ('leased','running') and lease_expires_at is not null and lease_expires_at<=now()
    order by updated_at asc limit v_limit for update skip locked
  ), changed as (
    update public.chatgpt_work_items w
       set state=case when w.attempt_count+1>=5 then 'failed' else 'queued' end,
           attempt_count=w.attempt_count+1,lease_token=null,leased_at=null,lease_expires_at=null,
           last_error='Lease expired; reliability recovery reclaimed this work item.',
           error_json=case when w.attempt_count+1>=5 then jsonb_build_object('code','retry_cap_exceeded','message','Work item exceeded the five-attempt recovery cap.') else null end,
           failed_at=case when w.attempt_count+1>=5 then now() else null end,updated_at=now()
    from stale s where w.id=s.id returning w.state
  ) select count(*) filter(where state='queued'),count(*) filter(where state='failed') into v_requeued,v_failed from changed;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'system','m24-reliability','chatgpt.work_recovered','chatgpt_work_item',null,jsonb_build_object('requeued',v_requeued,'failed',v_failed,'limit',v_limit));
  return jsonb_build_object('requeued',v_requeued,'failed',v_failed,'retry_cap',5);
end;
$$;
revoke all on function private.recover_stale_chatgpt_work_for_user(uuid,integer) from public,anon,authenticated;

create or replace function private.chatgpt_recover_stale_work_internal(p_access_token text,p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_token private.chatgpt_oauth_access_tokens;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for work recovery'; end if;
  return private.recover_stale_chatgpt_work_for_user(v_token.user_id,p_limit);
end;
$$;
revoke all on function private.chatgpt_recover_stale_work_internal(text,integer) from public,anon,authenticated;
grant execute on function private.chatgpt_recover_stale_work_internal(text,integer) to anon,authenticated;

create or replace function public.chatgpt_recover_stale_work(p_access_token text,p_limit integer default 20)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_recover_stale_work_internal($1,$2); $$;
revoke all on function public.chatgpt_recover_stale_work(text,integer) from public,authenticated;
grant execute on function public.chatgpt_recover_stale_work(text,integer) to anon,authenticated;

create or replace function private.chatgpt_get_pending_work_context_internal(p_access_token text,p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_token private.chatgpt_oauth_access_tokens; v_limit integer:=greatest(1,least(coalesce(p_limit,20),50)); v_items jsonb; v_results jsonb;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for pending work'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'kind',w.kind,'state',w.state,'idempotency_key',w.idempotency_key,'input',w.input_json,'output',w.output_json,'error',w.error_json,'attempt_count',w.attempt_count,'user_required_at',w.user_required_at,'created_at',w.created_at,'updated_at',w.updated_at) order by w.updated_at desc),'[]'::jsonb) into v_items
    from (select * from public.chatgpt_work_items where user_id=v_token.user_id and state in ('queued','leased','running','user_required') order by updated_at desc limit v_limit) w;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'result_kind',r.result_kind,'result',r.result_json,'provenance',r.provenance,'created_at',r.created_at,'updated_at',r.updated_at) order by r.updated_at desc),'[]'::jsonb) into v_results
    from (select * from public.chatgpt_reasoning_results where user_id=v_token.user_id order by updated_at desc limit v_limit) r;
  return jsonb_build_object('user_id',v_token.user_id,'items',v_items,'reasoning_results',v_results,'limit',v_limit);
end;
$$;
revoke all on function private.chatgpt_get_pending_work_context_internal(text,integer) from public,anon,authenticated;
grant execute on function private.chatgpt_get_pending_work_context_internal(text,integer) to anon,authenticated;

create or replace function public.chatgpt_get_pending_work_context(p_access_token text,p_limit integer default 20)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_get_pending_work_context_internal($1,$2); $$;
revoke all on function public.chatgpt_get_pending_work_context(text,integer) from public,authenticated;
grant execute on function public.chatgpt_get_pending_work_context(text,integer) to anon,authenticated;

create or replace function private.get_automation_operations_status_for_user(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_last_run jsonb; v_rate_limits jsonb;
begin
  perform private.assert_active_app_membership(p_user);
  select coalesce(to_jsonb(r)-'user_id','{}'::jsonb) into v_last_run from public.job_search_runs r where r.user_id=p_user order by r.created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket,'request_count',request_count,'window_started_at',window_started_at,'updated_at',updated_at) order by bucket),'[]'::jsonb) into v_rate_limits from public.automation_rate_limits where user_id=p_user;
  return jsonb_build_object(
    'active_membership',true,
    'work',jsonb_build_object(
      'queued',(select count(*) from public.chatgpt_work_items where user_id=p_user and state='queued'),
      'running',(select count(*) from public.chatgpt_work_items where user_id=p_user and state in ('leased','running')),
      'user_required',(select count(*) from public.chatgpt_work_items where user_id=p_user and state='user_required'),
      'failed_last_24h',(select count(*) from public.chatgpt_work_items where user_id=p_user and state='failed' and failed_at>now()-interval '24 hours'),
      'stale',(select count(*) from public.chatgpt_work_items where user_id=p_user and state in ('leased','running') and lease_expires_at<=now())
    ),
    'search',jsonb_build_object('last_run',coalesce(v_last_run,'{}'::jsonb),'active_runs',(select count(*) from public.job_search_runs where user_id=p_user and state in ('queued','running'))),
    'browser',jsonb_build_object('active_sessions',(select count(*) from public.form_agent_sessions where user_id=p_user and status in ('active','needs_user','final_review')),'needs_user',(select count(*) from public.form_agent_sessions where user_id=p_user and status='needs_user')),
    'rate_limits',v_rate_limits,
    'retrieved_at',now()
  );
end;
$$;
revoke all on function private.get_automation_operations_status_for_user(uuid) from public,anon,authenticated;

create or replace function public.get_automation_operations_status()
returns jsonb language plpgsql security invoker set search_path=''
as $$
declare v_user uuid:=(select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.get_automation_operations_status_for_user(v_user);
end;
$$;
revoke all on function public.get_automation_operations_status() from public,anon;
grant execute on function public.get_automation_operations_status() to authenticated;

comment on table public.automation_rate_limits is 'M24 per-user bounded automation request windows; direct client access is denied.';
