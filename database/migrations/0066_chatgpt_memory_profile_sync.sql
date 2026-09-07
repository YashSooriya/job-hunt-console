-- M34: explicit ChatGPT Memory consent and Website Bridge profile import state.
-- The bridge can ask ChatGPT for a user-authorised summary, but JobHuntAI
-- never treats that summary as verified without the user's review.

alter table public.candidate_chatgpt_memory
  add column if not exists consent_status text not null default 'undecided',
  add column if not exists memory_import_status text not null default 'not_requested',
  add column if not exists memory_import_dispatch_id uuid references public.chatgpt_dispatch_requests(id) on delete set null,
  add column if not exists memory_import_requested_at timestamptz,
  add column if not exists memory_import_completed_at timestamptz,
  add column if not exists memory_import_error text,
  add column if not exists memory_sync_enabled boolean not null default false;

alter table public.candidate_chatgpt_memory
  drop constraint if exists candidate_chatgpt_memory_consent_status_check;
alter table public.candidate_chatgpt_memory
  add constraint candidate_chatgpt_memory_consent_status_check
  check (consent_status in ('undecided','allowed','declined'));

alter table public.candidate_chatgpt_memory
  drop constraint if exists candidate_chatgpt_memory_import_status_check;
alter table public.candidate_chatgpt_memory
  add constraint candidate_chatgpt_memory_import_status_check
  check (memory_import_status in ('not_requested','queued','in_progress','completed','failed','user_required'));

-- The old confirmation only covered the reminder to enable ChatGPT Memory.
-- This feature adds a new permission to import Memory into JobHuntAI and to
-- send confirmed profile updates back to ChatGPT, so require a fresh choice.
update public.candidate_chatgpt_memory
   set consent_status = 'undecided',
       memory_enabled_user_confirmed = false,
       memory_sync_enabled = false,
       memory_import_status = 'not_requested',
       memory_import_dispatch_id = null,
       memory_import_requested_at = null,
       memory_import_completed_at = null,
       memory_import_error = null;

comment on column public.candidate_chatgpt_memory.consent_status is
  'Whether the user allowed JobHuntAI to use ChatGPT Memory for professional-background import.';
comment on column public.candidate_chatgpt_memory.memory_sync_enabled is
  'Whether confirmed JobHuntAI profile details may be sent to ChatGPT to update Memory.';
