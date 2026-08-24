-- Detailed applicant-profile ingestion and a complete, verified MCP profile read.

alter table public.candidate_source_documents
  add column if not exists source_type text not null default 'cv_upload';

alter table public.candidate_extraction_proposals
  add column if not exists materialized_entity_type text,
  add column if not exists materialized_entity_id uuid;

create index if not exists candidate_extraction_proposals_materialized_entity_idx
  on public.candidate_extraction_proposals(materialized_entity_type, materialized_entity_id)
  where materialized_entity_id is not null;

create or replace function private.tag_chatgpt_audit_project()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.actor_type='chatgpt' then
    new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object('chatgpt_project','Job Hunt');
  end if;
  return new;
end;
$$;

revoke all on function private.tag_chatgpt_audit_project() from public, anon, authenticated;
drop trigger if exists audit_events_tag_chatgpt_project on public.audit_events;
create trigger audit_events_tag_chatgpt_project
  before insert on public.audit_events
  for each row execute function private.tag_chatgpt_audit_project();

-- The MCP server cannot create a ChatGPT UI Project through the MCP protocol.
-- This verified profile boundary is nevertheless labelled consistently so the
-- ChatGPT setup can be placed in the user's ChatGPT Project named "Job Hunt".
create or replace function private.chatgpt_get_detailed_candidate_profile_internal(p_access_token text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_user uuid;
  v_profile uuid;
begin
  if nullif(btrim(coalesce(p_access_token,'')),'') is null then
    raise exception 'OAuth bearer token required';
  end if;

  select * into v_token
    from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token)
     and revoked_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  if not ('profile:read' = any(v_token.scope)) then raise exception 'OAuth scope is insufficient for this tool'; end if;

  v_user := v_token.user_id;
  perform private.assert_active_app_membership(v_user);
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;

  select id into v_profile from public.candidate_profiles where user_id=v_user;
  if v_profile is null then raise exception 'Candidate profile not found'; end if;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(
    v_user,'chatgpt',v_token.client_id,'chatgpt.tool.get_detailed_candidate_profile',
    'chatgpt_tool_call',null,jsonb_build_object('tool','get_detailed_candidate_profile','project','Job Hunt')
  );

  return jsonb_build_object(
    'project','Job Hunt',
    'user_id',v_user,
    'profile',(select jsonb_build_object('id',p.id,'display_name',p.display_name)
      from public.candidate_profiles p where p.id=v_profile),
    'facts',coalesce((select jsonb_agg(to_jsonb(f)-'profile_id' order by f.fact_key)
      from public.candidate_facts f where f.profile_id=v_profile and f.verification_status='verified'),'[]'::jsonb),
    'employment',coalesce((select jsonb_agg(to_jsonb(e)-'profile_id' order by e.start_date desc nulls last,e.created_at desc)
      from public.candidate_employment e where e.profile_id=v_profile and e.verification_status='verified'),'[]'::jsonb),
    'education',coalesce((select jsonb_agg(to_jsonb(e)-'profile_id' order by e.start_date desc nulls last,e.created_at desc)
      from public.candidate_education e where e.profile_id=v_profile and e.verification_status='verified'),'[]'::jsonb),
    'skills',coalesce((select jsonb_agg(to_jsonb(s)-'profile_id' order by s.name)
      from public.candidate_skills s where s.profile_id=v_profile and s.verification_status='verified'),'[]'::jsonb),
    'projects',coalesce((select jsonb_agg(to_jsonb(pj)-'profile_id' order by pj.created_at desc)
      from public.candidate_projects pj where pj.profile_id=v_profile and pj.verification_status='verified'),'[]'::jsonb),
    'publications',coalesce((select jsonb_agg(to_jsonb(pub)-'profile_id' order by pub.published_on desc nulls last,pub.created_at desc)
      from public.candidate_publications pub where pub.profile_id=v_profile and pub.verification_status='verified'),'[]'::jsonb),
    'evidence',coalesce((select jsonb_agg(to_jsonb(evi)-'profile_id' order by evi.strength desc,evi.evidence_key)
      from public.evidence_items evi where evi.profile_id=v_profile and evi.verification_status='verified'),'[]'::jsonb),
    'preferences',coalesce((select cp.preferences from public.candidate_preferences cp where cp.profile_id=v_profile),'{}'::jsonb),
    'cv_families',coalesce((select jsonb_agg(to_jsonb(cf)-'profile_id' order by cf.created_at)
      from public.candidate_cv_families cf where cf.profile_id=v_profile and cf.enabled),'[]'::jsonb),
    'reusable_answers',coalesce((select jsonb_agg(to_jsonb(ra)-'profile_id' order by ra.answer_key)
      from public.reusable_answers ra where ra.profile_id=v_profile and ra.verification_status='verified' and not ra.sensitive),'[]'::jsonb),
    'source_documents',coalesce((select jsonb_agg(jsonb_build_object(
        'id',sd.id,'original_name',sd.original_name,'source_type',sd.source_type,
        'mime_type',sd.mime_type,'byte_size',sd.byte_size,'extraction_status',sd.extraction_status,
        'extraction_format',sd.extraction_format,'extracted_at',sd.extracted_at
      ) order by sd.created_at desc)
      from public.candidate_source_documents sd where sd.profile_id=v_profile),'[]'::jsonb)
  );
end;
$$;

revoke all on function private.chatgpt_get_detailed_candidate_profile_internal(text) from public, anon, authenticated;
grant execute on function private.chatgpt_get_detailed_candidate_profile_internal(text) to anon, authenticated;

create or replace function chatgpt_internal.get_detailed_candidate_profile(p_access_token text)
returns jsonb
language sql
security definer
set search_path=''
as $$
  select private.chatgpt_get_detailed_candidate_profile_internal(p_access_token);
$$;

revoke all on function chatgpt_internal.get_detailed_candidate_profile(text) from public, anon, authenticated;
grant execute on function chatgpt_internal.get_detailed_candidate_profile(text) to anon, authenticated;

create or replace function public.chatgpt_get_detailed_candidate_profile(p_access_token text)
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select chatgpt_internal.get_detailed_candidate_profile(p_access_token);
$$;

revoke all on function public.chatgpt_get_detailed_candidate_profile(text) from public, authenticated;
grant execute on function public.chatgpt_get_detailed_candidate_profile(text) to anon, authenticated;
