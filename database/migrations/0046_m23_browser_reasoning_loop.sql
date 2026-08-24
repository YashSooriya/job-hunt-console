-- Milestone 23: auditable browser-helper question/reasoning loop.

create table if not exists public.browser_agent_reasoning (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.form_agent_sessions(id) on delete cascade,
  observation_id uuid references public.form_agent_observations(id) on delete set null,
  work_item_id uuid references public.chatgpt_work_items(id) on delete set null,
  source text not null check (source in ('chatgpt','user','helper')),
  status text not null default 'proposed' check (status in ('proposed','accepted','rejected','superseded')),
  proposal_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists browser_agent_reasoning_user_idx
  on public.browser_agent_reasoning(user_id, created_at desc);
create index if not exists browser_agent_reasoning_session_idx
  on public.browser_agent_reasoning(session_id, created_at desc);
create index if not exists browser_agent_reasoning_observation_idx
  on public.browser_agent_reasoning(observation_id);
create index if not exists browser_agent_reasoning_work_item_idx
  on public.browser_agent_reasoning(work_item_id);

alter table public.browser_agent_reasoning enable row level security;
revoke all on public.browser_agent_reasoning from public, anon;
grant select on public.browser_agent_reasoning to authenticated;
drop policy if exists browser_agent_reasoning_owner on public.browser_agent_reasoning;
create policy browser_agent_reasoning_owner on public.browser_agent_reasoning
  for select to authenticated using (user_id=(select auth.uid()));

create or replace function private.enqueue_browser_question_work_item()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_observation uuid;
  v_work public.chatgpt_work_items;
begin
  if new.status <> 'needs_user' or old.status is not distinct from new.status then return new; end if;
  select id into v_observation from public.form_agent_observations where session_id=new.id order by sequence_number desc limit 1;
  insert into public.chatgpt_work_items(user_id,kind,state,idempotency_key,input_json,user_required_at)
  values(
    new.user_id,'browser_question','user_required',
    'browser_question:'||new.id::text||':'||coalesce(v_observation::text,'none'),
    jsonb_build_object('session_id',new.id,'application_id',new.application_id,'observation_id',v_observation,
      'current_url',new.current_url,'current_title',new.current_title,'pause_reasons',coalesce(new.pause_reasons,'[]'::jsonb)),now()
  )
  on conflict(user_id,idempotency_key) do update set input_json=excluded.input_json,updated_at=now(),user_required_at=coalesce(public.chatgpt_work_items.user_required_at,now())
  returning * into v_work;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(new.user_id,'system','browser-helper','browser_helper.question_queued','form_agent_session',new.id,
    jsonb_build_object('work_item_id',v_work.id,'observation_id',v_observation,'pause_reasons',coalesce(new.pause_reasons,'[]'::jsonb)));
  return new;
end;
$$;
revoke all on function private.enqueue_browser_question_work_item() from public,anon,authenticated;
drop trigger if exists browser_helper_question_work_item on public.form_agent_sessions;
create trigger browser_helper_question_work_item after update on public.form_agent_sessions
for each row execute function private.enqueue_browser_question_work_item();

create or replace function private.chatgpt_get_browser_question_context_internal(p_access_token text,p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_limit integer:=greatest(1,least(coalesce(p_limit,20),50));
  v_sessions jsonb;
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for browser question context'; end if;
  select coalesce(jsonb_agg(item order by item->>'updated_at' desc),'[]'::jsonb) into v_sessions
  from (
    select jsonb_build_object(
      'id',s.id,'application_id',s.application_id,'status',s.status,'expires_at',s.expires_at,
      'current_url',s.current_url,'current_title',s.current_title,'pause_reasons',s.pause_reasons,
      'updated_at',s.updated_at,
      'work_item',(select jsonb_build_object('id',w.id,'state',w.state,'input',w.input_json,'created_at',w.created_at,'updated_at',w.updated_at)
        from public.chatgpt_work_items w where w.user_id=s.user_id and w.kind='browser_question' and w.input_json->>'session_id'=s.id::text order by w.created_at desc limit 1),
      'reasoning',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'source',r.source,'proposal',r.proposal_json,'observation_id',r.observation_id,'created_at',r.created_at,'updated_at',r.updated_at) order by r.created_at desc)
        from (select * from public.browser_agent_reasoning r where r.user_id=s.user_id and r.session_id=s.id order by r.created_at desc limit 5) r),'[]'::jsonb)
    ) as item
    from (select * from public.form_agent_sessions where user_id=v_token.user_id and status in ('needs_user','active','final_review') order by updated_at desc limit v_limit) s
  ) items;
  return jsonb_build_object('user_id',v_token.user_id,'sessions',v_sessions,'requires_user_for_resume',true,'automatic_actions_allowed',false);
end;
$$;
revoke all on function private.chatgpt_get_browser_question_context_internal(text,integer) from public,anon,authenticated;
grant execute on function private.chatgpt_get_browser_question_context_internal(text,integer) to anon,authenticated;

create or replace function public.chatgpt_get_browser_question_context(p_access_token text,p_limit integer default 20)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_get_browser_question_context_internal($1,$2); $$;
revoke all on function public.chatgpt_get_browser_question_context(text,integer) from public,authenticated;
grant execute on function public.chatgpt_get_browser_question_context(text,integer) to anon,authenticated;

create or replace function private.chatgpt_propose_browser_reasoning_internal(p_access_token text,p_session_id uuid,p_proposal jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_session public.form_agent_sessions;
  v_observation uuid;
  v_work public.chatgpt_work_items;
  v_reasoning public.browser_agent_reasoning;
  v_proposal jsonb:=coalesce(p_proposal,'{}'::jsonb);
begin
  select * into v_token from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token) and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for browser reasoning'; end if;
  if length(v_proposal::text)>120000 then raise exception 'Browser reasoning proposal is too large'; end if;
  select * into v_session from public.form_agent_sessions where id=p_session_id and user_id=v_token.user_id;
  if not found then raise exception 'Browser form session not found'; end if;
  if v_session.status <> 'needs_user' then raise exception 'Browser reasoning is accepted only while the helper is waiting for the user'; end if;
  select id into v_observation from public.form_agent_observations where session_id=p_session_id order by sequence_number desc limit 1;
  select * into v_work from public.chatgpt_work_items where user_id=v_token.user_id and kind='browser_question' and input_json->>'session_id'=p_session_id::text order by created_at desc limit 1;
  insert into public.browser_agent_reasoning(user_id,session_id,observation_id,work_item_id,source,status,proposal_json)
  values(v_token.user_id,p_session_id,v_observation,v_work.id,'chatgpt','proposed',v_proposal)
  returning * into v_reasoning;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_token.user_id,'chatgpt',v_token.client_id,'chatgpt.browser_reasoning_proposed','form_agent_session',p_session_id,
    jsonb_build_object('reasoning_id',v_reasoning.id,'observation_id',v_observation,'requires_user',true,'automatic_actions_allowed',false));
  return jsonb_build_object('saved',true,'reasoning_id',v_reasoning.id,'status','proposed','requires_user',true,'resumed',false,'applied',false,
    'message','Proposal saved for user review. It was not applied to the employer form and the helper was not resumed.');
end;
$$;
revoke all on function private.chatgpt_propose_browser_reasoning_internal(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.chatgpt_propose_browser_reasoning_internal(text,uuid,jsonb) to anon,authenticated;

create or replace function public.chatgpt_propose_browser_reasoning(p_access_token text,p_session_id uuid,p_proposal jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select private.chatgpt_propose_browser_reasoning_internal($1,$2,$3); $$;
revoke all on function public.chatgpt_propose_browser_reasoning(text,uuid,jsonb) from public,authenticated;
grant execute on function public.chatgpt_propose_browser_reasoning(text,uuid,jsonb) to anon,authenticated;

create or replace function private.review_browser_reasoning_current_user(p_reasoning_id uuid,p_decision text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=(select auth.uid());
  v_reasoning public.browser_agent_reasoning;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if p_decision not in ('accept','reject') then raise exception 'Invalid browser reasoning decision'; end if;
  select * into v_reasoning from public.browser_agent_reasoning where id=p_reasoning_id and user_id=v_user for update;
  if not found then raise exception 'Browser reasoning proposal not found'; end if;
  update public.browser_agent_reasoning set status=case when p_decision='accept' then 'accepted' else 'rejected' end,updated_at=now() where id=p_reasoning_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'browser_helper.reasoning_reviewed','form_agent_session',v_reasoning.session_id,
    jsonb_build_object('reasoning_id',p_reasoning_id,'decision',p_decision,'resumed',false,'applied',false));
  return jsonb_build_object('reasoning_id',p_reasoning_id,'status',case when p_decision='accept' then 'accepted' else 'rejected' end,
    'resume_required',true,'resumed',false,'applied',false);
end;
$$;
revoke all on function private.review_browser_reasoning_current_user(uuid,text) from public,anon,authenticated;
grant execute on function private.review_browser_reasoning_current_user(uuid,text) to authenticated;

create or replace function public.review_browser_reasoning(p_reasoning_id uuid,p_decision text)
returns jsonb language sql security invoker set search_path=''
as $$ select private.review_browser_reasoning_current_user($1,$2); $$;
revoke all on function public.review_browser_reasoning(uuid,text) from public,anon;
grant execute on function public.review_browser_reasoning(uuid,text) to authenticated;

comment on table public.browser_agent_reasoning is 'M23 user-reviewed browser-helper reasoning proposals; proposals never execute actions or resume a form session.';
