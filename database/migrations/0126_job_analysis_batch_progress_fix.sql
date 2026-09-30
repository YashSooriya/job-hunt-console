-- Fix the live progress query: the analysis lateral join exposes ja.id only.
-- This is additive because 0123 is already applied in deployed databases.

create or replace function public.get_job_analysis_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch public.job_analysis_batches;
  v_profile_revision bigint;
  v_counts jsonb;
  v_issues jsonb;
  v_state text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select * into v_batch from public.job_analysis_batches b
   where b.id=p_batch_id and b.user_id=(select auth.uid());
  if not found then raise exception 'Analysis batch not found'; end if;
  select p.analysis_revision into v_profile_revision from public.candidate_profiles p
   where p.user_id=(select auth.uid());

  with requested as (
    select unnest(v_batch.requested_job_ids) as job_id
  ), classified as (
    select r.job_id,j.title,
      case
        when j.id is null then 'unavailable'
        when own_task.state='completed' then 'completed'
        when active.state='running' then 'running'
        when active.state='queued' then 'queued'
        when a.id is not null then 'completed'
        when own_task.state='needs_user' then 'needs_user'
        when own_task.state='failed' then 'failed'
        when terminal.state='needs_user' then 'needs_user'
        when terminal.state='failed' then 'failed'
        else 'queued'
      end as task_state,
      coalesce(terminal.error_json->>'message','') as error_message
    from requested r
    left join public.jobs j on j.id=r.job_id
    left join lateral (
      select ja.id from public.job_analyses ja
       where ja.job_id=j.id and ja.engine_version='job-fit-v2'
         and ja.job_revision=j.analysis_revision and ja.profile_revision=v_profile_revision
         and ja.input_hash ~ '^[0-9a-f]{64}$' and ja.assessment_as_of is not null
       order by ja.created_at desc,ja.id desc limit 1
    ) a on true
    left join lateral (
      select t.state from public.job_analysis_tasks t
       where t.batch_id=v_batch.id and t.job_id=r.job_id
       order by t.updated_at desc,t.id desc limit 1
    ) own_task on true
    left join lateral (
      select t.state from public.job_analysis_tasks t
       where t.user_id=(select auth.uid()) and t.job_id=r.job_id and t.state in ('queued','running')
       order by t.updated_at desc,t.id desc limit 1
    ) active on true
    left join lateral (
      select t.state,t.error_json from public.job_analysis_tasks t
       where t.user_id=(select auth.uid()) and t.job_id=r.job_id and t.state in ('failed','needs_user')
       order by t.updated_at desc,t.id desc limit 1
    ) terminal on true
  )
  select jsonb_build_object(
    'total',count(*),
    'completed',count(*) filter(where task_state='completed'),
    'queued',count(*) filter(where task_state='queued'),
    'running',count(*) filter(where task_state='running'),
    'failed',count(*) filter(where task_state='failed'),
    'needs_user',count(*) filter(where task_state='needs_user'),
    'unavailable',count(*) filter(where task_state='unavailable'),
    'reused',v_batch.reused_count
  ),
  coalesce((select jsonb_agg(jsonb_build_object('job_id',issue.job_id,'title',issue.title,
    'state',issue.task_state,'message',nullif(issue.error_message,'')) order by issue.title,issue.job_id)
    from (select job_id,title,task_state,error_message from classified
      where task_state in ('failed','needs_user','unavailable') order by title,job_id limit 20) issue),'[]'::jsonb)
  into v_counts,v_issues from classified;

  v_state := case
    when coalesce((v_counts->>'queued')::integer,0)>0 and coalesce((v_counts->>'running')::integer,0)=0 then 'queued'
    when coalesce((v_counts->>'queued')::integer,0)>0 or coalesce((v_counts->>'running')::integer,0)>0 then 'processing'
    when coalesce((v_counts->>'failed')::integer,0)>0 or coalesce((v_counts->>'needs_user')::integer,0)>0 or coalesce((v_counts->>'unavailable')::integer,0)>0 then 'partial'
    else 'completed' end;
  return jsonb_build_object('batch_id',v_batch.id,'mode',v_batch.mode,'state',v_state,
    'requested_count',v_batch.requested_count,'counts',v_counts,'issues',v_issues,
    'created_at',v_batch.created_at,'started_at',v_batch.started_at,'finished_at',v_batch.finished_at);
end;
$$;

revoke all on function public.get_job_analysis_batch(uuid) from public,anon,service_role;
grant execute on function public.get_job_analysis_batch(uuid) to authenticated;
