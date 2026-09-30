-- Allow an authenticated owner to replace a previously uploaded onboarding
-- object. The web app intentionally uses Supabase Storage upsert so retries
-- and edits are idempotent; without the matching UPDATE policy, a second save
-- fails with `new row violates row-level security policy` even though the
-- INSERT policy allows the first upload.
drop policy if exists jobhunt_candidate_sources_update on storage.objects;

create policy jobhunt_candidate_sources_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'candidate-source-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'candidate-source-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
