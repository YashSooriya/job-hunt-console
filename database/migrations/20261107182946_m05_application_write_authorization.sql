-- M05 follow-up: keep application creation and the choice marker behind the
-- audited owner-scoped RPCs, while retaining existing non-choice updates.

revoke insert, update on table public.applications from public, anon, authenticated;

do $$
declare
  v_all_columns text;
  v_update_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum),
         string_agg(format('%I', a.attname), ', ' order by a.attnum)
           filter (where a.attname <> 'chosen_to_apply_at')
    into v_all_columns, v_update_columns
    from pg_attribute a
   where a.attrelid = 'public.applications'::regclass
     and a.attnum > 0 and not a.attisdropped;

  if v_all_columns is null or v_update_columns is null then
    raise exception 'Could not resolve writable application columns';
  end if;

  -- Clear any historical column-level grants as well as table-level grants.
  execute format(
    'revoke insert (%s) on table public.applications from public, anon, authenticated',
    v_all_columns
  );
  execute format(
    'revoke update (%s) on table public.applications from public, anon, authenticated',
    v_all_columns
  );

  -- Existing owner-scoped RPCs still update application state and metadata.
  -- The durable apply-choice column remains writable only by trusted functions.
  execute format(
    'grant update (%s) on table public.applications to authenticated',
    v_update_columns
  );
end;
$$;

-- This existing RPC already derives auth.uid(), checks active membership and
-- locks an owned job row before creating or adopting its one application.
-- Run that audited path with owner privileges now that direct INSERT is closed.
alter function public.create_application_from_job(uuid, text) security definer;
alter function public.create_application_from_job(uuid, text) set search_path = '';
revoke all on function public.create_application_from_job(uuid, text)
  from public, anon, service_role;
grant execute on function public.create_application_from_job(uuid, text)
  to authenticated;

-- Preserve the existing authenticated claim wrapper and restore its intended private implementation.
-- The source tree currently references this helper but has no checked-in migration
-- that creates it. This is the original tracker/profile import implementation,
-- with current identity and active membership enforced inside the fixed-path
-- SECURITY DEFINER boundary.
create or replace function private.claim_bootstrap_import_internal()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_batch private.bootstrap_import_batches%rowtype;
  v_profile_id uuid;
  v_source record;
  v_fact record;
  v_item record;
  v_rec record;
  v_source_id uuid;
  v_company_id uuid;
  v_job_id uuid;
  v_app_id uuid;
  v_facts integer := 0;
  v_evidence integer := 0;
  v_applications integer := 0;
  v_assessments integer := 0;
  v_skipped integer := 0;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;
  if v_email = '' then
    raise exception 'Authenticated user has no email claim';
  end if;
  if not exists (
    select 1 from private.app_memberships m
    where m.user_id = v_user and lower(m.email) = v_email and m.status = 'active'
  ) then
    raise exception 'Active Job Hunt Console membership required';
  end if;

  select * into v_batch
  from private.bootstrap_import_batches
  where lower(intended_email) = v_email
    and claimed_at is null
  order by created_at
  limit 1
  for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'no_pending_batch');
  end if;

  insert into public.candidate_profiles(user_id, display_name)
  values (
    v_user,
    coalesce(nullif(v_batch.payload #>> '{profile,display_name}', ''), split_part(v_email, '@', 1))
  )
  on conflict(user_id) do update
    set display_name = excluded.display_name,
        updated_at = now()
  returning id into v_profile_id;

  insert into public.candidate_preferences(profile_id, preferences)
  values (v_profile_id, coalesce(v_batch.payload->'preferences', '{}'::jsonb))
  on conflict(profile_id) do update
    set preferences = excluded.preferences,
        updated_at = now();

  for v_source in
    select value from jsonb_array_elements(coalesce(v_batch.payload->'sources', '[]'::jsonb))
  loop
    insert into public.evidence_sources(
      profile_id, source_key, title, source_type, provider, provider_ref, captured_at, metadata
    ) values (
      v_profile_id,
      v_source.value->>'source_key',
      v_source.value->>'title',
      v_source.value->>'source_type',
      nullif(v_source.value->>'provider', ''),
      nullif(v_source.value->>'provider_ref', ''),
      case when nullif(v_source.value->>'captured_at', '') is not null then (v_source.value->>'captured_at')::timestamptz else null end,
      coalesce(v_source.value->'metadata', '{}'::jsonb)
    )
    on conflict(profile_id, source_key) do update set
      title = excluded.title,
      source_type = excluded.source_type,
      provider = excluded.provider,
      provider_ref = excluded.provider_ref,
      captured_at = excluded.captured_at,
      metadata = excluded.metadata
    returning id into v_source_id;
  end loop;

  for v_fact in
    select value from jsonb_array_elements(coalesce(v_batch.payload #> '{profile,facts}', '[]'::jsonb))
  loop
    insert into public.candidate_facts(
      profile_id, fact_key, value_json, verification_status, source_note, verified_at
    ) values (
      v_profile_id,
      v_fact.value->>'fact_key',
      coalesce(v_fact.value->'value', 'null'::jsonb),
      coalesce(nullif(v_fact.value->>'status', ''), 'needs_review'),
      nullif(v_fact.value->>'source_key', ''),
      case when v_fact.value->>'status' = 'verified' then now() else null end
    )
    on conflict(profile_id, fact_key) do update set
      value_json = excluded.value_json,
      verification_status = excluded.verification_status,
      source_note = excluded.source_note,
      verified_at = excluded.verified_at,
      updated_at = now();
    v_facts := v_facts + 1;
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(v_batch.payload->'evidence', '[]'::jsonb))
  loop
    v_source_id := null;
    if nullif(v_item.value->>'source_key', '') is not null then
      select id into v_source_id
      from public.evidence_sources
      where profile_id = v_profile_id and source_key = v_item.value->>'source_key';
    end if;

    insert into public.evidence_items(
      profile_id, source_id, evidence_key, category, claim, detail, tags,
      strength, verification_status, source_locator
    ) values (
      v_profile_id,
      v_source_id,
      v_item.value->>'evidence_key',
      v_item.value->>'category',
      v_item.value->>'claim',
      nullif(v_item.value->>'detail', ''),
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item.value->'tags', '[]'::jsonb))), '{}'::text[]),
      coalesce((v_item.value->>'strength')::smallint, 3),
      coalesce(nullif(v_item.value->>'status', ''), 'needs_review'),
      nullif(v_item.value->>'source_locator', '')
    )
    on conflict(profile_id, evidence_key) do update set
      source_id = excluded.source_id,
      category = excluded.category,
      claim = excluded.claim,
      detail = excluded.detail,
      tags = excluded.tags,
      strength = excluded.strength,
      verification_status = excluded.verification_status,
      source_locator = excluded.source_locator,
      updated_at = now();
    v_evidence := v_evidence + 1;
  end loop;

  for v_rec in
    select value from jsonb_array_elements(coalesce(v_batch.payload #> '{tracker,records}', '[]'::jsonb))
  loop
    if nullif(v_rec.value->>'sourceRow', '') is not null and exists (
      select 1 from public.applications
      where user_id = v_user and source_tracker_row = (v_rec.value->>'sourceRow')::integer
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.companies(user_id, canonical_name)
    values (v_user, coalesce(nullif(v_rec.value->>'company', ''), 'Unknown company'))
    on conflict(user_id, canonical_name) do update set canonical_name = excluded.canonical_name
    returning id into v_company_id;

    insert into public.jobs(
      user_id, company_id, title, external_job_id, discovered_at, triage_reason
    ) values (
      v_user,
      v_company_id,
      coalesce(nullif(v_rec.value->>'role', ''), 'Unknown role'),
      nullif(v_rec.value->>'externalJobId', ''),
      case when nullif(v_rec.value->>'applicationDate', '') is not null
        then ((v_rec.value->>'applicationDate') || 'T00:00:00Z')::timestamptz
        else now()
      end,
      'Imported from historical application tracker'
    )
    returning id into v_job_id;

    insert into public.applications(
      user_id, job_id, state, source_tracker_row, source_tracker_values,
      applied_at, submitted_at, next_action, deadline_at, notes
    ) values (
      v_user,
      v_job_id,
      coalesce(nullif(v_rec.value->>'applicationState', ''), 'awaiting_response')::public.application_state,
      nullif(v_rec.value->>'sourceRow', '')::integer,
      v_rec.value,
      case when nullif(v_rec.value->>'applicationDate', '') is not null
        then ((v_rec.value->>'applicationDate') || 'T12:00:00Z')::timestamptz
        else null
      end,
      case when nullif(v_rec.value->>'applicationDate', '') is not null
        then ((v_rec.value->>'applicationDate') || 'T12:00:00Z')::timestamptz
        else null
      end,
      nullif(v_rec.value->>'nextAction', ''),
      case when nullif(v_rec.value->>'deadline', '') is not null
        then ((v_rec.value->>'deadline') || 'T23:59:59Z')::timestamptz
        else null
      end,
      nullif(v_rec.value->>'notes', '')
    )
    returning id into v_app_id;

    v_applications := v_applications + 1;

    if v_rec.value->>'applicationState' = 'assessment' then
      insert into public.assessments(
        application_id, invited_at, deadline_at, status, notes
      ) values (
        v_app_id,
        case when nullif(v_rec.value->>'lastEmail', '') is not null
          then ((v_rec.value->>'lastEmail') || 'T12:00:00Z')::timestamptz
          else null
        end,
        case when nullif(v_rec.value->>'deadline', '') is not null
          then ((v_rec.value->>'deadline') || 'T23:59:59Z')::timestamptz
          else null
        end,
        'pending',
        nullif(v_rec.value->>'notes', '')
      );
      v_assessments := v_assessments + 1;
    end if;
  end loop;

  update private.bootstrap_import_batches
  set claimed_by = v_user, claimed_at = now()
  where id = v_batch.id;

  insert into public.audit_events(
    user_id, actor_type, actor_id, event_type, entity_type, entity_id, metadata
  ) values (
    v_user,
    'user',
    v_user::text,
    'bootstrap.history_claimed',
    'candidate_profile',
    v_profile_id,
    jsonb_build_object(
      'batch_id', v_batch.id,
      'batch_label', v_batch.batch_label,
      'facts', v_facts,
      'evidence', v_evidence,
      'applications', v_applications,
      'assessments', v_assessments,
      'skipped', v_skipped
    )
  );

  return jsonb_build_object(
    'claimed', true,
    'batch_id', v_batch.id,
    'facts', v_facts,
    'evidence', v_evidence,
    'applications', v_applications,
    'assessments', v_assessments,
    'skipped', v_skipped
  );
end;
$$;
revoke all on function private.claim_bootstrap_import_internal() from public, anon, authenticated, service_role;
grant execute on function private.claim_bootstrap_import_internal() to service_role;

-- The public form endpoint calls this current-user SECURITY DEFINER wrapper,
-- which performs the ownership, membership, apply-choice, and Gate 1 checks.
-- Arbitrary-user implementations remain callable only by trusted DB code.
revoke all on function private.start_form_agent_session_for_user(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.start_form_agent_session_current_user(uuid)
  from public, anon, service_role;
grant execute on function private.start_form_agent_session_current_user(uuid)
  to authenticated;
