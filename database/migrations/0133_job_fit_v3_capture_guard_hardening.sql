-- Bound artifact-key expansion even when a renderer supplies malformed
-- optional anchor JSON. A malformed fence fails closed without a cast error.
create or replace function private.job_fit_v3_enforce_exact_turn_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_dispatch public.chatgpt_dispatch_requests;
  v_anchor jsonb;
  v_provenance jsonb;
  v_same_assistant boolean := false;
  v_same_artifact boolean := false;
begin
  select * into v_dispatch
    from public.chatgpt_dispatch_requests
   where id=new.dispatch_id and user_id=new.user_id;
  if not found or v_dispatch.action_type<>'jobs.analyse_selected' then
    raise exception 'The V3 capture is not linked to its owned generic job-analysis dispatch';
  end if;
  v_anchor:=v_dispatch.delivery_turn_anchor;
  v_provenance:=v_dispatch.response_provenance;
  if v_anchor is null or v_provenance is distinct from new.response_provenance then
    raise exception 'The V3 capture does not match its immutable Bridge turn provenance';
  end if;

  if v_provenance->>'source'='assistant_turn' then
    v_same_assistant := (
      nullif(v_anchor->>'lastAssistantMessageId','') is not null
      and v_provenance->>'assistantMessageId'=v_anchor->>'lastAssistantMessageId'
    ) or (
      (nullif(v_anchor->>'lastAssistantMessageId','') is null
        or nullif(v_provenance->>'assistantMessageId','') is null)
      and nullif(v_anchor->>'lastAssistantFingerprint','') is not null
      and v_provenance->>'assistantFingerprint'=v_anchor->>'lastAssistantFingerprint'
    );
  elsif v_provenance->>'source'='assistant_artifact'
    and nullif(v_provenance->>'artifactKey','') is not null then
    select exists(
      select 1
        from jsonb_array_elements_text(
          case when jsonb_typeof(v_anchor->'artifactKeys')='array'
            then v_anchor->'artifactKeys' else '[]'::jsonb end
        ) k(value)
       where k.value=v_provenance->>'artifactKey'
    ) into v_same_artifact;
  end if;
  if v_same_assistant or v_same_artifact then
    raise exception 'The assistant response already existed at the saved pre-send boundary';
  end if;
  return new;
end;
$$;
revoke all on function private.job_fit_v3_enforce_exact_turn_identity() from public,anon,authenticated,service_role;
