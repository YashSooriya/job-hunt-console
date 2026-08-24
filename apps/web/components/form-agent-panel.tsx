"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Session = { id:string; status:string; expires_at?:string; expiresAt?:string; current_url?:string; currentUrl?:string; current_title?:string; currentTitle?:string; pause_reasons?:string[]; pauseReasons?:string[]; final_review?:any; finalReview?:any; submit_candidate?:any; submitCandidate?:any; acceptance_mode?:boolean; acceptance_provider_family?:string|null } | null;
type Helper = { paired:boolean; device?:{id:string;display_name:string;online:boolean;last_seen_at?:string|null}|null };

export function FormAgentPanel({ applicationId, applicationState }: { applicationId: string; applicationState: string }) {
  const router = useRouter();
  const [session, setSession] = useState<Session>(null);
  const [helper,setHelper]=useState<Helper>({paired:false,device:null});
  const [fallbackCommand, setFallbackCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptanceProvider,setAcceptanceProvider]=useState("greenhouse");

  async function refresh() {
    const [sr,hr]=await Promise.all([fetch(`/api/applications/${applicationId}/form/status`,{cache:"no-store"}),fetch("/api/browser-helper/status",{cache:"no-store"})]);
    const [sd,hd]=await Promise.all([sr.json(),hr.json()]);
    if(sd.ok)setSession(sd.session||null); if(hd.ok)setHelper({paired:Boolean(hd.paired),device:hd.device||null});
  }
  useEffect(() => { refresh(); const t=setInterval(refresh,3000); return ()=>clearInterval(t); }, [applicationId]);

  async function start() {
    setBusy(true); setError(null); setFallbackCommand(null);
    try {
      const payload=helper.paired&&helper.device?{deviceId:helper.device.id}:{};
      const r = await fetch(`/api/applications/${applicationId}/form/start`, { method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload) }); const d=await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Could not start form session.");
      setSession({ id:d.session_id, status:d.status, expiresAt:d.expires_at });
      if(d.manual_fallback&&d.token&&d.supabase_url) setFallbackCommand(`npm run browser:agent -- --session ${d.session_id} --token ${d.token} --supabase ${d.supabase_url}`);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function startAcceptance() {
    if(!helper.paired||!helper.device) return;
    setBusy(true);setError(null);setFallbackCommand(null);
    try{
      const r=await fetch(`/api/applications/${applicationId}/form/acceptance/start`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId:helper.device.id,providerFamily:acceptanceProvider})});
      const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Could not start acceptance session.");
      setSession({id:d.session_id,status:d.status,expiresAt:d.expires_at,acceptance_mode:true,acceptance_provider_family:d.provider_family});
      router.refresh();
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }

  async function resume() {
    if(!session)return;setBusy(true);setError(null);
    try{const r=await fetch(`/api/applications/${applicationId}/form/resume`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:session.id})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Could not resume helper.");await refresh();router.refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function approve(kind:"approve"|"manual") {
    if (!session) return; setBusy(true); setError(null);
    try {
      const path = kind === "approve" ? "approve" : "manual-submitted";
      const r=await fetch(`/api/applications/${applicationId}/form/${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:session.id})});
      const d=await r.json(); if(!r.ok||!d.ok) throw new Error(d.error||"Action failed");
      await refresh(); router.refresh();
    } catch(e){setError(e instanceof Error?e.message:String(e));} finally{setBusy(false);}
  }

  const status = session?.status || null;
  const canStart = ["content_approved","form_in_progress","form_needs_user"].includes(applicationState) && (!session || ["cancelled","expired","failed"].includes(status||""));
  const review = (session as any)?.final_review || (session as any)?.finalReview;
  return <section className="card formAgentCard">
    <div className="cardHeader"><div><div className="eyebrow">Adaptive browser agent</div><h2>Employer form</h2><p>Website-agnostic local browser completion. The helper re-observes after every action and stops for uncertainty, authentication and final submission.</p></div>{status ? <span className={`badge ${status==="final_review"?"action":status==="submitted"?"review":"muted"}`}>{status.replaceAll("_"," ")}</span> : null}</div>
    <div className="notice"><strong>Mac helper:</strong> {helper.paired ? <>{helper.device?.display_name} · <span className={helper.device?.online?"checkDone":"checkOpen"}>{helper.device?.online?"online":"offline"}</span></> : <>not paired · <a href="/settings">pair it in Settings</a></>}</div>
    {canStart ? <button className="primaryButton" disabled={busy} onClick={start}>{busy?"Starting…":helper.paired?"Prepare employer form":"Start with manual helper"}</button> : null}
    {canStart && helper.paired ? <details className="notice"><summary><strong>Commissioning: no-submit ATS acceptance</strong></summary><p>Use only while qualifying V1. This mode may fill the form and reach final review, but the database and helper record that Submit was not clicked and restore the Application to Content Approved afterward.</p><div className="buttonRow"><select value={acceptanceProvider} onChange={(e)=>setAcceptanceProvider(e.target.value)}><option value="greenhouse">Greenhouse</option><option value="lever">Lever</option><option value="workday">Workday</option><option value="ashby">Ashby</option><option value="smartrecruiters">SmartRecruiters</option><option value="successfactors">SuccessFactors</option><option value="custom">Custom employer form</option></select><button className="secondaryButton" disabled={busy} onClick={startAcceptance}>Run no-submit acceptance</button></div></details> : null}
    {helper.paired && status === "active" ? <div className="notice successNotice">{session?.acceptance_mode?`No-submit acceptance queued for ${session.acceptance_provider_family || "this ATS"}. The final Submit control is disabled by mode.`:"Queued for the paired Mac helper. No session token or Terminal command is required. If the helper is offline, it will pick this up when it starts."}</div> : null}
    {fallbackCommand ? <div className="notice"><strong>Diagnostic fallback:</strong><pre className="commandBlock">{fallbackCommand}</pre><p>Pair the Mac helper to remove this per-application command from normal use.</p></div> : null}
    {status === "needs_user" ? <div className="notice actionNotice"><strong>Helper needs you</strong><p>Resolve the login, MFA/CAPTCHA, sensitive declaration, or unknown required field in Job Hunt Chrome, then resume the background helper.</p><button className="primaryButton" disabled={busy} onClick={resume}>Resume helper</button></div> : null}
    {status === "final_review" ? <>
      <div className="notice actionNotice"><strong>Approval Gate 2</strong><p>Inspect the actual employer form in Chrome before allowing submission. The helper is waiting and cannot click the final submission control yet.</p></div>
      {review?.summary ? <div className="reviewChecklist"><div className="reviewCheck"><span className={review.summary.unresolved===0?"checkDone":"checkOpen"}>{review.summary.unresolved===0?"✓":"○"}</span><span>{review.summary.unresolved} unresolved fields</span></div><div className="reviewCheck"><span className="checkDone">✓</span><span>{review.summary.user_entered||0} user-entered fields preserved</span></div><div className="reviewCheck"><span className="checkDone">✓</span><span>{review.summary.approved_or_present||0} approved/present fields</span></div></div> : null}
      <div className="buttonRow"><button className="primaryButton" disabled={busy || (review?.summary?.unresolved||0)>0} onClick={()=>approve("approve")}>Approve & submit with helper</button><button className="secondaryButton" disabled={busy} onClick={()=>approve("manual")}>I submitted it myself</button></div>
    </> : null}
    {status === "approved_for_submission" ? <div className="notice successNotice">Gate 2 approved. The paired helper may now click only the reviewed final submission control.</div> : null}
    {status === "submitted" || applicationState === "submitted" ? <div className="notice successNotice">Submission recorded. The exact submitted package is immutable and available for later interview/assessment preparation.</div> : null}
    {error ? <p className="formError">{error}</p> : null}
  </section>;
}
