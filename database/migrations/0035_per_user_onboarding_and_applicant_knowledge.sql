-- Milestone 17: per-user onboarding and trustworthy applicant knowledge.

create table public.candidate_onboarding (
  profile_id uuid primary key references public.candidate_profiles(id) on delete cascade,
  status text not null default 'in_progress' check(status in ('in_progress','ready')),
  completed_steps text[] not null default '{}',
  started_at timestamptz not null default now(),
  ready_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.candidate_education (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  institution text not null, qualification text not null, field_of_study text, location text,
  start_date date, end_date date, current boolean not null default false, details text,
  verification_status text not null default 'verified' check(verification_status in ('verified','needs_review','rejected')),
  source_id uuid references public.evidence_sources(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.candidate_employment (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  employer text not null, role_title text not null, location text, start_date date, end_date date, current boolean not null default false,
  details text, verification_status text not null default 'verified' check(verification_status in ('verified','needs_review','rejected')),
  source_id uuid references public.evidence_sources(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.candidate_skills (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  name text not null, category text not null default 'skill', proficiency text, years_experience numeric,
  verification_status text not null default 'verified' check(verification_status in ('verified','needs_review','rejected')),
  source_id uuid references public.evidence_sources(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(profile_id,name)
);
create table public.candidate_projects (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  title text not null, description text, technologies text[] not null default '{}', url text,
  verification_status text not null default 'verified' check(verification_status in ('verified','needs_review','rejected')),
  source_id uuid references public.evidence_sources(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.candidate_publications (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  title text not null, publication_type text not null default 'publication', venue text, published_on date, url text, citation text,
  verification_status text not null default 'verified' check(verification_status in ('verified','needs_review','rejected')),
  source_id uuid references public.evidence_sources(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.candidate_cv_families (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  family_key text not null, label text not null, enabled boolean not null default true, is_default boolean not null default false,
  notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(profile_id,family_key)
);
create unique index candidate_cv_families_one_default_idx on public.candidate_cv_families(profile_id) where is_default;
create table public.candidate_source_documents (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  original_name text not null, storage_object_key text not null, mime_type text, byte_size bigint not null default 0,
  sha256 text not null, extraction_status text not null default 'pending' check(extraction_status in ('pending','extracted','needs_text','failed')),
  extracted_text text, extraction_version text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(profile_id,sha256)
);

alter table public.candidate_onboarding enable row level security;
alter table public.candidate_education enable row level security;
alter table public.candidate_employment enable row level security;
alter table public.candidate_skills enable row level security;
alter table public.candidate_projects enable row level security;
alter table public.candidate_publications enable row level security;
alter table public.candidate_cv_families enable row level security;
alter table public.candidate_source_documents enable row level security;

create policy candidate_onboarding_owner on public.candidate_onboarding for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));
create policy candidate_education_owner on public.candidate_education for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));
create policy candidate_employment_owner on public.candidate_employment for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));
create policy candidate_skills_owner on public.candidate_skills for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));
create policy candidate_projects_owner on public.candidate_projects for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));
create policy candidate_publications_owner on public.candidate_publications for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));
create policy candidate_cv_families_owner on public.candidate_cv_families for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));
create policy candidate_source_documents_owner on public.candidate_source_documents for all using(private.owns_profile(profile_id)) with check(private.owns_profile(profile_id));

create index candidate_education_profile_idx on public.candidate_education(profile_id);
create index candidate_employment_profile_idx on public.candidate_employment(profile_id);
create index candidate_skills_profile_idx on public.candidate_skills(profile_id);
create index candidate_projects_profile_idx on public.candidate_projects(profile_id);
create index candidate_publications_profile_idx on public.candidate_publications(profile_id);
create index candidate_source_documents_profile_idx on public.candidate_source_documents(profile_id);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('candidate-source-documents','candidate-source-documents',false,10485760,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown','application/rtf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy jobhunt_candidate_sources_select on storage.objects for select to authenticated using(bucket_id='candidate-source-documents' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy jobhunt_candidate_sources_insert on storage.objects for insert to authenticated with check(bucket_id='candidate-source-documents' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy jobhunt_candidate_sources_delete on storage.objects for delete to authenticated using(bucket_id='candidate-source-documents' and (storage.foldername(name))[1]=(select auth.uid())::text);

create or replace function public.get_onboarding_readiness() returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_user uuid:=(select auth.uid()); v_profile uuid; v_pending int; v_history int; v_skills int; v_evidence int; v_work_auth int; v_locations boolean; v_families int; v_status text; v_score int;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select id into v_profile from public.candidate_profiles where user_id=v_user; if v_profile is null then return jsonb_build_object('ready',false,'score',0,'reason','profile_missing'); end if;
  select count(*) into v_pending from (select id from public.candidate_facts where profile_id=v_profile and verification_status='needs_review' union all select id from public.evidence_items where profile_id=v_profile and verification_status='needs_review') q;
  select (select count(*) from public.candidate_education where profile_id=v_profile and verification_status='verified')+(select count(*) from public.candidate_employment where profile_id=v_profile and verification_status='verified') into v_history;
  select count(*) into v_skills from public.candidate_skills where profile_id=v_profile and verification_status='verified';
  select count(*) into v_evidence from public.evidence_items where profile_id=v_profile and verification_status='verified';
  select count(*) into v_work_auth from public.candidate_facts where profile_id=v_profile and fact_key='work_authorisation' and verification_status='verified';
  select coalesce(jsonb_array_length(coalesce(preferences->'locations','[]'::jsonb))>0,false) into v_locations from public.candidate_preferences where profile_id=v_profile;
  select count(*) into v_families from public.candidate_cv_families where profile_id=v_profile and enabled;
  select status into v_status from public.candidate_onboarding where profile_id=v_profile;
  v_score := (case when v_history>0 then 20 else 0 end)+(case when v_skills>0 then 20 else 0 end)+(case when v_evidence>0 then 20 else 0 end)+(case when v_work_auth>0 then 15 else 0 end)+(case when v_locations then 15 else 0 end)+(case when v_families>0 then 10 else 0 end);
  return jsonb_build_object('ready',v_score=100 and v_pending=0,'score',v_score,'status',coalesce(v_status,'in_progress'),'pending_review',v_pending,'history',v_history,'skills',v_skills,'verified_evidence',v_evidence,'work_authorisation',v_work_auth>0,'locations',v_locations,'cv_families',v_families);
end $$;
revoke execute on function public.get_onboarding_readiness() from public,anon; grant execute on function public.get_onboarding_readiness() to authenticated;

create or replace function public.complete_candidate_onboarding() returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_user uuid:=(select auth.uid()); v_profile uuid; v_ready jsonb; begin
  if v_user is null then raise exception 'Authentication required'; end if; select id into v_profile from public.candidate_profiles where user_id=v_user; if v_profile is null then raise exception 'Candidate profile not found'; end if;
  v_ready:=public.get_onboarding_readiness(); if coalesce((v_ready->>'ready')::boolean,false) is not true then raise exception 'Applicant knowledge is not ready for job hunting'; end if;
  insert into public.candidate_onboarding(profile_id,status,completed_steps,ready_at,updated_at) values(v_profile,'ready',array['personal','history','cv','skills','evidence','preferences'],'now','now') on conflict(profile_id) do update set status='ready',completed_steps=excluded.completed_steps,ready_at=coalesce(public.candidate_onboarding.ready_at,now()),updated_at=now(); return v_ready||jsonb_build_object('status','ready');
end $$;
revoke execute on function public.complete_candidate_onboarding() from public,anon; grant execute on function public.complete_candidate_onboarding() to authenticated;
