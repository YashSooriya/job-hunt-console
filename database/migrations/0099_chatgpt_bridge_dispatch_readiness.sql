-- M41: expose the deployed bridge contract in the existing authenticated
-- status RPC.  Reusing that already-audited function avoids adding another
-- SECURITY DEFINER entry to the free-tier security inventory.  An older
-- deployment therefore returns no contract marker and onboarding fails
-- closed instead of accepting a request that an incompatible bridge could
-- claim later.

create or replace function public.get_chatgpt_bridge_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_memory jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.assert_active_app_membership(v_user);
  select to_jsonb(m) into v_memory
    from public.candidate_chatgpt_memory m
    join public.candidate_profiles p on p.id=m.profile_id
   where p.user_id=v_user;
  return jsonb_build_object(
    'memory',coalesce(v_memory,jsonb_build_object('memory_enabled_user_confirmed',false)),
    'server_capabilities',jsonb_build_object(
      'result_completion_v3',true,
      'response_provenance_v3',true,
      'reset_reconciliation_v1',true
    ),
    'devices',coalesce((select jsonb_agg(jsonb_build_object(
      'id',d.id,'display_name',d.display_name,'platform',d.platform,'extension_version',d.extension_version,
      'capabilities',d.capabilities,'bound_conversation_url',d.bound_conversation_url,'bound_project_name',d.bound_project_name,
      'bound_project_verified',d.bound_project_verified_at is not null,'automatic_send_enabled',d.automatic_send_enabled,'preferred',d.preferred,
      'paired_at',d.paired_at,'last_seen_at',d.last_seen_at,'online',coalesce(d.last_seen_at > now()-interval '90 seconds',false),
      'conversations',coalesce((select jsonb_agg(jsonb_build_object(
        'id',s.id,'workflow_key',s.workflow_key,'display_name',s.display_name,'conversation_url',s.conversation_url,
        'project_name',s.project_name,'project_verified',s.project_verified_at is not null,'bound_at',s.bound_at,
        'last_used_at',s.last_used_at,'last_dispatch_at',s.last_dispatch_at,'active',s.active
      ) order by s.display_name) from public.chatgpt_bridge_conversation_slots s where s.device_id=d.id and s.active),'[]'::jsonb)
    ) order by d.preferred desc,d.last_seen_at desc nulls last,d.paired_at desc) from public.chatgpt_bridge_devices d where d.user_id=v_user and d.revoked_at is null),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_chatgpt_bridge_status() from public, anon;
grant execute on function public.get_chatgpt_bridge_status() to authenticated;
