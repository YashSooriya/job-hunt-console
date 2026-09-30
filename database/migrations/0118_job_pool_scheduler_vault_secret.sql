-- Keep the scheduler's shared secret in Supabase Vault instead of a manually
-- provisioned Edge Function setting. The service-only getter is consumed by
-- the trusted scheduler function and never returned to its HTTP caller.

create or replace function public.get_job_pool_scheduler_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
    from vault.decrypted_secrets ds
   where ds.name='job-pool-scheduler-secret'
   limit 1
$$;

revoke all on function public.get_job_pool_scheduler_secret() from public,anon,authenticated,service_role;
grant execute on function public.get_job_pool_scheduler_secret() to service_role;

comment on function public.get_job_pool_scheduler_secret() is
  'Service-only retrieval of the Cloudflare-to-Supabase job-pool scheduler secret from Supabase Vault.';
