"use client";
import { useEffect, useState } from "react";

export function GmailSync({ auto = true }: { auto?: boolean }) {
  const [state,setState]=useState<{busy:boolean;message:string}>({busy:false,message:""});
  async function sync(manual=false) {
    if (state.busy) return;
    if (!manual && typeof window!=="undefined") {
      const last=Number(localStorage.getItem("jobhunt.gmail.lastSync")||0);
      if (Date.now()-last < 15*60*1000) return;
    }
    setState({busy:true,message:""});
    try {
      const res=await fetch("/api/gmail/sync",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({force:manual})}); const data=await res.json();
      if (data.status==="needs_reconnect") setState({busy:false,message:"Reconnect Google to restore Gmail read-only access."});
      else if (data.status==="not_due") setState({busy:false,message:`Next email review: ${data.nextReviewAt ? new Date(data.nextReviewAt).toLocaleString("en-GB") : "not scheduled"}.`});
      else if (data.status==="disabled") setState({busy:false,message:"Email monitoring is disabled in Settings."});
      else if (!res.ok) setState({busy:false,message:data.error||"Gmail sync failed."});
      else { localStorage.setItem("jobhunt.gmail.lastSync",String(Date.now())); setState({busy:false,message:`Synced ${data.scanned} messages · ${data.autoUpdated} pipeline update${data.autoUpdated===1?"":"s"}${data.needsUser?` · ${data.needsUser} need review`:""}${data.sheetSync?.status==="ok"?` · Sheet updated (${data.sheetSync.rows})`:""}.`}); setTimeout(()=>window.location.reload(),650); }
    } catch { setState({busy:false,message:"Gmail sync failed."}); }
  }
  useEffect(()=>{ if(auto) void sync(false); },[]);
  return <div className="gmailSync"><button className="secondaryButton" disabled={state.busy} onClick={()=>void sync(true)}>{state.busy?"Syncing Gmail…":"Sync Gmail"}</button>{state.message?<span className="syncMessage">{state.message}</span>:null}</div>;
}
