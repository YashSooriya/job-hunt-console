-- Milestone 10 hardening: keep form-agent tables non-writable to authenticated clients while exposing narrow invoker wrappers.

create or replace function private.start_form_agent_session_for_user(p_user uuid,p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_app public.applications; v_package public.application_review_packages; v_token text; v_session public.form_agent_sessions;
begin
  select * into v_app from public.applications where id=p_application_id and user_id=p_user for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.state not in ('content_approved','form_in_progress','form_needs_user','final_review') then raise exception 'Application must have passed Gate 1 before form completion'; end if;
  select * into v_package from public.application_review_packages where application_id=p_application_id and approved_at is not null;
  if not found then raise exception 'Approved Gate 1 package not found'; end if;
  update public.form_agent_sessions set status='cancelled',updated_at=now(),completed_at=now() where user_id=p_user and application_id=p_application_id and status in ('active','needs_user','final_review');
  v_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.form_agent_sessions(user_id,application_id,status,token_hash,expires_at)
  values(p_user,p_application_id,'active',encode(extensions.digest(v_token,'sha256'),'hex'),now()+interval '8 hours') returning * into v_session;
  update public.applications set state='form_in_progress',next_action='Complete and review the employer form.',updated_at=now() where id=p_application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'form_agent.session_started','application',p_application_id,jsonb_build_object('session_id',v_session.id,'expires_at',v_session.expires_at));
  return jsonb_build_object('session_id',v_session.id,'token',v_token,'expires_at',v_session.expires_at,'status',v_session.status);
end $$;
revoke all on function private.start_form_agent_session_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.start_form_agent_session_for_user(uuid,uuid) to authenticated;

create or replace function public.start_form_agent_session(p_application_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  return private.start_form_agent_session_for_user(v_user,p_application_id);
end $$;

create or replace function private.get_form_agent_session_status_for_user(p_user uuid,p_application_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_session public.form_agent_sessions;
begin
  select * into v_session from public.form_agent_sessions where application_id=p_application_id and user_id=p_user order by started_at desc limit 1;
  if not found then return jsonb_build_object('session',null); end if;
  return jsonb_build_object('session',jsonb_build_object('id',v_session.id,'application_id',v_session.application_id,'status',v_session.status,'expires_at',v_session.expires_at,'current_url',v_session.current_url,'current_title',v_session.current_title,'pause_reasons',v_session.pause_reasons,'final_review',v_session.final_review_json,'submit_candidate',v_session.submit_candidate,'started_at',v_session.started_at,'updated_at',v_session.updated_at,'completed_at',v_session.completed_at));
end $$;
revoke all on function private.get_form_agent_session_status_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.get_form_agent_session_status_for_user(uuid,uuid) to authenticated;

create or replace function public.get_form_agent_session_status(p_application_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid());
begin if v_user is null then raise exception 'Authentication required'; end if; return private.get_form_agent_session_status_for_user(v_user,p_application_id); end $$;

create or replace function private.approve_form_agent_final_review_for_user(p_user uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_session public.form_agent_sessions; v_unresolved integer;
begin
  select * into v_session from public.form_agent_sessions where id=p_session_id and user_id=p_user for update;
  if not found then raise exception 'Form session not found'; end if;
  if v_session.status <> 'final_review' then raise exception 'Form session is not at Final Review'; end if;
  if v_session.expires_at <= now() then raise exception 'Form session has expired'; end if;
  if v_session.final_observation_id is null or v_session.final_review_json is null then raise exception 'Final employer-form observation is missing'; end if;
  v_unresolved := coalesce((v_session.final_review_json->'summary'->>'unresolved')::integer,0);
  if v_unresolved > 0 then raise exception 'Final review still contains unresolved fields'; end if;
  if not exists(select 1 from public.applications where id=v_session.application_id and user_id=p_user and state='final_review') then raise exception 'Application is not at Final Review'; end if;
  update public.form_agent_sessions set status='approved_for_submission',updated_at=now() where id=p_session_id;
  update public.applications set state='approved_for_submission',next_action='Approved for exact final submission.',updated_at=now() where id=v_session.application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'form_agent.gate2_approved','application',v_session.application_id,jsonb_build_object('session_id',p_session_id,'final_observation_id',v_session.final_observation_id));
  return jsonb_build_object('application_id',v_session.application_id,'session_id',p_session_id,'state','approved_for_submission');
end $$;
revoke all on function private.approve_form_agent_final_review_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.approve_form_agent_final_review_for_user(uuid,uuid) to authenticated;

create or replace function public.approve_form_agent_final_review(p_session_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid());
begin if v_user is null then raise exception 'Authentication required'; end if; return private.approve_form_agent_final_review_for_user(v_user,p_session_id); end $$;

create or replace function private.record_form_agent_manual_submission_for_user(p_user uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_session public.form_agent_sessions; v_now timestamptz := now();
begin
  select * into v_session from public.form_agent_sessions where id=p_session_id and user_id=p_user for update;
  if not found then raise exception 'Form session not found'; end if;
  if v_session.status not in ('final_review','approved_for_submission') then raise exception 'Final Review is required before manual submission recording'; end if;
  if coalesce((v_session.final_review_json->'summary'->>'unresolved')::integer,0)>0 then raise exception 'Final review contains unresolved fields'; end if;
  perform private.lock_application_submission_context(v_session.application_id,v_now,'manual',v_session.final_review_json);
  update public.form_agent_sessions set status='submitted',updated_at=v_now,completed_at=v_now where id=p_session_id;
  update public.applications set state='submitted',submitted_at=coalesce(submitted_at,v_now),applied_at=coalesce(applied_at,v_now),next_action='Await employer confirmation or next-stage communication.',updated_at=v_now where id=v_session.application_id;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(p_user,'user',p_user::text,'form_agent.manual_submission_recorded','application',v_session.application_id,jsonb_build_object('session_id',p_session_id));
  return jsonb_build_object('application_id',v_session.application_id,'session_id',p_session_id,'state','submitted');
end $$;
revoke all on function private.record_form_agent_manual_submission_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function private.record_form_agent_manual_submission_for_user(uuid,uuid) to authenticated;

create or replace function public.record_form_agent_manual_submission(p_session_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid := (select auth.uid());
begin if v_user is null then raise exception 'Authentication required'; end if; return private.record_form_agent_manual_submission_for_user(v_user,p_session_id); end $$;
