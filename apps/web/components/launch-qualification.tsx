"use client";

import { useEffect, useState, type ReactNode } from "react";

type LaunchStatus = any;

function Check({done,children}:{done:boolean;children:ReactNode}){
  return <div className="reviewCheck"><span className={done?"checkDone":"checkOpen"}>{done?"✓":"○"}</span><span>{children}</span></div>;
}

export function LaunchQualification(){
  const [status,setStatus]=useState<LaunchStatus|null>(null);const [error,setError]=useState<string|null>(null);
  async function refresh(){try{const r=await fetch("/api/launch-status",{cache:"no-store"});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Could not read launch status.");setStatus(d);setError(null);}catch(e){setError(e instanceof Error?e.message:String(e));}}
  useEffect(()=>{refresh();const t=setInterval(refresh,10000);return()=>clearInterval(t);},[]);
  const cut=status?.data_cutover||{};const helper=status?.browser_helper||{};const ats=status?.live_ats_acceptance||{};const runtime=status?.runtime||{};
  return <section className="card"><div className="cardHeader"><div><div className="eyebrow">V1 commissioning</div><h2>Launch qualification</h2><p>Source-backed browser fixtures are development evidence only. V1 is operational only after the hosted runtime, real Google cutover, paired Mac helper and live no-submit ATS matrix all pass.</p></div><span className={`badge ${status?.v1_operational?"review":"action"}`}>{status?.v1_operational?"Operational":"Not launched"}</span></div>
    <div className="reviewChecklist">
      <Check done={Boolean(runtime.hosted&&runtime.production_data_mode)}>Hosted production runtime using Supabase</Check>
      <Check done={Boolean(cut.cutover_complete&&cut.gmail_refresh_credential)}>Real Google sign-in, staged-data cutover and Gmail refresh credential</Check>
      <Check done={Boolean(helper.paired)}>Mac browser helper paired</Check>
      <Check done={Boolean(ats.greenhouse)}>Live Greenhouse no-submit run reaches final review</Check>
      <Check done={Boolean(ats.lever)}>Live Lever no-submit run reaches final review</Check>
      <Check done={Boolean(ats.workday)}>Live Workday no-submit run reaches final review</Check>
      <Check done={Boolean(ats.additional_major_ats)}>Live Ashby / SmartRecruiters / SuccessFactors run reaches final review</Check>
      <Check done={Boolean(ats.custom)}>Live custom employer form reaches final review</Check>
    </div>
    {ats.provider_families?.length?<p className="sub">Accepted live families: {ats.provider_families.join(", ")}</p>:<p className="sub">No genuine live ATS acceptance run has been recorded yet.</p>}
    {error?<p className="formError">{error}</p>:null}
  </section>;
}
