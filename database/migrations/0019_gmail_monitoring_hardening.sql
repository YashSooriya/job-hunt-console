-- Milestone 8 hardening: keep SECURITY INVOKER audit writes RLS-safe and make manual review create event records.

create or replace function public.process_application_email(
  p_provider_message_id text,
  p_provider_thread_id text,
  p_sender text,
  p_subject text,
  p_received_at timestamptz,
  p_snippet text,
  p_body_text text,
  p_classification public.email_classification,
  p_classification_confidence numeric,
  p_classification_reason text,
  p_application_id uuid,
  p_match_confidence numeric,
  p_match_method text,
  p_match_reason text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email public.emails;
  v_app public.applications;
  v_needs_user boolean := false;
  v_target public.application_state := null;
  v_deadline timestamptz := null;
  v_threshold numeric := 0.86;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(btrim(coalesce(p_provider_message_id,'')),'') is null then raise exception 'Provider message id is required'; end if;
  if p_classification_confidence is null or p_classification_confidence < 0 or p_classification_confidence > 1 then raise exception 'Invalid classification confidence'; end if;
  if p_match_confidence is not null and (p_match_confidence < 0 or p_match_confidence > 1) then raise exception 'Invalid match confidence'; end if;

  insert into public.emails(
    user_id,provider_message_id,provider_thread_id,sender,subject,received_at,classification,confidence,
    snippet,body_text,classification_reason,metadata,processed_at
  ) values (
    v_user,p_provider_message_id,p_provider_thread_id,p_sender,p_subject,p_received_at,p_classification,p_classification_confidence,
    p_snippet,p_body_text,p_classification_reason,coalesce(p_metadata,'{}'::jsonb),now()
  )
  on conflict(user_id,provider_message_id) do update set
    provider_thread_id=excluded.provider_thread_id,
    sender=excluded.sender,
    subject=excluded.subject,
    received_at=excluded.received_at,
    classification=excluded.classification,
    confidence=excluded.confidence,
    snippet=excluded.snippet,
    body_text=excluded.body_text,
    classification_reason=excluded.classification_reason,
    metadata=excluded.metadata,
    processed_at=now()
  returning * into v_email;

  if p_application_id is not null then
    select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
    if not found then raise exception 'Matched application not found'; end if;
    insert into public.application_email_links(application_id,email_id,confidence,match_method,reason,is_primary)
    values(p_application_id,v_email.id,p_match_confidence,p_match_method,p_match_reason,true)
    on conflict(application_id,email_id) do update set confidence=excluded.confidence,match_method=excluded.match_method,reason=excluded.reason,is_primary=true;
    update public.applications set
      last_email_at=greatest(coalesce(last_email_at,'epoch'::timestamptz),coalesce(p_received_at,now())),
      last_email_id=v_email.id,
      updated_at=now()
    where id=p_application_id;
  end if;

  -- Only deterministic status events are eligible for automatic state changes.
  if p_classification='other' then
    v_needs_user := false;
  elsif p_classification in ('offer','recruiter_message','uncertain') then
    v_needs_user := true;
  elsif p_application_id is null then
    v_needs_user := true;
  else
    v_threshold := case when p_classification='confirmation' then 0.78 else 0.86 end;
    v_needs_user := p_classification_confidence < (case when p_classification='confirmation' then 0.90 else 0.94 end)
                    or coalesce(p_match_confidence,0) < v_threshold;
  end if;

  if not v_needs_user and p_application_id is not null then
    select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
    if p_classification='confirmation' and v_app.state='submitted' then v_target := 'awaiting_response'; end if;
    if p_classification='rejection' and v_app.state in ('submitted','awaiting_response','assessment','interview') then v_target := 'rejected'; end if;
    if p_classification='assessment' and v_app.state in ('submitted','awaiting_response') then v_target := 'assessment'; end if;
    if p_classification='interview' and v_app.state in ('submitted','awaiting_response','assessment') then v_target := 'interview'; end if;

    if v_target is not null and v_target is distinct from v_app.state then
      update public.applications set state=v_target,updated_at=now() where id=v_app.id;
      update public.emails set proposed_state=v_target,auto_applied_at=now() where id=v_email.id;
      insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
      values(v_user,'user',v_user::text,'application.state_changed_from_email','application',v_app.id,
        jsonb_build_object('from_state',v_app.state,'to_state',v_target,'email_id',v_email.id,'classification',p_classification,'classification_confidence',p_classification_confidence,'match_confidence',p_match_confidence));
    end if;

    if p_classification='assessment' then
      begin v_deadline := nullif(p_metadata->>'deadline_at','')::timestamptz; exception when others then v_deadline := null; end;
      update public.assessments set source_email_id=v_email.id,provider=coalesce(provider,nullif(p_metadata->>'provider_hint','')),deadline_at=coalesce(v_deadline,deadline_at),updated_at=now()
      where id=(select id from public.assessments where application_id=p_application_id and source_email_id is null and status in ('pending','in_progress') order by created_at desc limit 1);
      if not found then
        insert into public.assessments(application_id,provider,assessment_type,invited_at,deadline_at,status,notes,source_email_id)
        values(p_application_id,nullif(p_metadata->>'provider_hint',''),'online assessment',p_received_at,v_deadline,'pending',p_subject,v_email.id)
        on conflict(source_email_id) where source_email_id is not null do update set deadline_at=coalesce(excluded.deadline_at,public.assessments.deadline_at),updated_at=now();
      end if;
    elsif p_classification='interview' then
      update public.interviews set source_email_id=v_email.id,updated_at=now()
      where id=(select id from public.interviews where application_id=p_application_id and source_email_id is null and status in ('scheduled','rescheduled') order by created_at desc limit 1);
      if not found then
        insert into public.interviews(application_id,interview_type,round_label,scheduled_at,status,notes,source_email_id)
        values(p_application_id,'interview','Email invitation',null,'scheduled',p_subject,v_email.id)
        on conflict(source_email_id) where source_email_id is not null do update set updated_at=now();
      end if;
    end if;
  end if;

  update public.emails set needs_user=v_needs_user where id=v_email.id returning * into v_email;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'email.processed','email',v_email.id,
    jsonb_build_object('classification',p_classification,'confidence',p_classification_confidence,'application_id',p_application_id,'match_confidence',p_match_confidence,'needs_user',v_needs_user,'automation','gmail_monitor'));

  return jsonb_build_object('email_id',v_email.id,'application_id',p_application_id,'classification',p_classification,'needs_user',v_needs_user,'auto_state',v_target);
end;
$$;
revoke execute on function public.process_application_email(text,text,text,text,timestamptz,text,text,public.email_classification,numeric,text,uuid,numeric,text,text,jsonb) from public, anon;
grant execute on function public.process_application_email(text,text,text,text,timestamptz,text,text,public.email_classification,numeric,text,uuid,numeric,text,text,jsonb) to authenticated;

create or replace function public.resolve_application_email(
  p_email_id uuid,
  p_application_id uuid,
  p_classification public.email_classification
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email public.emails;
  v_app public.applications;
  v_target public.application_state := null;
  v_deadline timestamptz := null;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_email from public.emails where id=p_email_id and user_id=v_user for update;
  if not found then raise exception 'Email not found'; end if;
  select * into v_app from public.applications where id=p_application_id and user_id=v_user for update;
  if not found then raise exception 'Application not found'; end if;

  update public.application_email_links set is_primary=false where email_id=p_email_id;
  insert into public.application_email_links(application_id,email_id,confidence,match_method,reason,is_primary)
  values(p_application_id,p_email_id,1,'manual','User confirmed the application match.',true)
  on conflict(application_id,email_id) do update set confidence=1,match_method='manual',reason='User confirmed the application match.',is_primary=true;

  if p_classification='confirmation' and v_app.state='submitted' then v_target:='awaiting_response'; end if;
  if p_classification='rejection' and v_app.state in ('submitted','awaiting_response','assessment','interview') then v_target:='rejected'; end if;
  if p_classification='assessment' and v_app.state in ('submitted','awaiting_response') then v_target:='assessment'; end if;
  if p_classification='interview' and v_app.state in ('submitted','awaiting_response','assessment') then v_target:='interview'; end if;
  if p_classification='offer' and v_app.state in ('submitted','awaiting_response','assessment','interview') then v_target:='offer'; end if;

  if v_target is not null and v_target is distinct from v_app.state then
    update public.applications set state=v_target,last_email_at=coalesce(v_email.received_at,now()),last_email_id=v_email.id,updated_at=now() where id=v_app.id;
  else
    update public.applications set last_email_at=greatest(coalesce(last_email_at,'epoch'::timestamptz),coalesce(v_email.received_at,now())),last_email_id=v_email.id,updated_at=now() where id=v_app.id;
  end if;

  if p_classification='assessment' then
    begin v_deadline := nullif(v_email.metadata->>'deadline_at','')::timestamptz; exception when others then v_deadline := null; end;
    update public.assessments set
      source_email_id=v_email.id,
      provider=coalesce(provider,nullif(v_email.metadata->>'provider_hint','')),
      deadline_at=coalesce(v_deadline,deadline_at),
      updated_at=now()
    where id=(select id from public.assessments where application_id=p_application_id and source_email_id is null and status in ('pending','in_progress') order by created_at desc limit 1);
    if not found then
      insert into public.assessments(application_id,provider,assessment_type,invited_at,deadline_at,status,notes,source_email_id)
      values(p_application_id,nullif(v_email.metadata->>'provider_hint',''),'online assessment',v_email.received_at,v_deadline,'pending',v_email.subject,v_email.id)
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

  update public.emails set classification=p_classification,confidence=1,classification_reason='User-confirmed classification.',needs_user=false,proposed_state=v_target,auto_applied_at=case when v_target is not null then now() else auto_applied_at end,processed_at=now() where id=p_email_id;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'user',v_user::text,'email.review_resolved','email',p_email_id,jsonb_build_object('application_id',p_application_id,'classification',p_classification,'to_state',v_target));
  return jsonb_build_object('email_id',p_email_id,'application_id',p_application_id,'classification',p_classification,'state',coalesce(v_target,v_app.state));
end;
$$;
revoke execute on function public.resolve_application_email(uuid,uuid,public.email_classification) from public, anon;
grant execute on function public.resolve_application_email(uuid,uuid,public.email_classification) to authenticated;
