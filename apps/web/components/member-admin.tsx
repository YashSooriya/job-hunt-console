"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

type Member = {
  user_id: string;
  email: string;
  role: "owner" | "admin" | "member";
  status: "active" | "revoked";
  joined_at: string;
  revoked_at: string | null;
  is_self: boolean;
};

type Invitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  status: string;
  invited_at: string;
  expires_at: string | null;
};

type Roster = { role: "owner" | "admin"; members: Member[]; invitations: Invitation[] };
type PendingAction =
  | { type: "revoke"; member: Member }
  | { type: "restore"; member: Member }
  | { type: "promote"; member: Member }
  | { type: "demote"; member: Member }
  | { type: "delete"; member: Member }
  | { type: "cancel-invitation"; invitation: Invitation };
type ApiResponse = {
  ok?: boolean;
  error?: string;
  invitation?: { invited?: boolean; reason?: string; id?: string; email?: string; role?: string; expires_at?: string };
  result?: { restored?: boolean; changed?: boolean; deleted?: boolean };
  membership?: { revoked?: boolean; reason?: string; already_revoked?: boolean };
  invitationResult?: { cancelled?: boolean; reason?: string };
};

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function invitationExpired(invitation: Invitation) {
  return Boolean(invitation.expires_at && new Date(invitation.expires_at).getTime() <= Date.now());
}

export function MemberAdmin() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [copyFallback, setCopyFallback] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/members/roster", { cache: "no-store" });
    const body = await response.json().catch(() => null) as { ok?: boolean; error?: string; roster?: Roster } | null;
    if (!response.ok || !body?.ok || !body.roster) throw new Error(body?.error || "Unable to load members.");
    setRoster(body.roster);
  }, []);

  useEffect(() => {
    let mounted = true;
    load()
      .catch((reason: unknown) => {
        if (mounted) setError(reason instanceof Error ? reason.message : "Unable to load members.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [load]);

  async function post(url: string, body: unknown, successMessage?: string): Promise<ApiResponse | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as ApiResponse | null;
      if (!response.ok || !result?.ok) throw new Error(result?.error || "The request could not be completed.");
      if (successMessage) setNotice(successMessage);
      try {
        await load();
      } catch {
        setError("The action succeeded, but the member list could not be refreshed. Reload the page to see the latest status.");
      }
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be completed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await post("/api/members/invite", { email, role });
    if (!response) return;
    if (response.invitation?.invited) {
      setEmail("");
      setNotice(`Invitation created for ${response.invitation.email || email}. No email is sent automatically; share the sign-in link below.`);
    } else if (response.invitation?.reason === "already_member") {
      setError("That email already has an active membership.");
    } else {
      setError("The invitation was not created. Check the email and try again.");
    }
  }

  async function copySignInLink() {
    const link = `${window.location.origin}/login`;
    try {
      await navigator.clipboard.writeText(link);
      setCopyFallback(null);
      setNotice("Sign-in link copied. Share it with the invited person; they must sign in with the exact invited Google email.");
    } catch {
      setCopyFallback(link);
      setNotice("Copying was blocked by the browser. Use the sign-in link shown below.");
    }
  }

  async function renewInvitation(invitation: Invitation) {
    const result = await post("/api/members/invite", { email: invitation.email, role: invitation.role });
    if (result?.invitation?.invited) {
      setNotice(`Invitation for ${invitation.email} renewed for 30 days. No email is sent automatically; share the sign-in link.`);
    }
  }

  async function confirmAction() {
    if (!pendingAction) return;
    let result: ApiResponse | null = null;
    let successMessage = "Member updated.";

    if (pendingAction.type === "revoke") {
      successMessage = `${pendingAction.member.email} was revoked. Their scheduled searches were paused.`;
      result = await post("/api/members/revoke", { userId: pendingAction.member.user_id }, successMessage);
    } else if (pendingAction.type === "restore") {
      successMessage = `${pendingAction.member.email} was restored. Scheduled searches remain paused until they are re-enabled.`;
      result = await post("/api/members/manage", { action: "restore", userId: pendingAction.member.user_id }, successMessage);
    } else if (pendingAction.type === "promote" || pendingAction.type === "demote") {
      const nextRole = pendingAction.type === "promote" ? "admin" : "member";
      successMessage = `${pendingAction.member.email} is now an ${nextRole === "admin" ? "administrator" : "member"}.`;
      result = await post("/api/members/manage", { action: "set_role", role: nextRole, userId: pendingAction.member.user_id }, successMessage);
    } else if (pendingAction.type === "delete") {
      successMessage = `${pendingAction.member.email} and their Job Hunt Console account data were permanently deleted.`;
      result = await post("/api/members/delete", { userId: pendingAction.member.user_id }, successMessage);
    } else {
      successMessage = `Invitation for ${pendingAction.invitation.email} was cancelled.`;
      result = await post("/api/members/invitations/cancel", { invitationId: pendingAction.invitation.id }, successMessage);
    }

    if (result) {
      setPendingAction(null);
      setDeleteConfirmation("");
    }
  }

  const isDeleteConfirmed = pendingAction?.type === "delete"
    && deleteConfirmation.trim().toLowerCase() === pendingAction.member.email.trim().toLowerCase();

  return (
    <div className="memberAdmin">
      {error ? <div className="errorNotice" role="alert">{error}</div> : null}
      {notice ? <div className="memberNotice" role="status">{notice}</div> : null}

      <section className="card memberInviteCard">
        <div className="cardHeader">
          <div>
            <h2>Invite someone</h2>
            <p>Create a 30-day invitation. They must sign in with the exact Google email; this app does not send invitation email.</p>
          </div>
        </div>
        <form className="memberInviteForm" onSubmit={invite}>
          <label>
            <span>Email</span>
            <input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="friend@example.com" />
          </label>
          <label>
            <span>Role</span>
            <select value={role} onChange={(event) => setRole(event.target.value as "member" | "admin")} disabled={busy || roster?.role !== "owner"}>
              <option value="member">Member</option>
              {roster?.role === "owner" ? <option value="admin">Admin</option> : null}
            </select>
          </label>
          <button className="primaryButton" disabled={busy || loading} type="submit">Create invitation</button>
        </form>
        {copyFallback ? <div className="memberShareLink"><span>Sign-in link</span><a href={copyFallback}>{copyFallback}</a></div> : null}
      </section>

      <section className="card memberListCard">
        <div className="cardHeader">
          <div>
            <h2>Members</h2>
            <p>Admins can manage member accounts. Only the owner can manage admin roles or permanently delete accounts.</p>
          </div>
          {roster ? <span className="badge muted">Signed in as {roster.role}</span> : null}
        </div>
        {loading ? <div className="emptyState">Loading members…</div> : null}
        {!loading && roster?.members.length === 0 ? <div className="emptyState">No members yet.</div> : null}
        <div className="memberRows">
          {(roster?.members || []).map((member) => {
            const canManageMember = !member.is_self && member.role !== "owner" && (roster?.role === "owner" || member.role === "member");
            return (
              <div className="memberRow" key={member.user_id}>
                <div className="memberIdentity">
                  <strong>{member.email}{member.is_self ? " (you)" : ""}</strong>
                  <div className="memberMeta">
                    <span className={`memberStatus ${member.status}`}>{member.status}</span>
                    <span className="memberRole">{member.role}</span>
                    <span>Joined {formatDate(member.joined_at)}</span>
                    {member.revoked_at ? <span>Revoked {formatDate(member.revoked_at)}</span> : null}
                  </div>
                </div>
                <div className="buttonRow memberActions">
                  {canManageMember && member.status === "active" ? (
                    <button className="secondaryButton" disabled={busy} onClick={() => setPendingAction({ type: "revoke", member })} type="button">Revoke access</button>
                  ) : null}
                  {canManageMember && member.status === "revoked" ? (
                    <button className="secondaryButton" disabled={busy} onClick={() => setPendingAction({ type: "restore", member })} type="button">Restore access</button>
                  ) : null}
                  {roster?.role === "owner" && !member.is_self && member.role !== "owner" && member.status === "active" ? (
                    member.role === "member"
                      ? <button className="secondaryButton" disabled={busy} onClick={() => setPendingAction({ type: "promote", member })} type="button">Make admin</button>
                      : <button className="secondaryButton" disabled={busy} onClick={() => setPendingAction({ type: "demote", member })} type="button">Make member</button>
                  ) : null}
                  {roster?.role === "owner" && !member.is_self && member.role !== "owner" ? (
                    <button className="secondaryButton dangerButton memberDeleteButton" disabled={busy} onClick={() => { setDeleteConfirmation(""); setPendingAction({ type: "delete", member }); }} type="button">Delete permanently</button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card memberListCard">
        <div className="cardHeader">
          <div>
            <h2>Invitations</h2>
            <p>Share the sign-in link separately. Expired invitations can be renewed for another 30 days.</p>
          </div>
        </div>
        {!loading && (roster?.invitations || []).length === 0 ? <div className="emptyState">No open invitations.</div> : null}
        <div className="memberRows">
          {(roster?.invitations || []).map((invitation) => {
            const expired = invitationExpired(invitation);
            const canManageInvitation = roster?.role === "owner" || invitation.role === "member";
            return (
              <div className="memberRow" key={invitation.id}>
                <div className="memberIdentity">
                  <strong>{invitation.email}</strong>
                  <div className="memberMeta">
                    <span className="memberRole">{invitation.role}</span>
                    <span className={`memberStatus ${expired ? "expired" : "pending"}`}>{expired ? "expired" : "pending"}</span>
                    <span>Created {formatDate(invitation.invited_at)}</span>
                    <span>{expired ? "Expired" : "Expires"} {formatDate(invitation.expires_at)}</span>
                  </div>
                  <a className="memberSignInLink" href="/login">Sign-in page: {typeof window === "undefined" ? "/login" : `${window.location.origin}/login`}</a>
                </div>
                <div className="buttonRow memberActions">
                  <button className="secondaryButton" disabled={busy} onClick={copySignInLink} type="button">Copy sign-in link</button>
                  {expired && canManageInvitation ? <button className="secondaryButton" disabled={busy} onClick={() => renewInvitation(invitation)} type="button">Renew 30 days</button> : null}
                  {canManageInvitation ? <button className="secondaryButton" disabled={busy} onClick={() => setPendingAction({ type: "cancel-invitation", invitation })} type="button">Cancel</button> : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {pendingAction ? (
        <div className="memberDialogBackdrop">
          <section className="memberDialog" role="alertdialog" aria-modal="true" aria-labelledby="member-dialog-title" aria-describedby="member-dialog-description">
            <h2 id="member-dialog-title">
              {pendingAction.type === "revoke" ? "Revoke member access?"
                : pendingAction.type === "restore" ? "Restore member access?"
                  : pendingAction.type === "promote" ? "Make this member an admin?"
                    : pendingAction.type === "demote" ? "Change this admin to a member?"
                      : pendingAction.type === "delete" ? "Permanently delete this account?"
                        : "Cancel this invitation?"}
            </h2>
            <p id="member-dialog-description">
              {pendingAction.type === "revoke" ? <><strong>{pendingAction.member.email}</strong> will lose app access immediately. Their data stays in place and scheduled searches are paused.</>
                : pendingAction.type === "restore" ? <><strong>{pendingAction.member.email}</strong> will be able to sign in again. Their scheduled searches will remain paused.</>
                  : pendingAction.type === "promote" ? <><strong>{pendingAction.member.email}</strong> will gain administrator access to manage member accounts.</>
                    : pendingAction.type === "demote" ? <><strong>{pendingAction.member.email}</strong> will lose administrator privileges but keep member access.</>
                      : pendingAction.type === "delete" ? <>This permanently deletes <strong>{pendingAction.member.email}</strong>, their Auth login, Job Hunt Console data, and private stored documents. This cannot be undone. If cleanup encounters an error, access remains revoked and the deletion can be retried.</>
                        : <>The invitation for <strong>{pendingAction.invitation.email}</strong> will no longer be accepted.</>}
            </p>
            {pendingAction.type === "delete" ? (
              <label className="memberDeleteConfirm">
                <span>Type the member&apos;s email to confirm</span>
                <input autoComplete="off" spellCheck={false} value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} />
              </label>
            ) : null}
            {error ? <div className="memberDialogError" role="alert">{error}</div> : null}
            <div className="buttonRow memberDialogActions">
              <button className="secondaryButton" type="button" disabled={busy} onClick={() => { setPendingAction(null); setDeleteConfirmation(""); setError(null); }}>Cancel</button>
              <button
                className={pendingAction.type === "delete" ? "secondaryButton dangerButton" : "primaryButton"}
                type="button"
                disabled={busy || (pendingAction.type === "delete" && !isDeleteConfirmed)}
                onClick={confirmAction}
              >
                {busy ? "Working…" : pendingAction.type === "delete" ? "Delete account and data" : pendingAction.type === "cancel-invitation" ? "Cancel invitation" : "Confirm"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
