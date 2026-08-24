-- Milestone 19: authenticated ChatGPT MCP app surface, OAuth 2.1/PKCE,
-- per-user work items, idempotent reasoning results and audit boundaries.

create table if not exists public.chatgpt_work_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in (
    'reasoning_result','job_discovery','job_analysis','application_package',
    'user_required_question','application_review','browser_question',
    'search_run','helper_run'
  )),
  state text not null default 'queued' check (state in ('queued','leased','running','completed','failed','user_required')),
  idempotency_key text not null,
  input_json jsonb not null default '{}'::jsonb,
  output_json jsonb,
  error_json jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_token text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_error text,
  user_required_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key)
);

create index if not exists chatgpt_work_items_user_state_idx
  on public.chatgpt_work_items(user_id, state, updated_at desc);
create index if not exists chatgpt_work_items_queue_idx
  on public.chatgpt_work_items(state, created_at, user_id);

create table if not exists public.chatgpt_reasoning_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  work_item_id uuid references public.chatgpt_work_items(id) on delete set null,
  idempotency_key text not null,
  result_kind text not null,
  result_json jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key)
);

create index if not exists chatgpt_reasoning_results_user_idx
  on public.chatgpt_reasoning_results(user_id, updated_at desc);

create table if not exists private.chatgpt_oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null check (code_challenge_method = 'S256'),
  scope text[] not null default array['profile:read','work:write'],
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chatgpt_oauth_codes_expiry_idx
  on private.chatgpt_oauth_authorization_codes(expires_at)
  where used_at is null;

create table if not exists private.chatgpt_oauth_access_tokens (
  id uuid primary key default gen_random_uuid(),
  access_token_hash text not null unique,
  refresh_token_hash text unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  scope text[] not null default array['profile:read','work:write'],
  expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chatgpt_oauth_tokens_user_idx
  on private.chatgpt_oauth_access_tokens(user_id, created_at desc);
create index if not exists chatgpt_oauth_tokens_refresh_idx
  on private.chatgpt_oauth_access_tokens(refresh_token_hash)
  where refresh_token_hash is not null and revoked_at is null;

alter table public.chatgpt_work_items enable row level security;
alter table public.chatgpt_reasoning_results enable row level security;

revoke all on public.chatgpt_work_items from public, anon, authenticated;
revoke all on public.chatgpt_reasoning_results from public, anon, authenticated;
grant select, insert, update, delete on public.chatgpt_work_items to service_role;
grant select, insert, update, delete on public.chatgpt_reasoning_results to service_role;

create policy chatgpt_work_items_no_direct_client_access on public.chatgpt_work_items
  as restrictive for all to authenticated using (false) with check (false);
create policy chatgpt_reasoning_results_no_direct_client_access on public.chatgpt_reasoning_results
  as restrictive for all to authenticated using (false) with check (false);

revoke all on private.chatgpt_oauth_authorization_codes from public, anon, authenticated;
revoke all on private.chatgpt_oauth_access_tokens from public, anon, authenticated;
grant select, insert, update, delete on private.chatgpt_oauth_authorization_codes to service_role;
grant select, insert, update, delete on private.chatgpt_oauth_access_tokens to service_role;

create or replace function private.chatgpt_token_hash(p_token text)
returns text
language sql
immutable
security invoker
set search_path=''
as $$
  select encode(extensions.digest(convert_to(coalesce(p_token,''),'utf8'),'sha256'),'hex');
$$;
revoke all on function private.chatgpt_token_hash(text) from public, anon, authenticated;

create or replace function private.chatgpt_urlsafe_token()
returns text
language sql
volatile
security invoker
set search_path=''
as $$
  select translate(
    rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),
    '+/',
    '-_'
  );
$$;
revoke all on function private.chatgpt_urlsafe_token() from public, anon, authenticated;

create or replace function public.chatgpt_issue_authorization_code(
  p_client_id text,
  p_redirect_uri text,
  p_code_challenge text,
  p_code_challenge_method text,
  p_scope text default 'profile:read work:write'
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_code text;
  v_scope text[];
  v_expires timestamptz := now() + interval '5 minutes';
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  if nullif(btrim(coalesce(p_client_id,'')),'') is null then raise exception 'OAuth client_id is required'; end if;
  if nullif(btrim(coalesce(p_redirect_uri,'')),'') is null then raise exception 'OAuth redirect_uri is required'; end if;
  if p_code_challenge_method <> 'S256' or nullif(btrim(coalesce(p_code_challenge,'')),'') is null then
    raise exception 'OAuth PKCE S256 is required';
  end if;

  select array_agg(scope order by scope)
    into v_scope
    from unnest(string_to_array(coalesce(nullif(btrim(p_scope),''),'profile:read work:write'),' ')) as scope
   where scope in ('profile:read','work:write');
  if v_scope is null or not ('profile:read' = any(v_scope)) then
    raise exception 'OAuth profile:read scope is required';
  end if;

  v_code := private.chatgpt_urlsafe_token();
  insert into private.chatgpt_oauth_authorization_codes(
    code_hash,user_id,client_id,redirect_uri,code_challenge,code_challenge_method,scope,expires_at
  ) values (
    private.chatgpt_token_hash(v_code),v_user,p_client_id,p_redirect_uri,
    p_code_challenge,p_code_challenge_method,v_scope,v_expires
  );

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values (
    v_user,'user',v_user::text,'chatgpt.oauth_authorization_issued',
    'chatgpt_oauth_authorization',null,
    jsonb_build_object('client_id',p_client_id,'scope',v_scope,'expires_at',v_expires)
  );
  return jsonb_build_object('code',v_code,'expires_at',v_expires);
end;
$$;
revoke all on function public.chatgpt_issue_authorization_code(text,text,text,text,text) from public, anon;
grant execute on function public.chatgpt_issue_authorization_code(text,text,text,text,text) to authenticated;

create or replace function public.chatgpt_exchange_authorization_code(
  p_code text,
  p_client_id text,
  p_redirect_uri text,
  p_code_verifier text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_code private.chatgpt_oauth_authorization_codes;
  v_access text;
  v_refresh text;
  v_expected_challenge text;
  v_expires timestamptz := now() + interval '30 days';
  v_refresh_expires timestamptz := now() + interval '90 days';
begin
  if nullif(btrim(coalesce(p_code,'')),'') is null or nullif(btrim(coalesce(p_code_verifier,'')),'') is null then
    raise exception 'OAuth code and verifier are required';
  end if;
  select * into v_code
    from private.chatgpt_oauth_authorization_codes
   where code_hash=private.chatgpt_token_hash(p_code)
     and client_id=p_client_id
     and redirect_uri=p_redirect_uri
     and used_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth authorization code'; end if;

  v_expected_challenge := translate(
    rtrim(encode(extensions.digest(convert_to(p_code_verifier,'utf8'),'sha256'),'base64'),'='),
    '+/',
    '-_'
  );
  if v_expected_challenge <> v_code.code_challenge then raise exception 'OAuth PKCE verification failed'; end if;

  update private.chatgpt_oauth_authorization_codes set used_at=now() where id=v_code.id;
  v_access := private.chatgpt_urlsafe_token();
  v_refresh := private.chatgpt_urlsafe_token();
  insert into private.chatgpt_oauth_access_tokens(
    access_token_hash,refresh_token_hash,user_id,client_id,scope,expires_at,refresh_expires_at
  ) values (
    private.chatgpt_token_hash(v_access),private.chatgpt_token_hash(v_refresh),
    v_code.user_id,v_code.client_id,v_code.scope,v_expires,v_refresh_expires
  );
  perform private.assert_active_app_membership(v_code.user_id);
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values (
    v_code.user_id,'chatgpt',v_code.client_id,'chatgpt.oauth_token_issued',
    'chatgpt_oauth_access_token',null,
    jsonb_build_object('scope',v_code.scope,'expires_at',v_expires)
  );
  return jsonb_build_object(
    'access_token',v_access,'token_type','Bearer','expires_in',extract(epoch from (v_expires-now()))::integer,
    'refresh_token',v_refresh,'scope',array_to_string(v_code.scope,' ')
  );
end;
$$;
revoke all on function public.chatgpt_exchange_authorization_code(text,text,text,text) from public;
grant execute on function public.chatgpt_exchange_authorization_code(text,text,text,text) to anon, authenticated;

create or replace function public.chatgpt_refresh_access_token(
  p_refresh_token text,
  p_client_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_old private.chatgpt_oauth_access_tokens;
  v_access text;
  v_refresh text;
  v_expires timestamptz := now() + interval '30 days';
  v_refresh_expires timestamptz := now() + interval '90 days';
begin
  select * into v_old
    from private.chatgpt_oauth_access_tokens
   where refresh_token_hash=private.chatgpt_token_hash(p_refresh_token)
     and client_id=p_client_id
     and revoked_at is null
     and refresh_expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth refresh token'; end if;
  perform private.assert_active_app_membership(v_old.user_id);
  update private.chatgpt_oauth_access_tokens set revoked_at=now() where id=v_old.id;

  v_access := private.chatgpt_urlsafe_token();
  v_refresh := private.chatgpt_urlsafe_token();
  insert into private.chatgpt_oauth_access_tokens(
    access_token_hash,refresh_token_hash,user_id,client_id,scope,expires_at,refresh_expires_at
  ) values (
    private.chatgpt_token_hash(v_access),private.chatgpt_token_hash(v_refresh),
    v_old.user_id,v_old.client_id,v_old.scope,v_expires,v_refresh_expires
  );
  return jsonb_build_object(
    'access_token',v_access,'token_type','Bearer','expires_in',extract(epoch from (v_expires-now()))::integer,
    'refresh_token',v_refresh,'scope',array_to_string(v_old.scope,' ')
  );
end;
$$;
revoke all on function public.chatgpt_refresh_access_token(text,text) from public;
grant execute on function public.chatgpt_refresh_access_token(text,text) to anon, authenticated;

create or replace function public.chatgpt_revoke_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
begin
  update private.chatgpt_oauth_access_tokens
     set revoked_at=coalesce(revoked_at,now())
   where access_token_hash=private.chatgpt_token_hash(p_token)
      or refresh_token_hash=private.chatgpt_token_hash(p_token);
  return found;
end;
$$;
revoke all on function public.chatgpt_revoke_token(text) from public;
grant execute on function public.chatgpt_revoke_token(text) to anon, authenticated;

create or replace function public.chatgpt_connection_status()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_active integer;
  v_last timestamptz;
  v_scope text[];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select count(*)::integer,max(last_used_at),max(scope)
    into v_active,v_last,v_scope
    from private.chatgpt_oauth_access_tokens
   where user_id=v_user and revoked_at is null and expires_at > now();
  return jsonb_build_object(
    'connected',v_active > 0,'active_tokens',v_active,'last_used_at',v_last,
    'scope',coalesce(v_scope,array['profile:read','work:write'])
  );
end;
$$;
revoke all on function public.chatgpt_connection_status() from public, anon;
grant execute on function public.chatgpt_connection_status() to authenticated;

create or replace function public.chatgpt_mcp_call(
  p_access_token text,
  p_tool_name text,
  p_arguments jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_profile public.candidate_profiles;
  v_job public.jobs;
  v_snapshot public.job_snapshots;
  v_analysis public.job_analyses;
  v_application public.applications;
  v_work public.chatgpt_work_items;
  v_result jsonb;
  v_user uuid;
  v_profile_id uuid;
  v_job_id uuid;
  v_application_id uuid;
  v_work_id uuid;
  v_idempotency text;
  v_company text;
  v_title text;
  v_description text;
  v_dedupe text;
  v_content_hash text;
  v_company_id uuid;
  v_snapshot_id uuid;
  v_analysis_id uuid;
  v_reasoning_id uuid;
  v_requested_state text;
  v_cv_family public.cv_family;
  v_scope_required text;
  v_req jsonb;
begin
  if nullif(btrim(coalesce(p_access_token,'')),'') is null then raise exception 'OAuth bearer token required'; end if;
  if length(coalesce(p_arguments,'{}'::jsonb)::text) > 250000 then raise exception 'MCP argument payload is too large'; end if;
  select * into v_token
    from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token)
     and revoked_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  v_user := v_token.user_id;
  perform private.assert_active_app_membership(v_user);
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;

  v_scope_required := case
    when p_tool_name in (
      'get_candidate_profile','get_search_preferences','get_pending_work',
      'get_application_context','get_verified_evidence','get_reusable_answers',
      'get_browser_agent_question_context'
    ) then 'profile:read'
    else 'work:write'
  end;
  if not (v_scope_required = any(v_token.scope)) then raise exception 'OAuth scope is insufficient for this tool'; end if;

  if p_tool_name='get_candidate_profile' then
    select * into v_profile from public.candidate_profiles where user_id=v_user;
    if not found then raise exception 'Candidate profile not found'; end if;
    v_result := jsonb_build_object(
      'user_id',v_user,'profile',jsonb_build_object('id',v_profile.id,'display_name',v_profile.display_name),
      'facts',coalesce((select jsonb_agg(jsonb_build_object(
        'id',f.id,'fact_key',f.fact_key,'value',f.value_json,'verification_status',f.verification_status,
        'source_note',f.source_note
      ) order by f.fact_key) from public.candidate_facts f where f.profile_id=v_profile.id),'[]'::jsonb),
      'evidence',coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.id,'evidence_key',e.evidence_key,'category',e.category,'claim',e.claim,'detail',e.detail,
        'tags',e.tags,'strength',e.strength,'verification_status',e.verification_status,
        'source_locator',e.source_locator
      ) order by e.evidence_key) from public.evidence_items e where e.profile_id=v_profile.id),'[]'::jsonb),
      'preferences',coalesce((select cp.preferences from public.candidate_preferences cp where cp.profile_id=v_profile.id),'{}'::jsonb)
    );

  elsif p_tool_name='get_search_preferences' then
    select id into v_profile_id from public.candidate_profiles where user_id=v_user;
    if v_profile_id is null then raise exception 'Candidate profile not found'; end if;
    v_result := jsonb_build_object(
      'user_id',v_user,
      'preferences',coalesce((select cp.preferences from public.candidate_preferences cp where cp.profile_id=v_profile_id),'{}'::jsonb),
      'cv_families',coalesce((select jsonb_agg(jsonb_build_object(
        'family_key',f.family_key,'label',f.label,'enabled',f.enabled,'is_default',f.is_default
      ) order by f.created_at) from public.candidate_cv_families f where f.profile_id=v_profile_id),'[]'::jsonb)
    );

  elsif p_tool_name='get_pending_work' then
    v_result := jsonb_build_object(
      'user_id',v_user,
      'items',coalesce((select jsonb_agg(jsonb_build_object(
        'id',w.id,'kind',w.kind,'state',w.state,'idempotency_key',w.idempotency_key,
        'input',w.input_json,'output',w.output_json,'error',w.error_json,
        'attempt_count',w.attempt_count,'user_required_at',w.user_required_at,
        'created_at',w.created_at,'updated_at',w.updated_at
      ) order by w.created_at desc) from public.chatgpt_work_items w where w.user_id=v_user and w.state in ('queued','leased','running','user_required')),'[]'::jsonb),
      'reasoning_results',coalesce((select jsonb_agg(jsonb_build_object(
        'id',r.id,'result_kind',r.result_kind,'result',r.result_json,'provenance',r.provenance,
        'created_at',r.created_at,'updated_at',r.updated_at
      ) order by r.updated_at desc) from public.chatgpt_reasoning_results r where r.user_id=v_user limit 20),'[]'::jsonb)
    );

  elsif p_tool_name='get_application_context' then
    v_application_id := nullif(p_arguments->>'application_id','')::uuid;
    select * into v_application from public.applications where id=v_application_id and user_id=v_user;
    if not found then raise exception 'Application not found'; end if;
    select * into v_job from public.jobs where id=v_application.job_id and user_id=v_user;
    select * into v_snapshot from public.job_snapshots where id=v_application.job_snapshot_id;
    select * into v_analysis from public.job_analyses where id=v_application.job_analysis_id;
    v_result := jsonb_build_object(
      'user_id',v_user,
      'application',to_jsonb(v_application)-'user_id',
      'job',case when v_job.id is null then '{}'::jsonb else to_jsonb(v_job)-'user_id' end,
      'snapshot',case when v_snapshot.id is null then '{}'::jsonb else to_jsonb(v_snapshot) end,
      'analysis',case when v_analysis.id is null then '{}'::jsonb else to_jsonb(v_analysis) end,
      'answers',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.application_answers a where a.application_id=v_application.id),'[]'::jsonb),
      'review_package',coalesce((select to_jsonb(rp) from public.application_review_packages rp where rp.application_id=v_application.id),'{}'::jsonb)
    );

  elsif p_tool_name='get_verified_evidence' then
    select id into v_profile_id from public.candidate_profiles where user_id=v_user;
    v_result := jsonb_build_object(
      'user_id',v_user,
      'evidence',coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.id,'evidence_key',e.evidence_key,'category',e.category,'claim',e.claim,'detail',e.detail,
        'tags',e.tags,'strength',e.strength,'source_locator',e.source_locator
      ) order by e.strength desc,e.evidence_key) from public.evidence_items e
       where e.profile_id=v_profile_id and e.verification_status='verified'),'[]'::jsonb)
    );

  elsif p_tool_name='get_reusable_answers' then
    select id into v_profile_id from public.candidate_profiles where user_id=v_user;
    v_result := jsonb_build_object(
      'user_id',v_user,
      'answers',coalesce((select jsonb_agg(jsonb_build_object(
        'id',a.id,'answer_key',a.answer_key,'value_text',a.value_text,
        'trust',a.trust,'verification_status',a.verification_status
      ) order by a.answer_key) from public.reusable_answers a
       where a.profile_id=v_profile_id and a.verification_status='verified' and not a.sensitive),'[]'::jsonb)
    );

  elsif p_tool_name='get_browser_agent_question_context' then
    v_result := jsonb_build_object(
      'user_id',v_user,
      'sessions',coalesce((select jsonb_agg(jsonb_build_object(
        'id',s.id,'application_id',s.application_id,'status',s.status,'provider_hint',s.provider_hint,
        'current_url',s.current_url,'current_title',s.current_title,'pause_reasons',s.pause_reasons,
        'final_review',s.final_review_json,'started_at',s.started_at,'updated_at',s.updated_at
      ) order by s.updated_at desc) from public.form_agent_sessions s
       where s.user_id=v_user and s.status in ('needs_user','active','final_review')),'[]'::jsonb)
    );

  elsif p_tool_name='save_discovered_job' then
    v_company := nullif(btrim(p_arguments->>'company'),'');
    v_title := nullif(btrim(p_arguments->>'title'),'');
    if v_company is null or v_title is null then raise exception 'company and title are required'; end if;
    v_dedupe := nullif(btrim(p_arguments->>'dedupe_key'),'');
    if v_dedupe is null then
      v_dedupe := lower(encode(extensions.digest(convert_to(
        v_company||'|'||v_title||'|'||coalesce(p_arguments->>'application_url',p_arguments->>'source_url',''),'utf8'),'sha256'),'hex'));
    end if;
    insert into public.companies(user_id,canonical_name,website)
    values(v_user,v_company,nullif(btrim(p_arguments->>'company_website'),''))
    on conflict(user_id,canonical_name) do update set website=coalesce(excluded.website,public.companies.website)
    returning id into v_company_id;
    insert into public.jobs(
      user_id,company_id,title,external_job_id,source_url,application_url,location_text,work_mode,
      salary_text,salary_min,salary_max,salary_currency,posted_at,closes_at,employment_type,ats_provider,
      discovery_source,dedupe_key,triage_reason
    ) values (
      v_user,v_company_id,v_title,nullif(p_arguments->>'external_job_id',''),nullif(p_arguments->>'source_url',''),
      nullif(p_arguments->>'application_url',''),nullif(p_arguments->>'location',''),nullif(p_arguments->>'work_mode',''),
      nullif(p_arguments->>'salary_text',''),nullif(p_arguments->>'salary_min','')::numeric,
      nullif(p_arguments->>'salary_max','')::numeric,coalesce(nullif(p_arguments->>'salary_currency',''),'GBP'),
      nullif(p_arguments->>'posted_at','')::timestamptz,nullif(p_arguments->>'closes_at','')::timestamptz,
      nullif(p_arguments->>'employment_type',''),nullif(p_arguments->>'ats_provider',''),'chatgpt_mcp',v_dedupe,
      'Discovered by the authenticated ChatGPT job-search worker; analysis is still required.'
    )
    on conflict(user_id,dedupe_key) where dedupe_key is not null do update set
      source_url=coalesce(excluded.source_url,public.jobs.source_url),
      application_url=coalesce(excluded.application_url,public.jobs.application_url),
      location_text=coalesce(excluded.location_text,public.jobs.location_text),
      updated_at=now()
    returning * into v_job;
    v_description := coalesce(nullif(p_arguments->>'description',''),'No vacancy description supplied by the source.');
    v_content_hash := encode(extensions.digest(convert_to(v_description,'utf8'),'sha256'),'hex');
    insert into public.job_snapshots(job_id,title,company_name,description_text,source_url,raw_metadata,content_hash)
    values(v_job.id,v_title,v_company,v_description,coalesce(p_arguments->>'source_url',p_arguments->>'application_url'),coalesce(p_arguments->'raw_metadata','{}'::jsonb),v_content_hash)
    on conflict(job_id,content_hash) where content_hash is not null do update set captured_at=public.job_snapshots.captured_at
    returning id into v_snapshot_id;
    update public.jobs set current_snapshot_id=v_snapshot_id,updated_at=now() where id=v_job.id;
    v_result := jsonb_build_object('user_id',v_user,'job_id',v_job.id,'snapshot_id',v_snapshot_id,'dedupe_key',v_dedupe,'created_or_reused',true);

  elsif p_tool_name='save_job_analysis' then
    v_job_id := nullif(p_arguments->>'job_id','')::uuid;
    select * into v_job from public.jobs where id=v_job_id and user_id=v_user;
    if not found then raise exception 'Job not found'; end if;
    v_analysis_id := extensions.gen_random_uuid();
    insert into public.job_analyses(
      id,job_id,model,contract_version,eligibility,eligibility_notes,fit_score,priority_score,
      fit_components,priority_components,recommended_cv_family,strengths,weaknesses,application_strategy,
      cover_letter_value,evidence_item_ids,analysis_source,triage,triage_reason
    ) values (
      v_analysis_id,v_job.id,nullif(p_arguments->>'model',''),'m19.chatgpt.v1',
      coalesce(nullif(p_arguments->>'eligibility','')::public.eligibility_state,'unknown'::public.eligibility_state),
      coalesce(array(select value from jsonb_array_elements_text(coalesce(p_arguments->'eligibility_notes','[]'::jsonb))), '{}'),
      greatest(0,least(100,coalesce((p_arguments->>'fit_score')::numeric,0))),
      greatest(0,least(100,coalesce((p_arguments->>'priority_score')::numeric,0))),
      coalesce(p_arguments->'fit_components','{}'::jsonb),coalesce(p_arguments->'priority_components','{}'::jsonb),
      nullif(p_arguments->>'recommended_cv_family','')::public.cv_family,
      coalesce(p_arguments->'strengths','[]'::jsonb),coalesce(p_arguments->'weaknesses','[]'::jsonb),
      nullif(p_arguments->>'application_strategy',''),
      coalesce(nullif(p_arguments->>'cover_letter_value',''),'low'),
      coalesce(array(select value::uuid from jsonb_array_elements_text(coalesce(p_arguments->'evidence_item_ids','[]'::jsonb))), '{}'),
      'chatgpt_mcp',nullif(p_arguments->>'triage','')::public.job_triage,nullif(p_arguments->>'triage_reason','')
    ) returning * into v_analysis;
    delete from public.job_requirements where job_id=v_job.id and analysis_id=v_analysis.id;
    for v_req in select value from jsonb_array_elements(coalesce(p_arguments->'requirements','[]'::jsonb)) loop
      insert into public.job_requirements(job_id,analysis_id,requirement_text,requirement_type,category,evidence_item_ids,match_score)
      values(
        v_job.id,v_analysis.id,coalesce(v_req->>'text',''),coalesce(v_req->>'type','context'),
        nullif(v_req->>'category',''),coalesce(array(select value::uuid from jsonb_array_elements_text(coalesce(v_req->'evidence_item_ids','[]'::jsonb))), '{}'),
        greatest(0,least(100,coalesce((v_req->>'match_score')::integer,0)))
      );
    end loop;
    update public.jobs set triage=v_analysis.triage,triage_reason=v_analysis.triage_reason,updated_at=now() where id=v_job.id;
    v_result := jsonb_build_object('user_id',v_user,'job_id',v_job.id,'analysis_id',v_analysis.id,'analysis_source','chatgpt_mcp');

  elsif p_tool_name='save_application_package' then
    v_job_id := nullif(p_arguments->>'job_id','')::uuid;
    select * into v_job from public.jobs where id=v_job_id and user_id=v_user;
    if not found then raise exception 'Job not found'; end if;
    if v_job.current_snapshot_id is null then raise exception 'Job must have a frozen snapshot before preparing an application'; end if;
    select * into v_analysis from public.job_analyses where job_id=v_job.id order by created_at desc limit 1;
    v_requested_state := coalesce(nullif(p_arguments->>'state',''),'preparing');
    if v_requested_state not in ('preparing','shortlisted','discovered') then raise exception 'ChatGPT cannot approve or submit applications'; end if;
    if nullif(p_arguments->>'selected_cv_family','') is not null then
      v_cv_family := (p_arguments->>'selected_cv_family')::public.cv_family;
    end if;
    insert into public.applications(
      user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,preparation_origin,
      preparation_metadata,next_action,notes
    ) values (
      v_user,v_job.id,v_requested_state::public.application_state,v_job.current_snapshot_id,
      v_analysis.id,v_cv_family,'auto_prepare',
      jsonb_build_object('source','chatgpt_mcp','gate1_required',true,'application_package',coalesce(p_arguments->'package','{}'::jsonb)),
      'Human Gate 1 review is required before any employer-form work.',
      nullif(p_arguments->>'notes','')
    )
    on conflict(user_id,job_id) do update set
      preparation_metadata=public.applications.preparation_metadata || excluded.preparation_metadata,
      next_action='Human Gate 1 review is required before any employer-form work.',
      updated_at=now()
    returning * into v_application;
    if v_analysis.id is not null then
      insert into public.application_strategies(application_id,job_analysis_id,strategy_text,evidence_item_ids)
      values(v_application.id,v_analysis.id,coalesce(p_arguments->>'strategy_text',v_analysis.application_strategy,''),v_analysis.evidence_item_ids)
      on conflict do nothing;
    end if;
    v_result := jsonb_build_object('user_id',v_user,'application_id',v_application.id,'state',v_application.state,'gate1_required',true);

  elsif p_tool_name='report_user_required_question' then
    v_idempotency := coalesce(nullif(p_arguments->>'idempotency_key',''), 'question:'||md5(p_arguments::text));
    insert into public.chatgpt_work_items(user_id,kind,state,idempotency_key,input_json,user_required_at)
    values(v_user,'user_required_question','user_required',v_idempotency,coalesce(p_arguments,'{}'::jsonb),now())
    on conflict(user_id,idempotency_key) do update set
      input_json=excluded.input_json,state='user_required',user_required_at=coalesce(public.chatgpt_work_items.user_required_at,now()),updated_at=now()
    returning * into v_work;
    v_result := jsonb_build_object('user_id',v_user,'work_item_id',v_work.id,'state',v_work.state,'question',p_arguments->>'question');

  elsif p_tool_name='queue_application_for_review' then
    v_application_id := nullif(p_arguments->>'application_id','')::uuid;
    select * into v_application from public.applications where id=v_application_id and user_id=v_user;
    if not found then raise exception 'Application not found'; end if;
    v_idempotency := coalesce(nullif(p_arguments->>'idempotency_key',''), 'review:'||v_application_id::text);
    insert into public.chatgpt_work_items(user_id,kind,state,idempotency_key,input_json,user_required_at)
    values(v_user,'application_review','user_required',v_idempotency,coalesce(p_arguments,'{}'::jsonb),now())
    on conflict(user_id,idempotency_key) do update set state='user_required',updated_at=now()
    returning * into v_work;
    v_result := jsonb_build_object('user_id',v_user,'work_item_id',v_work.id,'application_id',v_application_id,'state','user_required','gate1_required',true,'submission_allowed',false);

  elsif p_tool_name='save_reasoning_result' then
    v_idempotency := coalesce(nullif(p_arguments->>'idempotency_key',''), 'reasoning:'||md5(p_arguments::text));
    v_work_id := nullif(p_arguments->>'work_item_id','')::uuid;
    if v_work_id is not null and not exists(select 1 from public.chatgpt_work_items where id=v_work_id and user_id=v_user) then
      raise exception 'Work item not found';
    end if;
    insert into public.chatgpt_reasoning_results(user_id,work_item_id,idempotency_key,result_kind,result_json,provenance)
    values(v_user,v_work_id,v_idempotency,coalesce(nullif(p_arguments->>'result_kind',''),'general'),coalesce(p_arguments->'result','{}'::jsonb),jsonb_build_object('source','chatgpt_mcp','model',p_arguments->>'model'))
    on conflict(user_id,idempotency_key) do update set
      result_json=excluded.result_json,provenance=excluded.provenance,work_item_id=coalesce(excluded.work_item_id,public.chatgpt_reasoning_results.work_item_id),updated_at=now()
    returning id into v_reasoning_id;
    v_result := jsonb_build_object('user_id',v_user,'reasoning_result_id',v_reasoning_id,'idempotency_key',v_idempotency,'persisted',true);

  elsif p_tool_name='mark_work_item_complete' then
    v_work_id := nullif(p_arguments->>'work_item_id','')::uuid;
    update public.chatgpt_work_items
       set state='completed',output_json=coalesce(p_arguments->'output','{}'::jsonb),error_json=null,
           completed_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()
     where id=v_work_id and user_id=v_user and state in ('queued','leased','running','user_required');
    if not found then raise exception 'Work item not found or cannot be completed'; end if;
    v_result := jsonb_build_object('user_id',v_user,'work_item_id',v_work_id,'state','completed');

  elsif p_tool_name='mark_work_item_failed' then
    v_work_id := nullif(p_arguments->>'work_item_id','')::uuid;
    update public.chatgpt_work_items
       set state='failed',error_json=coalesce(p_arguments->'error',jsonb_build_object('message','ChatGPT worker reported failure')),
           last_error=coalesce(p_arguments->'message',p_arguments->'error'->>'message','ChatGPT worker reported failure'),
           failed_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()
     where id=v_work_id and user_id=v_user and state in ('queued','leased','running','user_required');
    if not found then raise exception 'Work item not found or cannot be failed'; end if;
    v_result := jsonb_build_object('user_id',v_user,'work_item_id',v_work_id,'state','failed');

  else
    raise exception 'Unsupported ChatGPT MCP tool: %',p_tool_name;
  end if;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'chatgpt',v_token.client_id,'chatgpt.tool.'||p_tool_name,'chatgpt_tool_call',null,
         jsonb_build_object('tool',p_tool_name,'scope_required',v_scope_required,'argument_keys',(
           select coalesce(jsonb_agg(key order by key),'[]'::jsonb) from jsonb_object_keys(coalesce(p_arguments,'{}'::jsonb)) as key
         )));
  return v_result;
end;
$$;
revoke all on function public.chatgpt_mcp_call(text,text,jsonb) from public;
grant execute on function public.chatgpt_mcp_call(text,text,jsonb) to anon, authenticated;

comment on table public.chatgpt_work_items is 'M19 per-user ChatGPT MCP work queue. Direct client access is intentionally denied; use the authenticated MCP boundary.';
comment on table private.chatgpt_oauth_access_tokens is 'M19 hashed short-lived ChatGPT OAuth tokens; raw bearer tokens are never stored.';
