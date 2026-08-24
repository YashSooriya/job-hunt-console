create index if not exists app_memberships_invited_by_idx on private.app_memberships(invited_by);
create index if not exists app_invitations_invited_by_idx on private.app_invitations(invited_by);
create index if not exists app_invitations_accepted_by_idx on private.app_invitations(accepted_by);
