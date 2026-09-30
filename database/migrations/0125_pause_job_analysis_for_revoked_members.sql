-- Durable worker jobs may outlive the membership session that created them.
-- Keep analysis queued while the owner is revoked and allow it to resume if
-- their membership is restored. Never load revoked members' profile data into
-- the trusted background worker.
create or replace function private.claim_job_analysis_tasks(p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_claimed jsonb;
begin
  if coalesce(p_limit,0) < 1 or p_limit > 5 then raise exception 'Claim size must be 1 to 5'; end if;

  update public.job_analysis_tasks t set state='needs_user',lease_token=null,lease_expires_at=null,
    error_json=jsonb_build_object('message','Your profile is unavailable; finish onboarding before analysing jobs.'),
    finished_at=now(),updated_at=now()
   where t.state in ('queued','running')
     and exists(select 1 from private.app_memberships m where m.user_id=t.user_id and m.status='active')
     and not exists(select 1 from public.candidate_profiles p where p.user_id=t.user_id);

  update public.job_analysis_tasks t set state='failed',lease_token=null,lease_expires_at=null,
    error_json=jsonb_build_object('message','Analysis exceeded its retry limit; retry this batch.'),
    finished_at=now(),updated_at=now()
   where t.state='running' and t.lease_expires_at < now() and t.attempt_count >= 4
     and exists(select 1 from private.app_memberships m where m.user_id=t.user_id and m.status='active');

  with candidates as (
    select t.id from public.job_analysis_tasks t
     where (t.state='queued' or (t.state='running' and t.lease_expires_at < now()))
       and t.attempt_count < 4
       and exists(select 1 from private.app_memberships m where m.user_id=t.user_id and m.status='active')
     order by t.created_at,t.id for update skip locked limit p_limit
  ), claimed as (
    update public.job_analysis_tasks t set state='running',attempt_count=t.attempt_count+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',
      started_at=coalesce(t.started_at,now()),updated_at=now(),error_json=null
      from candidates c where t.id=c.id
      returning t.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'task_id',t.id,'batch_id',t.batch_id,'user_id',t.user_id,'job_id',t.job_id,
    'lease_token',t.lease_token,'attempt_count',t.attempt_count,'job_revision',t.job_revision,
    'profile_revision',t.profile_revision,'assessment_as_of',t.assessment_as_of,
    'job',jsonb_build_object('company',coalesce(c.canonical_name,s.company_name,'Unknown company'),
      'title',j.title,'industry',j.industry,'description',s.description_text,'externalJobId',j.external_job_id,
      'sourceUrl',j.source_url,'applicationUrl',j.application_url,'location',j.location_text,'workMode',j.work_mode,
      'salaryText',j.salary_text,'salaryMin',j.salary_min,'salaryMax',j.salary_max,'salaryCurrency',coalesce(j.salary_currency,'GBP'),
      'postedAt',j.posted_at,'closesAt',j.closes_at,'employmentType',j.employment_type,'atsProvider',j.ats_provider,
      'discoverySource',j.discovery_source),
    'profile',jsonb_build_object('displayName',p.display_name,
      'facts',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'factKey',f.fact_key,'value',f.value_json,'status',f.verification_status) order by f.fact_key,f.id) from public.candidate_facts f where f.profile_id=p.id),'[]'::jsonb),
      'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'evidenceKey',e.evidence_key,'category',e.category,'claim',e.claim,'detail',e.detail,'tags',e.tags,'strength',e.strength,'status',e.verification_status) order by e.evidence_key,e.id) from public.evidence_items e where e.profile_id=p.id and e.verification_status<>'rejected'),'[]'::jsonb),
      'preferences',coalesce((select cp.preferences from public.candidate_preferences cp where cp.profile_id=p.id),'{}'::jsonb),
      'sources','[]'::jsonb,'structured',jsonb_build_object('employment','[]'::jsonb,'education','[]'::jsonb,'skills','[]'::jsonb,'projects','[]'::jsonb,'publications','[]'::jsonb))
    )),'[]'::jsonb) into v_claimed
    from claimed t join public.jobs j on j.id=t.job_id
    left join public.companies c on c.id=j.company_id
    left join public.job_snapshots s on s.id=j.current_snapshot_id
    join public.candidate_profiles p on p.user_id=t.user_id;

  update public.job_analysis_batches b set state='processing',started_at=coalesce(started_at,now())
   where b.id in (select (x->>'batch_id')::uuid from jsonb_array_elements(v_claimed) x)
     and b.state='queued';
  return v_claimed;
end;
$$;
revoke all on function private.claim_job_analysis_tasks(integer) from public,anon,authenticated,service_role;
grant execute on function private.claim_job_analysis_tasks(integer) to service_role;
