-- Milestone 16: invite-only multi-user tenancy.
create table if not exists private.app_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (email=lower(email)),
  role text not null check(role in ('owner','admin','member')),
  status text not null default 'active' check(status in ('active','revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(), revoked_at timestamptz, updated_at timestamptz not null default now()
);
create table if not exists private.app_invitations (
  id uuid primary key default gen_random_uuid(), email text not null unique check(email=lower(email)),
  role text not null default 'member' check(role in ('owner','admin','member')),
  status text not null default 'pending' check(status in ('pending','accepted','revoked')),
  invited_by uuid references auth.users(id) on delete set null, accepted_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(), accepted_at timestamptz, revoked_at timestamptz,
  expires_at timestamptz, updated_at timestamptz not null default now()
);
insert into private.app_memberships(user_id,email,role,status,joined_at)
select b.claimed_by,lower(b.intended_email),'owner','active',coalesce(b.claimed_at,now()) from private.bootstrap_import_batches b
where b.claimed_by is not null on conflict(user_id) do nothing;
insert into private.app_invitations(email,role,status,invited_at,expires_at)
select lower(b.intended_email),'owner','pending',now(),now()+interval '30 days' from private.bootstrap_import_batches b
where b.claimed_by is null and not exists(select 1 from private.app_memberships m where m.role='owner' and m.status='active')
on conflict(email) do nothing;

create or replace function private.get_my_membership_internal() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=(select auth.uid()); v_email text:=lower(coalesce(auth.jwt()->>'email','')); v_member private.app_memberships%rowtype;
begin if v_user is null then return jsonb_build_object('authenticated',false,'active',false,'role',null,'email',null,'can_manage_members',false); end if;
select * into v_member from private.app_memberships where user_id=v_user;
if not found then return jsonb_build_object('authenticated',true,'active',false,'role',null,'email',v_email,'can_manage_members',false); end if;
return jsonb_build_object('authenticated',true,'active',v_member.status='active' and v_member.email=v_email,'role',v_member.role,'email',v_member.email,'status',v_member.status,'joined_at',v_member.joined_at,'can_manage_members',v_member.status='active' and v_member.role in ('owner','admin')); end $$;
create or replace function public.get_my_membership() returns jsonb language sql stable set search_path='' as $$select private.get_my_membership_internal();$$;

create or replace function private.accept_app_membership_internal() returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=(select auth.uid()); v_email text:=lower(coalesce(auth.jwt()->>'email','')); v_member private.app_memberships%rowtype; v_invite private.app_invitations%rowtype;
begin if v_user is null then raise exception 'Authentication required'; end if; if v_email='' then raise exception 'Authenticated user has no email claim'; end if;
select * into v_member from private.app_memberships where user_id=v_user;
if found and v_member.status='active' and v_member.email=v_email then return jsonb_build_object('allowed',true,'new_member',false,'role',v_member.role,'email',v_member.email); end if;
select * into v_invite from private.app_invitations where email=v_email and status='pending' and (expires_at is null or expires_at>now()) for update;
if not found then return jsonb_build_object('allowed',false,'reason',case when v_member.user_id is not null and v_member.status='revoked' then 'membership_revoked' else 'not_invited' end,'email',v_email); end if;
insert into private.app_memberships(user_id,email,role,status,invited_by,joined_at,revoked_at,updated_at) values(v_user,v_email,v_invite.role,'active',v_invite.invited_by,now(),null,now()) on conflict(user_id) do update set email=excluded.email,role=excluded.role,status='active',invited_by=excluded.invited_by,revoked_at=null,updated_at=now();
update private.app_invitations set status='accepted',accepted_by=v_user,accepted_at=now(),revoked_at=null,updated_at=now() where id=v_invite.id;
return jsonb_build_object('allowed',true,'new_member',true,'role',v_invite.role,'email',v_email); end $$;
create or replace function public.accept_app_membership() returns jsonb language sql set search_path='' as $$select private.accept_app_membership_internal();$$;

create or replace function private.get_access_roster_internal() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=(select auth.uid()); v_role text; v_members jsonb; v_invites jsonb; begin select role into v_role from private.app_memberships where user_id=v_user and status='active'; if coalesce(v_role,'') not in ('owner','admin') then raise exception 'Administrator membership required'; end if;
select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',m.email,'role',m.role,'status',m.status,'joined_at',m.joined_at,'revoked_at',m.revoked_at,'is_self',m.user_id=v_user) order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,m.email),'[]'::jsonb) into v_members from private.app_memberships m;
select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'status',i.status,'invited_at',i.invited_at,'expires_at',i.expires_at) order by i.invited_at desc),'[]'::jsonb) into v_invites from private.app_invitations i where i.status='pending'; return jsonb_build_object('role',v_role,'members',v_members,'invitations',v_invites); end $$;
create or replace function public.get_access_roster() returns jsonb language sql stable set search_path='' as $$select private.get_access_roster_internal();$$;

create or replace function private.invite_app_member_internal(p_email text,p_role text default 'member') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=(select auth.uid()); v_actor_role text; v_email text:=lower(btrim(coalesce(p_email,''))); v_existing private.app_memberships%rowtype; v_invite private.app_invitations%rowtype; begin select role into v_actor_role from private.app_memberships where user_id=v_user and status='active'; if coalesce(v_actor_role,'') not in ('owner','admin') then raise exception 'Administrator membership required'; end if; if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'A valid email address is required'; end if; if coalesce(p_role,'') not in ('member','admin') then raise exception 'Invited role must be member or admin'; end if; if v_actor_role='admin' and p_role<>'member' then raise exception 'Only the owner can invite administrators'; end if;
select * into v_existing from private.app_memberships where email=v_email; if found and v_existing.status='active' then return jsonb_build_object('invited',false,'reason','already_member','email',v_email,'role',v_existing.role); end if;
insert into private.app_invitations(email,role,status,invited_by,invited_at,expires_at,updated_at) values(v_email,p_role,'pending',v_user,now(),now()+interval '30 days',now()) on conflict(email) do update set role=excluded.role,status='pending',invited_by=v_user,accepted_by=null,invited_at=now(),accepted_at=null,revoked_at=null,expires_at=now()+interval '30 days',updated_at=now() returning * into v_invite; return jsonb_build_object('invited',true,'id',v_invite.id,'email',v_invite.email,'role',v_invite.role,'expires_at',v_invite.expires_at); end $$;
create or replace function public.invite_app_member(p_email text,p_role text default 'member') returns jsonb language sql set search_path='' as $$select private.invite_app_member_internal(p_email,p_role);$$;

create or replace function private.revoke_app_member_internal(p_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=(select auth.uid()); v_actor_role text; v_target private.app_memberships%rowtype; begin select role into v_actor_role from private.app_memberships where user_id=v_user and status='active'; if coalesce(v_actor_role,'') not in ('owner','admin') then raise exception 'Administrator membership required'; end if; if p_user_id=v_user then raise exception 'You cannot revoke your own membership'; end if; select * into v_target from private.app_memberships where user_id=p_user_id for update; if not found then return jsonb_build_object('revoked',false,'reason','not_found'); end if; if v_target.role='owner' then raise exception 'The owner cannot be revoked'; end if; if v_actor_role='admin' and v_target.role='admin' then raise exception 'Administrators cannot revoke other administrators'; end if; update private.app_memberships set status='revoked',revoked_at=now(),updated_at=now() where user_id=p_user_id; return jsonb_build_object('revoked',true,'user_id',p_user_id,'email',v_target.email); end $$;
create or replace function public.revoke_app_member(p_user_id uuid) returns jsonb language sql set search_path='' as $$select private.revoke_app_member_internal(p_user_id);$$;
create or replace function private.cancel_app_invitation_internal(p_invitation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare v_user uuid:=(select auth.uid()); v_actor_role text; v_invite private.app_invitations%rowtype; begin select role into v_actor_role from private.app_memberships where user_id=v_user and status='active'; if coalesce(v_actor_role,'') not in ('owner','admin') then raise exception 'Administrator membership required'; end if; select * into v_invite from private.app_invitations where id=p_invitation_id for update; if not found then return jsonb_build_object('cancelled',false,'reason','not_found'); end if; if v_invite.role='owner' then raise exception 'The owner invitation cannot be cancelled'; end if; if v_actor_role='admin' and v_invite.role='admin' then raise exception 'Administrators cannot cancel administrator invitations'; end if; if v_invite.status<>'pending' then return jsonb_build_object('cancelled',false,'reason','not_pending'); end if; update private.app_invitations set status='revoked',revoked_at=now(),updated_at=now() where id=p_invitation_id; return jsonb_build_object('cancelled',true,'id',p_invitation_id,'email',v_invite.email); end $$;
create or replace function public.cancel_app_invitation(p_invitation_id uuid) returns jsonb language sql set search_path='' as $$select private.cancel_app_invitation_internal(p_invitation_id);$$;
