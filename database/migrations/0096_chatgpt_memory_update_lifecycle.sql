-- M38: persist the lifecycle of incremental, user-confirmed ChatGPT Memory
-- updates separately from the initial profile import.

alter table public.candidate_chatgpt_memory
  add column if not exists memory_update_status text not null default 'not_requested',
  add column if not exists memory_update_dispatch_ids uuid[] not null default '{}'::uuid[],
  add column if not exists memory_update_requested_at timestamptz,
  add column if not exists memory_update_completed_at timestamptz,
  add column if not exists memory_update_error text,
  add column if not exists memory_update_fingerprint text;

alter table public.candidate_chatgpt_memory
  drop constraint if exists candidate_chatgpt_memory_update_status_check;
alter table public.candidate_chatgpt_memory
  add constraint candidate_chatgpt_memory_update_status_check
  check (memory_update_status in ('not_requested','queued','in_progress','completed','failed','user_required'));

comment on column public.candidate_chatgpt_memory.memory_update_status is
  'Lifecycle of the latest incremental, user-confirmed professional-background Memory update.';
comment on column public.candidate_chatgpt_memory.memory_update_dispatch_ids is
  'Ordered Website Bridge dispatch IDs for the latest incremental Memory update.';
comment on column public.candidate_chatgpt_memory.memory_update_fingerprint is
  'Deterministic fingerprint of the ordered incremental Memory instructions; used for safe idempotency.';
