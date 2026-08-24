-- Milestone 25: let the authenticated ChatGPT worker classify pending Gmail
-- messages without exposing direct table access or weakening the human gates.

alter table public.emails
  add column if not exists classification_source text not null default 'deterministic',
  add column if not exists classification_model text,
  add column if not exists chatgpt_classified_at timestamptz;

create index if not exists emails_chatgpt_pending_idx
  on public.emails(user_id, chatgpt_classified_at, received_at desc)
  where needs_user = true;

create or replace function private.chatgpt_get_pending_email_classifications_internal(
  p_access_token text,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 25));
  v_emails jsonb;
  v_applications jsonb;
begin
  select * into v_token
    from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token)
     and revoked_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('profile:read'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for email classification reads'; end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,
    'provider_message_id',e.provider_message_id,
    'provider_thread_id',e.provider_thread_id,
    'sender',e.sender,
    'subject',e.subject,
    'received_at',e.received_at,
    'snippet',left(coalesce(e.snippet,''),2000),
    'body_text',left(coalesce(e.body_text,e.snippet,''),12000),
    'classification',e.classification,
    'confidence',e.confidence,
    'classification_reason',e.classification_reason,
    'classification_source',e.classification_source,
    'needs_user',e.needs_user,
    'current_matches',coalesce((
      select jsonb_agg(jsonb_build_object(
        'application_id',l.application_id,
        'confidence',l.confidence,
        'method',l.match_method,
        'reason',l.reason,
        'is_primary',l.is_primary,
        'company',c.canonical_name,
        'role',j.title
      ) order by l.is_primary desc,l.confidence desc nulls last)
      from public.application_email_links l
      join public.applications a on a.id=l.application_id and a.user_id=v_token.user_id
      join public.jobs j on j.id=a.job_id
      left join public.companies c on c.id=j.company_id
      where l.email_id=e.id
    ),'[]'::jsonb)
  ) order by e.received_at desc nulls last,e.created_at desc),'[]'::jsonb)
    into v_emails
    from (
      select *
        from public.emails
       where user_id=v_token.user_id
         and needs_user=true
         and chatgpt_classified_at is null
       order by received_at desc nulls last,created_at desc
       limit v_limit
    ) e;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,
    'job_id',j.id,
    'company',coalesce(c.canonical_name,''),
    'role',coalesce(j.title,''),
    'external_job_id',j.external_job_id,
    'state',a.state,
    'applied_at',a.applied_at,
    'submitted_at',a.submitted_at,
    'external_application_id',a.external_application_id,
    'deadline_at',a.deadline_at,
    'next_action',a.next_action
  ) order by coalesce(a.applied_at,a.updated_at) desc),'[]'::jsonb)
    into v_applications
    from (
      select a.*,j.id as joined_job_id,j.title,j.external_job_id,j.company_id
        from public.applications a
        join public.jobs j on j.id=a.job_id
       where a.user_id=v_token.user_id
       order by coalesce(a.applied_at,a.updated_at) desc
       limit 100
    ) a
    join public.jobs j on j.id=a.joined_job_id
    left join public.companies c on c.id=a.company_id;

  return jsonb_build_object(
    'user_id',v_token.user_id,
    'limit',v_limit,
    'emails',v_emails,
    'applications',v_applications,
    'classification_contract',jsonb_build_object(
      'categories',jsonb_build_array('confirmation','rejection','assessment','interview','offer','recruiter_message','other','uncertain'),
      'automatically_resolved_when', 'Use a confident category and application match for ordinary status events.',
      'human_review', jsonb_build_array('offer','recruiter_message','uncertain','unmatched or ambiguous application matches')
    )
  );
end;
$$;
revoke all on function private.chatgpt_get_pending_email_classifications_internal(text,integer) from public,anon,authenticated;
grant execute on function private.chatgpt_get_pending_email_classifications_internal(text,integer) to anon,authenticated;

create or replace function private.chatgpt_classify_email_internal(
  p_access_token text,
  p_email_id uuid,
  p_application_id uuid,
  p_classification public.email_classification,
  p_classification_confidence numeric,
  p_classification_reason text,
  p_match_confidence numeric default null,
  p_match_method text default null,
  p_match_reason text default null,
  p_model text default 'chatgpt',
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token private.chatgpt_oauth_access_tokens;
  v_email public.emails;
  v_app public.applications;
  v_needs_user boolean := false;
  v_target public.application_state := null;
  v_deadline timestamptz := null;
  v_metadata jsonb;
begin
  select * into v_token
    from private.chatgpt_oauth_access_tokens
   where access_token_hash=private.chatgpt_token_hash(p_access_token)
     and revoked_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'Invalid or expired OAuth bearer token'; end if;
  perform private.assert_active_app_membership(v_token.user_id);
  if not ('work:write'=any(v_token.scope)) then raise exception 'OAuth scope is insufficient for email classification writes'; end if;
  update private.chatgpt_oauth_access_tokens set last_used_at=now() where id=v_token.id;

  if p_email_id is null then raise exception 'Email id is required'; end if;
  if p_classification_confidence is null or p_classification_confidence < 0 or p_classification_confidence > 1 then
    raise exception 'Invalid classification confidence';
  end if;
  if p_match_confidence is not null and (p_match_confidence < 0 or p_match_confidence > 1) then
    raise exception 'Invalid match confidence';
  end if;
  if length(coalesce(p_classification_reason,'')) > 4000 then raise exception 'Classification reason is too long'; end if;
  if length(coalesce(p_model,'')) > 200 then raise exception 'Classification model is too long'; end if;
  if jsonb_typeof(coalesce(p_metadata,'{}'::jsonb)) <> 'object' then raise exception 'Classification metadata must be an object'; end if;

  select * into v_email
    from public.emails
   where id=p_email_id and user_id=v_token.user_id
   for update;
  if not found then raise exception 'Email not found'; end if;

  -- A retried ChatGPT call is a strict no-op after the item has been stamped.
  if v_email.chatgpt_classified_at is not null then
    return jsonb_build_object(
      'email_id',v_email.id,
      'classification',v_email.classification,
      'application_id',(select l.application_id from public.application_email_links l where l.email_id=v_email.id and l.is_primary=true order by l.confidence desc nulls last limit 1),
      'needs_user',v_email.needs_user,
      'classification_source',v_email.classification_source,
      'already_processed',true
    );
  end if;

  if p_application_id is not null then
    select * into v_app
      from public.applications
     where id=p_application_id and user_id=v_token.user_id
     for update;
    if not found then raise exception 'Application not found'; end if;
    update public.application_email_links set is_primary=false where email_id=p_email_id;
    insert into public.application_email_links(application_id,email_id,confidence,match_method,reason,is_primary)
    values(p_application_id,p_email_id,p_match_confidence,coalesce(nullif(p_match_method,''),'chatgpt'),coalesce(nullif(p_match_reason,''),'ChatGPT matched the email to this application.'),true)
    on conflict(application_id,email_id) do update set
      confidence=excluded.confidence,match_method=excluded.match_method,reason=excluded.reason,is_primary=true;
    update public.applications set
      last_email_at=greatest(coalesce(last_email_at,'epoch'::timestamptz),coalesce(v_email.received_at,now())),
      last_email_id=v_email.id,
      updated_at=now()
    where id=p_application_id;
  else
    update public.application_email_links set is_primary=false where email_id=p_email_id;
  end if;

  -- Offers and recruiter messages are categorised automatically but retain a
  -- human decision point. Ordinary events may update only the narrow
  -- post-submission states when both confidences meet the existing floors.
  if p_classification='other' then
    v_needs_user := false;
  elsif p_classification in ('offer','recruiter_message','uncertain') then
    v_needs_user := true;
  elsif p_application_id is null then
    v_needs_user := true;
  else
    v_needs_user := p_classification_confidence < (case when p_classification='confirmation' then 0.90 else 0.94 end)
                    or coalesce(p_match_confidence,0) < (case when p_classification='confirmation' then 0.78 else 0.86 end);
  end if;

  v_metadata := coalesce(v_email.metadata,'{}'::jsonb) || coalesce(p_metadata,'{}'::jsonb);

  if not v_needs_user and p_application_id is not null then
    select * into v_app from public.applications where id=p_application_id and user_id=v_token.user_id for update;
    if p_classification='confirmation' and v_app.state='submitted' then v_target := 'awaiting_response'; end if;
    if p_classification='rejection' and v_app.state in ('submitted','awaiting_response','assessment','interview') then v_target := 'rejected'; end if;
    if p_classification='assessment' and v_app.state in ('submitted','awaiting_response') then v_target := 'assessment'; end if;
    if p_classification='interview' and v_app.state in ('submitted','awaiting_response','assessment') then v_target := 'interview'; end if;

    if v_target is not null and v_target is distinct from v_app.state then
      update public.applications set state=v_target,updated_at=now() where id=v_app.id;
      update public.emails set proposed_state=v_target,auto_applied_at=now() where id=v_email.id;
      insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
      values(v_token.user_id,'chatgpt',v_token.client_id,'application.state_changed_from_email','application',v_app.id,
        jsonb_build_object('from_state',v_app.state,'to_state',v_target,'email_id',v_email.id,'classification',p_classification,'classification_confidence',p_classification_confidence,'match_confidence',p_match_confidence,'automation','chatgpt_mcp'));
    end if;

    if p_classification='assessment' then
      begin v_deadline := nullif(v_metadata->>'deadline_at','')::timestamptz; exception when others then v_deadline := null; end;
      update public.assessments set source_email_id=v_email.id,provider=coalesce(provider,nullif(v_metadata->>'provider_hint','')),deadline_at=coalesce(v_deadline,deadline_at),updated_at=now()
      where id=(select id from public.assessments where application_id=p_application_id and source_email_id is null and status in ('pending','in_progress') order by created_at desc limit 1);
      if not found then
        insert into public.assessments(application_id,provider,assessment_type,invited_at,deadline_at,status,notes,source_email_id)
        values(p_application_id,nullif(v_metadata->>'provider_hint',''),'online assessment',v_email.received_at,v_deadline,'pending',v_email.subject,v_email.id)
        on conflict(source_email_id) where source_email_id is not null do update set deadline_at=coalesce(excluded.deadline_at,public.assessments.deadline_at),updated_at=now();
      end if;
    elsif p_classification='interview' then
      update public.interviews set source_email_id=v_email.id,updated_at=now()
      where id=(select id from public.interviews where application_id=p_application_id and source_email_id is null and status in ('scheduled','rescheduled') order by created_at desc limit 1);
      if not found then
        insert into public.interviews(application_id,interview_type,round_label,scheduled_at,status,notes,source_email_id)
        values(p_application_id,'interview','Email invitation',null,'scheduled',v_email.subject,v_email.id)
        on conflict(source_email_id) where source_email_id is not null do update set updated_at=now();
      end if;
    end if;
  end if;

  update public.emails set
    classification=p_classification,
    confidence=p_classification_confidence,
    classification_reason=coalesce(nullif(p_classification_reason,''),'Classified by ChatGPT.'),
    classification_source='chatgpt',
    classification_model=coalesce(nullif(p_model,''),'chatgpt'),
    chatgpt_classified_at=now(),
    metadata=v_metadata,
    needs_user=v_needs_user,
    proposed_state=v_target,
    auto_applied_at=case when v_target is not null then coalesce(auto_applied_at,now()) else auto_applied_at end,
    processed_at=now()
  where id=v_email.id;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_token.user_id,'chatgpt',v_token.client_id,'email.classified_by_chatgpt','email',v_email.id,
    jsonb_build_object('classification',p_classification,'confidence',p_classification_confidence,'application_id',p_application_id,'match_confidence',p_match_confidence,'needs_user',v_needs_user,'model',coalesce(nullif(p_model,''),'chatgpt')));

  return jsonb_build_object(
    'email_id',v_email.id,
    'application_id',p_application_id,
    'classification',p_classification,
    'classification_confidence',p_classification_confidence,
    'classification_source','chatgpt',
    'needs_user',v_needs_user,
    'auto_state',v_target,
    'already_processed',false
  );
end;
$$;
revoke all on function private.chatgpt_classify_email_internal(text,uuid,uuid,public.email_classification,numeric,text,numeric,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function private.chatgpt_classify_email_internal(text,uuid,uuid,public.email_classification,numeric,text,numeric,text,text,text,jsonb) to anon,authenticated;

create or replace function chatgpt_internal.get_pending_email_classifications(p_access_token text,p_limit integer default 20)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_get_pending_email_classifications_internal(p_access_token,p_limit); $$;
create or replace function chatgpt_internal.classify_email(
  p_access_token text,p_email_id uuid,p_application_id uuid,p_classification public.email_classification,
  p_classification_confidence numeric,p_classification_reason text,p_match_confidence numeric default null,
  p_match_method text default null,p_match_reason text default null,p_model text default 'chatgpt',p_metadata jsonb default '{}'::jsonb
)
returns jsonb language sql security definer set search_path=''
as $$ select private.chatgpt_classify_email_internal(p_access_token,p_email_id,p_application_id,p_classification,p_classification_confidence,p_classification_reason,p_match_confidence,p_match_method,p_match_reason,p_model,p_metadata); $$;

revoke all on function chatgpt_internal.get_pending_email_classifications(text,integer) from public,anon,authenticated;
revoke all on function chatgpt_internal.classify_email(text,uuid,uuid,public.email_classification,numeric,text,numeric,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function chatgpt_internal.get_pending_email_classifications(text,integer),chatgpt_internal.classify_email(text,uuid,uuid,public.email_classification,numeric,text,numeric,text,text,text,jsonb) to anon,authenticated;

create or replace function public.chatgpt_get_pending_email_classifications(p_access_token text,p_limit integer default 20)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.get_pending_email_classifications($1,$2); $$;
create or replace function public.chatgpt_classify_email(
  p_access_token text,p_email_id uuid,p_application_id uuid,p_classification public.email_classification,
  p_classification_confidence numeric,p_classification_reason text,p_match_confidence numeric default null,
  p_match_method text default null,p_match_reason text default null,p_model text default 'chatgpt',p_metadata jsonb default '{}'::jsonb
)
returns jsonb language sql security invoker set search_path=''
as $$ select chatgpt_internal.classify_email($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11); $$;

revoke all on function public.chatgpt_get_pending_email_classifications(text,integer),public.chatgpt_classify_email(text,uuid,uuid,public.email_classification,numeric,text,numeric,text,text,text,jsonb) from public,authenticated;
grant execute on function public.chatgpt_get_pending_email_classifications(text,integer),public.chatgpt_classify_email(text,uuid,uuid,public.email_classification,numeric,text,numeric,text,text,text,jsonb) to anon;

