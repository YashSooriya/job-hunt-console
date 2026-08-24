"use client";

import { useEffect, useState } from "react";

type Device = { id:string; display_name:string; platform:string; helper_version?:string|null; paired_at:string; last_seen_at?:string|null; online:boolean };

export function BrowserHelperSettings() {
  const [device,setDevice]=useState<Device|null>(null);
  const [paired,setPaired]=useState(false);
  const [pairing,setPairing]=useState<{code:string;expiresAt:string;command:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);

  async function refresh(){
    const r=await fetch("/api/browser-helper/status",{cache:"no-store"}); const d=await r.json();
    if(r.ok&&d.ok){setPaired(Boolean(d.paired));setDevice(d.device||null); if(d.paired) setPairing(null);}
  }
  useEffect(()=>{refresh();const t=setInterval(refresh,5000);return()=>clearInterval(t);},[]);

  async function createCode(){
    setBusy(true);setError(null);
    try{
      const r=await fetch("/api/browser-helper/pairing",{method:"POST"});const d=await r.json();
      if(!r.ok||!d.ok) throw new Error(d.error||"Could not create pairing code.");
      const command=`npm run browser:pair -- --code ${d.pairing_code} --supabase ${d.supabase_url}`;
      setPairing({code:d.pairing_code,expiresAt:d.expires_at,command});
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function revoke(){
    if(!device)return;setBusy(true);setError(null);
    try{const r=await fetch("/api/browser-helper/revoke",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId:device.id})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Could not revoke helper.");setDevice(null);setPaired(false);await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  const seen=device?.last_seen_at?new Date(device.last_seen_at).toLocaleString():"Not seen yet";
  return <section className="card">
    <div className="cardHeader"><div><div className="eyebrow">Local companion</div><h2>Browser helper</h2><p>Pair your Mac once. After installation it starts at login, keeps a dedicated Job Hunt Chrome profile and automatically picks up approved employer-form sessions.</p></div>{paired?<span className={`badge ${device?.online?"review":"action"}`}>{device?.online?"Online":"Offline"}</span>:<span className="badge muted">Not paired</span>}</div>
    {device?<div className="factsList"><div className="factRow"><div><span>Device</span><strong>{device.display_name}</strong></div><span>{device.platform}</span></div><div className="factRow"><div><span>Last heartbeat</span><strong>{seen}</strong></div><span>{device.helper_version||"helper"}</span></div></div>:null}
    {!paired?<div className="buttonRow"><button className="primaryButton" disabled={busy} onClick={createCode}>{busy?"Creating…":"Pair this Mac"}</button></div>:<div className="buttonRow"><button className="secondaryButton" disabled={busy} onClick={revoke}>Revoke helper</button></div>}
    {pairing?<div className="notice actionNotice"><strong>One-time pairing</strong><p>From the Job Hunt Console repository on your Mac, run this once before the code expires:</p><pre className="commandBlock">{pairing.command}</pre><p>Then install auto-start with <code>npm run browser:install-mac</code>. The device credential is stored in macOS Keychain, not in this page or the repository.</p></div>:null}
    {error?<p className="formError">{error}</p>:null}
  </section>;
}
