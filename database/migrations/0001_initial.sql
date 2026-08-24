-- Job Hunt Console initial schema
-- PostgreSQL / Supabase

create extension if not exists pgcrypto;

create type public.application_state as enum (
  'discovered', 'triaged', 'shortlisted', 'preparing', 'ready_for_review',
  'revision_requested', 'content_approved', 'form_in_progress', 'form_needs_user',
  'final_review', 'approved_for_submission', 'submitted', 'awaiting_response',
  'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'expired'
);

create type public.job_triage as enum ('auto_prepare', 'recommend', 'maybe', 'reject');
create type public.eligibility_state as enum ('eligible', 'eligible_with_concerns', 'unknown', 'ineligible');
create type public.answer_trust as enum ('verified', 'proposed', 'user_required');
create type public.document_kind as enum ('cv', 'cover_letter', 'supporting_statement', 'answer_package', 'job_snapshot', 'assessment_prep', 'interview_prep');
create type public.task_state as enum ('pending', 'running', 'completed', 'retrying', 'needs_user', 'failed');
create type public.email_classification as enum ('confirmation', 'rejection', 'assessment', 'interview', 'offer', 'recruiter_message', 'other', 'uncertain');
create type public.cv_family as enum ('simulation_cae', 'scientific_software', 'quantitative_data', 'motorsport');

create table public.candidate_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.candidate_facts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  fact_key text not null,
  value_json jsonb not null,
  verification_status text not null check (verification_status in ('verified','needs_review','rejected')),
  source_note text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(profile_id, fact_key)
);

create table public.evidence_sources (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  source_key text not null,
  title text not null,
  source_type text not null,
  provider text,
  provider_ref text,
  captured_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique(profile_id, source_key)
);

create table public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  source_id uuid references public.evidence_sources(id) on delete set null,
  evidence_key text not null,
  category text not null,
  claim text not null,
  detail text,
  tags text[] not null default '{}',
  strength smallint not null default 3 check (strength between 1 and 5),
  verification_status text not null check (verification_status in ('verified','needs_review','rejected')),
  source_locator text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(profile_id, evidence_key)
);

create table public.candidate_preferences (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.candidate_profiles(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reusable_answers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.candidate_profiles(id) on delete cascade,
  answer_key text not null,
  value_text text,
  trust public.answer_trust not null,
  verification_status text not null default 'needs_review' check (verification_status in ('verified','needs_review','rejected')),
  sensitive boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(profile_id, answer_key)
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_name text not null,
  website text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, canonical_name)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  title text not null,
  external_job_id text,
  source_url text,
  application_url text,
  location_text text,
  work_mode text,
  salary_text text,
  salary_min numeric,
  salary_max numeric,
  salary_currency text default 'GBP',
  posted_at timestamptz,
  closes_at timestamptz,
  employment_type text,
  ats_provider text,
  discovered_at timestamptz not null default now(),
  triage public.job_triage,
  triage_reason text,
  current_snapshot_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.job_snapshots (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  captured_at timestamptz not null default now(),
  title text not null,
  company_name text,
  description_text text not null,
  source_url text,
  raw_metadata jsonb not null default '{}'::jsonb
);

alter table public.jobs add constraint jobs_current_snapshot_fk foreign key (current_snapshot_id) references public.job_snapshots(id) on delete set null;

create table public.job_requirements (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  requirement_text text not null,
  requirement_type text not null check (requirement_type in ('essential','desirable','context','eligibility')),
  category text,
  evidence_item_ids uuid[] not null default '{}',
  match_score smallint check (match_score between 0 and 100),
  created_at timestamptz not null default now()
);

create table public.job_analyses (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  model text,
  contract_version text not null,
  eligibility public.eligibility_state not null,
  eligibility_notes text[] not null default '{}',
  fit_score numeric(5,2) not null check (fit_score between 0 and 100),
  priority_score numeric(5,2) not null check (priority_score between 0 and 100),
  fit_components jsonb not null,
  priority_components jsonb not null,
  recommended_cv_family public.cv_family,
  strengths jsonb not null default '[]'::jsonb,
  weaknesses jsonb not null default '[]'::jsonb,
  application_strategy text,
  cover_letter_value text check (cover_letter_value in ('high','medium','low','not_accepted')),
  evidence_item_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete restrict,
  state public.application_state not null default 'preparing',
  source_tracker_row integer,
  source_tracker_values jsonb,
  applied_at timestamptz,
  submitted_at timestamptz,
  external_application_id text,
  next_action text,
  deadline_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, job_id)
);

create table public.application_strategies (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  job_analysis_id uuid references public.job_analyses(id) on delete set null,
  strategy_text text not null,
  evidence_item_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.application_answers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  question_key text,
  question_text text not null,
  answer_text text,
  trust public.answer_trust not null,
  required boolean not null default true,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  source_fact_id uuid references public.candidate_facts(id) on delete set null,
  source_reusable_answer_id uuid references public.reusable_answers(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references public.applications(id) on delete cascade,
  profile_id uuid references public.candidate_profiles(id) on delete cascade,
  kind public.document_kind not null,
  title text not null,
  cv_family public.cv_family,
  created_at timestamptz not null default now(),
  check (application_id is not null or profile_id is not null)
);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  structured_content jsonb not null default '{}'::jsonb,
  latex_source text,
  rendered_object_key text,
  model text,
  prompt_version text,
  change_summary jsonb not null default '[]'::jsonb,
  approval_status text not null default 'draft' check (approval_status in ('draft','needs_review','approved','rejected','submitted')),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  submission_locked_at timestamptz,
  created_at timestamptz not null default now(),
  unique(document_id, version_number)
);

create table public.document_evidence_links (
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  evidence_item_id uuid not null references public.evidence_items(id) on delete restrict,
  claim_key text not null,
  primary key(document_version_id, evidence_item_id, claim_key)
);

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_message_id text not null,
  provider_thread_id text,
  sender text,
  subject text,
  received_at timestamptz,
  classification public.email_classification,
  confidence numeric(5,4) check (confidence between 0 and 1),
  snippet text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, provider_message_id)
);

create table public.application_email_links (
  application_id uuid not null references public.applications(id) on delete cascade,
  email_id uuid not null references public.emails(id) on delete cascade,
  confidence numeric(5,4) check (confidence between 0 and 1),
  primary key(application_id, email_id)
);

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  provider text,
  assessment_type text,
  invited_at timestamptz,
  deadline_at timestamptz,
  estimated_minutes integer,
  status text not null default 'pending' check (status in ('pending','in_progress','completed','expired','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  interview_type text,
  round_label text,
  scheduled_at timestamptz,
  participants jsonb not null default '[]'::jsonb,
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','rescheduled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.automation_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_type text not null,
  state public.task_state not null default 'pending',
  idempotency_key text not null,
  entity_type text,
  entity_id uuid,
  attempt_count integer not null default 0,
  last_error text,
  input_json jsonb not null default '{}'::jsonb,
  output_json jsonb,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','system','ai','integration')),
  actor_id text,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.application_state_transitions (
  from_state public.application_state not null,
  to_state public.application_state not null,
  primary key(from_state, to_state)
);

insert into public.application_state_transitions(from_state,to_state) values
('discovered','triaged'),
('triaged','shortlisted'),('triaged','expired'),
('shortlisted','preparing'),('shortlisted','withdrawn'),('shortlisted','expired'),
('preparing','ready_for_review'),('preparing','form_needs_user'),('preparing','withdrawn'),
('ready_for_review','revision_requested'),('ready_for_review','content_approved'),('ready_for_review','withdrawn'),
('revision_requested','preparing'),('revision_requested','ready_for_review'),('revision_requested','withdrawn'),
('content_approved','form_in_progress'),('content_approved','withdrawn'),
('form_in_progress','form_needs_user'),('form_in_progress','final_review'),('form_in_progress','withdrawn'),
('form_needs_user','form_in_progress'),('form_needs_user','withdrawn'),
('final_review','revision_requested'),('final_review','approved_for_submission'),('final_review','withdrawn'),
('approved_for_submission','submitted'),('approved_for_submission','final_review'),('approved_for_submission','withdrawn'),
('submitted','awaiting_response'),('submitted','assessment'),('submitted','interview'),('submitted','offer'),('submitted','rejected'),
('awaiting_response','assessment'),('awaiting_response','interview'),('awaiting_response','offer'),('awaiting_response','rejected'),('awaiting_response','withdrawn'),
('assessment','awaiting_response'),('assessment','interview'),('assessment','offer'),('assessment','rejected'),('assessment','withdrawn'),
('interview','awaiting_response'),('interview','assessment'),('interview','offer'),('interview','rejected'),('interview','withdrawn');

create or replace function public.transition_application_state(p_application_id uuid, p_to_state public.application_state, p_metadata jsonb default '{}'::jsonb)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app public.applications;
  v_user uuid := auth.uid();
begin
  select * into v_app from public.applications where id = p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if v_user is not null and v_app.user_id <> v_user then raise exception 'Not authorised'; end if;
  if v_app.state = p_to_state then return v_app; end if;
  if not exists (select 1 from public.application_state_transitions where from_state=v_app.state and to_state=p_to_state) then
    raise exception 'Invalid application transition: % -> %', v_app.state, p_to_state;
  end if;
  update public.applications set state=p_to_state, updated_at=now(), submitted_at=case when p_to_state='submitted' then coalesce(submitted_at,now()) else submitted_at end where id=p_application_id returning * into v_app;
  insert into public.audit_events(user_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata)
  values(v_app.user_id, case when v_user is null then 'system' else 'user' end, v_user::text, 'application.state_changed', 'application', v_app.id, jsonb_build_object('to_state',p_to_state) || p_metadata);
  return v_app;
end;
$$;

create or replace function public.prevent_locked_document_version_changes()
returns trigger language plpgsql as $$
begin
  if old.submission_locked_at is not null and (
    new.structured_content is distinct from old.structured_content or
    new.latex_source is distinct from old.latex_source or
    new.rendered_object_key is distinct from old.rendered_object_key or
    new.document_id is distinct from old.document_id
  ) then raise exception 'Submitted document version is immutable'; end if;
  return new;
end;
$$;

create trigger document_versions_immutable_after_submission before update on public.document_versions for each row execute function public.prevent_locked_document_version_changes();

-- RLS baseline
alter table public.candidate_profiles enable row level security;
alter table public.candidate_facts enable row level security;
alter table public.evidence_sources enable row level security;
alter table public.evidence_items enable row level security;
alter table public.candidate_preferences enable row level security;
alter table public.reusable_answers enable row level security;
alter table public.companies enable row level security;
alter table public.jobs enable row level security;
alter table public.job_snapshots enable row level security;
alter table public.job_requirements enable row level security;
alter table public.job_analyses enable row level security;
alter table public.applications enable row level security;
alter table public.application_strategies enable row level security;
alter table public.application_answers enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_evidence_links enable row level security;
alter table public.emails enable row level security;
alter table public.application_email_links enable row level security;
alter table public.assessments enable row level security;
alter table public.interviews enable row level security;
alter table public.automation_tasks enable row level security;
alter table public.audit_events enable row level security;

create policy candidate_profiles_owner on public.candidate_profiles for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy companies_owner on public.companies for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy jobs_owner on public.jobs for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy applications_owner on public.applications for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy emails_owner on public.emails for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy tasks_owner on public.automation_tasks for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy audit_owner_read on public.audit_events for select using (user_id=auth.uid());

-- Child-table RLS policies are intentionally added in the next migration after helper functions are defined.
-- Until then, they remain inaccessible through the public Data API, which is the safer default.
