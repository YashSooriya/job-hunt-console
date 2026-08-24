-- Milestone 6: salary context, screening-answer trust package and cover-letter versions.

create table if not exists public.application_salary_contexts (
  application_id uuid primary key references public.applications(id) on delete cascade,
  source text not null check (source in ('advertised','estimated')),
  advertised_text text,
  estimated_low integer,
  estimated_high integer,
  recommended_value integer,
  currency text not null default 'GBP',
  confidence text not null check (confidence in ('low','medium','high')),
  trust public.answer_trust not null default 'proposed',
  basis jsonb not null default '[]'::jsonb,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.application_salary_contexts enable row level security;
drop policy if exists application_salary_contexts_owner on public.application_salary_contexts;
create policy application_salary_contexts_owner on public.application_salary_contexts
  for all to authenticated
  using ((select private.owns_application(application_id)))
  with check ((select private.owns_application(application_id)));

create index if not exists idx_application_salary_contexts_approved_by on public.application_salary_contexts(approved_by);

create unique index if not exists idx_documents_one_application_cover_letter
  on public.documents(application_id)
  where kind = 'cover_letter' and application_id is not null;

create or replace function public.save_application_content_package(
  p_application_id uuid,
  p_salary jsonb,
  p_answers jsonb,
  p_cover_letter jsonb default null,
  p_latex_source text default null,
  p_evidence_links jsonb default '[]'::jsonb,
  p_engine text default 'deterministic_v1'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_app public.applications;
  v_profile_id uuid;
  v_answer jsonb;
  v_fact_id uuid;
  v_red_count integer := 0;
  v_document public.documents;
  v_version public.document_versions;
  v_version_number integer;
  v_paragraph record;
  v_evidence_text text;
  v_evidence_id uuid;
  v_link jsonb;
  v_cover_letter_id uuid := null;
  v_cover_letter_version_id uuid := null;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_app from public.applications where id = p_application_id and user_id = v_user;
  if not found then raise exception 'Application not found'; end if;
  select id into v_profile_id from public.candidate_profiles where user_id = v_user limit 1;
  if v_profile_id is null then raise exception 'Candidate profile not found'; end if;

  if p_salary is null then raise exception 'Salary context is required'; end if;
  insert into public.application_salary_contexts(
    application_id,source,advertised_text,estimated_low,estimated_high,recommended_value,currency,confidence,trust,basis,updated_at
  ) values (
    p_application_id,
    p_salary->>'source',
    p_salary->>'advertised_text',
    nullif(p_salary->>'estimated_low','')::integer,
    nullif(p_salary->>'estimated_high','')::integer,
    nullif(p_salary->>'recommended_value','')::integer,
    coalesce(p_salary->>'currency','GBP'),
    coalesce(p_salary->>'confidence','medium'),
    coalesce((p_salary->>'trust')::public.answer_trust,'proposed'),
    coalesce(p_salary->'basis','[]'::jsonb),
    now()
  ) on conflict (application_id) do update set
    source=excluded.source, advertised_text=excluded.advertised_text,
    estimated_low=excluded.estimated_low, estimated_high=excluded.estimated_high,
    recommended_value=excluded.recommended_value, currency=excluded.currency,
    confidence=excluded.confidence, trust=excluded.trust, basis=excluded.basis, updated_at=now();

  delete from public.application_answers
  where application_id=p_application_id and metadata->>'package_source'='milestone6';

  for v_answer in select value from jsonb_array_elements(coalesce(p_answers,'[]'::jsonb))
  loop
    v_fact_id := null;
    if nullif(v_answer->>'source_fact_key','') is not null then
      select id into v_fact_id from public.candidate_facts
      where profile_id=v_profile_id and fact_key=v_answer->>'source_fact_key' and verification_status='verified'
      limit 1;
    end if;
    if (v_answer->>'trust')='verified' and v_fact_id is null then
      raise exception 'Verified screening answer % has no verified fact source', v_answer->>'question_key';
    end if;
    if (v_answer->>'trust')='user_required' and nullif(v_answer->>'answer_text','') is not null then
      raise exception 'User-required screening answer % must remain blank until user input', v_answer->>'question_key';
    end if;
    if (v_answer->>'trust')='user_required' and coalesce((v_answer->>'required')::boolean,true) then
      v_red_count := v_red_count + 1;
    end if;

    insert into public.application_answers(
      application_id,question_key,question_text,answer_text,required,trust,source_fact_id,metadata
    ) values (
      p_application_id,
      v_answer->>'question_key',
      v_answer->>'question_text',
      nullif(v_answer->>'answer_text',''),
      coalesce((v_answer->>'required')::boolean,true),
      (v_answer->>'trust')::public.answer_trust,
      v_fact_id,
      jsonb_build_object(
        'category',v_answer->>'category',
        'colour',v_answer->>'colour',
        'rationale',v_answer->>'rationale',
        'evidence_ids',coalesce(v_answer->'evidence_ids','[]'::jsonb),
        'package_source','milestone6',
        'contract_version',coalesce(p_salary->>'contract_version','1.0.0')
      )
    );
  end loop;

  if p_cover_letter is not null then
    if jsonb_array_length(coalesce(p_cover_letter->'unsupported_claims','[]'::jsonb)) > 0 then
      raise exception 'Cover letter contains unsupported claims';
    end if;

    for v_paragraph in
      select p->>'paragraph_key' as claim_key, coalesce(p->'evidence_ids','[]'::jsonb) as evidence_ids
      from jsonb_array_elements(coalesce(p_cover_letter->'paragraphs','[]'::jsonb)) p
      where coalesce((p->>'material')::boolean,false)
    loop
      if v_paragraph.claim_key is null or jsonb_array_length(v_paragraph.evidence_ids)=0 then
        raise exception 'Material cover-letter paragraph has no evidence';
      end if;
      for v_evidence_text in select jsonb_array_elements_text(v_paragraph.evidence_ids)
      loop
        begin v_evidence_id := v_evidence_text::uuid;
        exception when invalid_text_representation then raise exception 'Cover-letter evidence ID is not a persistent UUID: %', v_evidence_text;
        end;
        if not exists (
          select 1 from public.evidence_items
          where id=v_evidence_id and profile_id=v_profile_id and verification_status='verified'
        ) then raise exception 'Cover letter references unverified or foreign evidence: %', v_evidence_text; end if;
        if not exists (
          select 1 from jsonb_array_elements(coalesce(p_evidence_links,'[]'::jsonb)) x
          where x->>'claim_key'=v_paragraph.claim_key and x->>'evidence_id'=v_evidence_text
        ) then raise exception 'Cover-letter evidence manifest incomplete for %', v_paragraph.claim_key; end if;
      end loop;
    end loop;

    select * into v_document from public.documents
      where application_id=p_application_id and kind='cover_letter' for update;
    if not found then
      insert into public.documents(application_id,kind,title)
      values(p_application_id,'cover_letter','Cover Letter') returning * into v_document;
    end if;
    select coalesce(max(version_number),0)+1 into v_version_number
      from public.document_versions where document_id=v_document.id;
    insert into public.document_versions(
      document_id,version_number,structured_content,latex_source,model,prompt_version,change_summary,approval_status
    ) values (
      v_document.id,v_version_number,p_cover_letter,p_latex_source,p_engine,
      coalesce(p_cover_letter->>'contract_version','1.0.0'),
      coalesce(p_cover_letter->'change_summary','[]'::jsonb),'needs_review'
    ) returning * into v_version;
    for v_link in select value from jsonb_array_elements(coalesce(p_evidence_links,'[]'::jsonb))
    loop
      insert into public.document_evidence_links(document_version_id,evidence_item_id,claim_key)
      values(v_version.id,(v_link->>'evidence_id')::uuid,v_link->>'claim_key') on conflict do nothing;
    end loop;
    v_cover_letter_id := v_document.id;
    v_cover_letter_version_id := v_version.id;
  end if;

  update public.automation_tasks set state='completed',updated_at=now(),last_error=null,
    output_json=jsonb_build_object('salary_context',p_salary)
  where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='research_salary';

  update public.automation_tasks set state=case when v_red_count>0 then 'needs_user'::public.task_state else 'completed'::public.task_state end,
    updated_at=now(),last_error=null,
    output_json=jsonb_build_object('answer_count',jsonb_array_length(coalesce(p_answers,'[]'::jsonb)),'unresolved_user_required',v_red_count)
  where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_screening_answers';

  if p_cover_letter is not null then
    update public.automation_tasks set state='completed',updated_at=now(),last_error=null,
      output_json=jsonb_build_object('document_id',v_cover_letter_id,'document_version_id',v_cover_letter_version_id,'engine',p_engine)
    where user_id=v_user and entity_type='application' and entity_id=p_application_id and task_type='prepare_cover_letter';
  end if;

  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_user,'system','application-content-engine','application.content_package_prepared','application',p_application_id,
    jsonb_build_object('cover_letter_version_id',v_cover_letter_version_id,'screening_answer_count',jsonb_array_length(coalesce(p_answers,'[]'::jsonb)),'unresolved_user_required',v_red_count,'salary_source',p_salary->>'source','engine',p_engine));

  return jsonb_build_object(
    'application_id',p_application_id,
    'cover_letter_document_id',v_cover_letter_id,
    'cover_letter_version_id',v_cover_letter_version_id,
    'screening_answer_count',jsonb_array_length(coalesce(p_answers,'[]'::jsonb)),
    'unresolved_user_required',v_red_count,
    'salary_context',p_salary
  );
end;
$$;

revoke execute on function public.save_application_content_package(uuid,jsonb,jsonb,jsonb,text,jsonb,text) from public, anon;
grant execute on function public.save_application_content_package(uuid,jsonb,jsonb,jsonb,text,jsonb,text) to authenticated;
