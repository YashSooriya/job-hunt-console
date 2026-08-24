"use client";
import { useCallback, useEffect, useState } from "react";

type Member = { user_id:string; email:string; role:"owner"|"admin"|"member"; status:"active"|"revoked"; joined_at:string; revoked_at:string|null; is_self:boolean };
type Invitation = { id:string; email:string; role:"admin"|"member"; status:string; invited_at:string; expires_at:string|null };
type Roster = { role:"owner"|"admin"; members:Member[]; invitations:Invitation[] };

export function MemberAdmin() {
  const [roster,setRoster]=useState<Roster|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [email,setEmail]=useState("");
  const [role,setRole]=useState<"member"|"admin">("member");
  const load=useCallback(async()=>{
    const r=await fetch('/api/members/roster',{cache:'no-store'}); const j=await r.json();
    if(!r.ok||!j.ok) throw new Error(j.error||'Unable to load members.'); setRoster(j.roster);
  },[]);
  useEffect(()=>{load().catch(e=>setError(e.message));},[load]);
  async function act(url:string,body:any){setBusy(true);setError(null);try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Request failed.');await load();}catch(e){setError(e instanceof Error?e.message:'Request failed.');}finally{setBusy(false)}}
  return <div className="memberAdmin">
    {error?<div className="errorNotice">{error}</div>:null}
    <section className="card memberInviteCard"><div className="cardHeader"><div><h2>Invite someone</h2><p>They must sign in with this exact Google email. Invitations expire after 30 days.</p></div></div>
      <form className="memberInviteForm" onSubmit={async e=>{e.preventDefault();await act('/api/members/invite',{email,role});setEmail('');}}>
        <label><span>Email</span><input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="friend@example.com" /></label>
        <label><span>Role</span><select value={role} onChange={e=>setRole(e.target.value as any)} disabled={roster?.role!=='owner'}><option value="member">Member</option>{roster?.role==='owner'?<option value="admin">Admin</option>:null}</select></label>
        <button className="primaryButton" disabled={busy} type="submit">Send invitation</button>
      </form>
    </section>
    <section className="card memberListCard"><div className="cardHeader"><div><h2>Members</h2><p>Access is enforced in PostgreSQL as well as the application.</p></div></div>
      <div className="factsList">{(roster?.members||[]).map(m=><div className="memberRow" key={m.user_id}><div><strong>{m.email}</strong><span>{m.role} · {m.status}</span></div><div className="buttonRow">{m.role!=='owner'&&!m.is_self&&m.status==='active'&&(roster?.role==='owner'||m.role==='member')?<button className="secondaryButton" disabled={busy} onClick={()=>act('/api/members/revoke',{userId:m.user_id})}>Revoke</button>:null}</div></div>)}</div>
    </section>
    <section className="card memberListCard"><div className="cardHeader"><div><h2>Pending invitations</h2><p>Only the invited email can accept an invitation.</p></div></div>
      <div className="factsList">{(roster?.invitations||[]).length?(roster?.invitations||[]).map(i=><div className="memberRow" key={i.id}><div><strong>{i.email}</strong><span>{i.role} · expires {i.expires_at?new Date(i.expires_at).toLocaleDateString():'never'}</span></div>{roster?.role==='owner'||i.role==='member'?<button className="secondaryButton" disabled={busy} onClick={()=>act('/api/members/invitations/cancel',{invitationId:i.id})}>Cancel</button>:null}</div>):<div className="emptyState">No pending invitations.</div>}</div>
    </section>
  </div>;
}
