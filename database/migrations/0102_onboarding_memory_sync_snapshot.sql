-- M40: retain the last successfully synchronised profile snapshot so an
-- incremental Memory update can contain only new, changed, or removed values.
-- The snapshot is user-owned onboarding state; it is never exposed to the
-- bridge device or used as a substitute for v3 response provenance.

alter table public.candidate_chatgpt_memory
  add column if not exists memory_update_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists memory_update_pending_snapshot jsonb,
  add column if not exists memory_update_pending_payload jsonb,
  add column if not exists memory_update_snapshot_version integer not null default 1;

comment on column public.candidate_chatgpt_memory.memory_update_snapshot is
  'Canonical profile values confirmed by the most recent completed incremental Memory update.';
comment on column public.candidate_chatgpt_memory.memory_update_pending_snapshot is
  'Canonical profile snapshot that will become confirmed only after every ordered update dispatch completes.';
comment on column public.candidate_chatgpt_memory.memory_update_pending_payload is
  'User-owned canonical delta staged for the latest incremental Memory update; never contains bridge credentials.';

-- Keep the existing user-owned RLS policy and grants. No client can select
-- another profile row, and the Website Bridge never receives this snapshot.
