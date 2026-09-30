-- Group separately dispatched Website Bridge listing inspections into a
-- durable user-owned batch. Each inspection remains its own exact-turn job
-- and retains the existing v3 completion/provenance boundary.
alter table public.job_url_inspection_requests
  add column batch_id uuid,
  add column batch_position integer,
  add column dispatch_request_id uuid references public.chatgpt_dispatch_requests(id) on delete set null;

alter table public.job_url_inspection_requests
  add constraint job_url_inspection_requests_batch_shape_check
  check (
    (batch_id is null and batch_position is null)
    or (batch_id is not null and batch_position between 1 and 10)
  );

create unique index job_url_inspection_requests_batch_position_idx
  on public.job_url_inspection_requests(batch_id, batch_position)
  where batch_id is not null;

create index job_url_inspection_requests_dispatch_idx
  on public.job_url_inspection_requests(dispatch_request_id)
  where dispatch_request_id is not null;

drop policy if exists job_url_inspection_requests_owner_update_dispatch on public.job_url_inspection_requests;
create policy job_url_inspection_requests_owner_update_dispatch
  on public.job_url_inspection_requests
  for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- The historical default table grant includes UPDATE on every column, so
-- revoke it before granting only the server-owned dispatch link. RLS limits
-- this update to the row owner; column privileges prevent changing inspection
-- state, extraction, errors, or job linkage.
revoke update on public.job_url_inspection_requests from authenticated;
grant update(dispatch_request_id) on public.job_url_inspection_requests to authenticated;

comment on column public.job_url_inspection_requests.batch_id is
  'Client-generated grouping id for a bounded bulk URL import; null for legacy single imports.';
comment on column public.job_url_inspection_requests.batch_position is
  'Stable one-based ordering within a bulk URL import.';
comment on column public.job_url_inspection_requests.dispatch_request_id is
  'The generic Website Bridge dispatch that owns this inspection’s exact ChatGPT turn.';

-- Retire bearer credentials for the deleted user-created ChatGPT app. The
-- Website Bridge has separate device credentials and is deliberately untouched.
update private.chatgpt_oauth_access_tokens
   set revoked_at = coalesce(revoked_at, now())
 where revoked_at is null;
