"use client";
import { useState } from "react";

export function EmailReviewForm({ emailId, applications, initialApplicationId, initialClassification, classificationSource, live }: { emailId:string; applications:Array<{id:string;label:string}>; initialApplicationId:string|null; initialClassification:string|null; classificationSource?:string|null; live:boolean }) {
  const [applicationId,setApplicationId]=useState(initialApplicationId||"");
  const [classification,setClassification]=useState(initialClassification||"uncertain");
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState("");
  async function save(){
    if(!live){setMessage("Local snapshot mode is read-only.");return;} if(!applicationId){setMessage("Choose the matching application.");return;}
    setBusy(true); setMessage("");
    const res=await fetch("/api/email/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({emailId,applicationId,classification})});
    const data=await res.json(); setBusy(false);
    if(!res.ok){setMessage(data.error||"Could not resolve email.");return;}
    setMessage("Email resolved and application timeline updated."); setTimeout(()=>window.location.href=`/applications/${applicationId}`,700);
  }
  return <div className="reviewDecisionForm">
    <label>Application<select value={applicationId} onChange={e=>setApplicationId(e.target.value)}><option value="">Select application</option>{applications.map(a=><option value={a.id} key={a.id}>{a.label}</option>)}</select></label>
    <label>Classification{classificationSource === "chatgpt" ? <small className="formHelp">ChatGPT assigned this category; change it only if needed.</small> : null}<select value={classification} onChange={e=>setClassification(e.target.value)}>{["confirmation","rejection","assessment","interview","offer","recruiter_message","other","uncertain"].map(x=><option value={x} key={x}>{x.replaceAll("_"," ")}</option>)}</select></label>
    <button className="primaryButton" type="button" disabled={busy} onClick={()=>void save()}>{busy?"Saving…":"Confirm email"}</button>{message?<p className="formHelp">{message}</p>:null}
  </div>;
}
