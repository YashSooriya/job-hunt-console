-- Milestone 13: authenticated commissioning status without exposing staged payloads or OAuth secrets.
create or replace function private.get_live_cutover_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_profile uuid;
  v_pending integer := 0;
  v_claimed integer := 0;
  v_facts integer := 0;
  v_evidence integer := 0;
  v_apps integer := 0;
  v_assessments integer := 0;
  v_gmail boolean := false;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select id into v_profile from public.candidate_profiles where user_id=v_user;
  select count(*) into v_pending from private.bootstrap_import_batches where lower(intended_email)=v_email and claimed_at is null;
  select count(*) into v_claimed from private.bootstrap_import_batches where claimed_by=v_user and claimed_at is not null;
  select count(*) into v_apps from public.applications where user_id=v_user;
  select count(*) into v_assessments from public.assessments a join public.applications ap on ap.id=a.application_id where ap.user_id=v_user;
  if v_profile is not null then
    select count(*) into v_facts from public.candidate_facts where profile_id=v_profile;
    select count(*) into v_evidence from public.evidence_items where profile_id=v_profile;
  end if;
  select exists(select 1 from private.gmail_oauth_credentials where user_id=v_user) into v_gmail;

  return jsonb_build_object(
    'authenticated', true,
    'profile_exists', v_profile is not null,
    'pending_bootstrap_batches', v_pending,
    'claimed_bootstrap_batches', v_claimed,
    'facts', v_facts,
    'evidence', v_evidence,
    'applications', v_apps,
    'assessments', v_assessments,
    'gmail_refresh_credential', v_gmail,
    'cutover_complete', (v_profile is not null and v_pending=0 and v_claimed>0 and v_apps>0)
  );
end;
$$;

revoke all on function private.get_live_cutover_status() from public, anon, authenticated;

create or replace function public.get_live_cutover_status()
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.get_live_cutover_status(); $$;

revoke all on function public.get_live_cutover_status() from public, anon;
grant execute on function public.get_live_cutover_status() to authenticated;
