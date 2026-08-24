-- Milestone 17 follow-up: cover provenance foreign keys used by imported applicant evidence.
create index if not exists candidate_education_source_idx on public.candidate_education(source_id);
create index if not exists candidate_employment_source_idx on public.candidate_employment(source_id);
create index if not exists candidate_skills_source_idx on public.candidate_skills(source_id);
create index if not exists candidate_projects_source_idx on public.candidate_projects(source_id);
create index if not exists candidate_publications_source_idx on public.candidate_publications(source_id);
