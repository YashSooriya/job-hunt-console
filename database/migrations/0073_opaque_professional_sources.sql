-- Normal CVs and other user-provided sources are intentionally stored without
-- local text extraction. ChatGPT reviews them through the Website Bridge.
alter table public.candidate_source_documents
  drop constraint if exists candidate_source_documents_extraction_status_check;

alter table public.candidate_source_documents
  add constraint candidate_source_documents_extraction_status_check
  check (extraction_status in ('pending','stored','extracted','needs_text','failed'));
