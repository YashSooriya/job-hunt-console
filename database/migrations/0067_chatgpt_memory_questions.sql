-- M35: retain the missing-field questions returned by ChatGPT's
-- Memory-assisted profile interview so the onboarding page can show them.

alter table public.candidate_chatgpt_memory
  add column if not exists memory_import_questions jsonb not null default '[]'::jsonb;

alter table public.candidate_chatgpt_memory
  drop constraint if exists candidate_chatgpt_memory_import_questions_check;
alter table public.candidate_chatgpt_memory
  add constraint candidate_chatgpt_memory_import_questions_check
  check (jsonb_typeof(memory_import_questions) = 'array');

comment on column public.candidate_chatgpt_memory.memory_import_questions is
  'Questions ChatGPT identified while completing the user profile from Memory; shown for the user to answer or confirm.';
