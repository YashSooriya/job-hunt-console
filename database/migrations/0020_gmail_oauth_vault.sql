-- Milestone 8: persist the Google OAuth refresh token in encrypted Supabase Vault.
-- Provider credentials stay outside public application tables and are reachable only
-- through authenticated, user-scoped SECURITY INVOKER wrappers.

create table if not exists private.gmail_oauth_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_secret_id uuid not null,
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on table private.gmail_oauth_credentials from public, anon, authenticated;

create or replace function private.store_gmail_refresh_token(p_refresh_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_secret_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(btrim(coalesce(p_refresh_token,'')), '') is null then return false; end if;

  select refresh_secret_id into v_secret_id
  from private.gmail_oauth_credentials
  where user_id=v_user
  for update;

  if found then
    perform vault.update_secret(
      v_secret_id,
      p_refresh_token,
      null,
      'Google OAuth refresh token for Job Hunt Gmail read-only sync',
      null
    );
    update private.gmail_oauth_credentials
      set updated_at=now()
      where user_id=v_user;
  else
    v_secret_id := vault.create_secret(
      p_refresh_token,
      'job-hunt-gmail-refresh-' || v_user::text,
      'Google OAuth refresh token for Job Hunt Gmail read-only sync',
      null
    );
    insert into private.gmail_oauth_credentials(user_id,refresh_secret_id)
    values(v_user,v_secret_id);
  end if;

  return true;
end;
$$;

create or replace function private.get_gmail_refresh_token()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_token text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select ds.decrypted_secret into v_token
  from private.gmail_oauth_credentials c
  join vault.decrypted_secrets ds on ds.id=c.refresh_secret_id
  where c.user_id=v_user;
  return v_token;
end;
$$;

revoke execute on function private.store_gmail_refresh_token(text) from public, anon;
revoke execute on function private.get_gmail_refresh_token() from public, anon;
grant execute on function private.store_gmail_refresh_token(text) to authenticated;
grant execute on function private.get_gmail_refresh_token() to authenticated;

create or replace function public.store_gmail_refresh_token(p_refresh_token text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.store_gmail_refresh_token(p_refresh_token);
$$;

create or replace function public.get_gmail_refresh_token()
returns text
language sql
security invoker
set search_path = ''
as $$
  select private.get_gmail_refresh_token();
$$;

revoke execute on function public.store_gmail_refresh_token(text) from public, anon;
revoke execute on function public.get_gmail_refresh_token() from public, anon;
grant execute on function public.store_gmail_refresh_token(text) to authenticated;
grant execute on function public.get_gmail_refresh_token() to authenticated;
