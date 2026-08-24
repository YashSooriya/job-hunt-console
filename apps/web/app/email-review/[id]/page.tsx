import { notFound } from "next/navigation";
import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { EmailReviewForm } from "@/components/email-review-form";
import { getEmailMonitoringDataset, getPreparationApplications, getTrackerDataset } from "@/lib/data/repository";

export default async function EmailReviewPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params; const [mail,tracker,preparing]=await Promise.all([getEmailMonitoringDataset(),getTrackerDataset(),getPreparationApplications()]);
  const email=mail.records.find(x=>x.id===id); if(!email) return notFound();
  const map=new Map<string,{id:string;label:string}>();
  for(const a of tracker.records) if(a.id) map.set(a.id,{id:a.id,label:`${a.company} · ${a.role}`});
  for(const a of preparing.records) map.set(a.id,{id:a.id,label:`${a.company} · ${a.role}`});
  return <AppShell><div className="pageHeader"><div><div className="eyebrow">Gmail review</div><h1 className="title">Resolve recruiting email</h1><p className="sub">Confirm the application and event only when the automatic match is uncertain.</p></div><DataSourceBadge source={mail.source}/></div>
    <section className="card"><div className="badges"><span className="badge action">{email.classification?.replaceAll("_"," ")||"uncertain"}</span>{email.matchConfidence!=null?<span className="badge">Match {Math.round(email.matchConfidence*100)}%</span>:null}{email.classificationSource === "chatgpt" ? <span className="badge review">ChatGPT classified</span> : null}</div><h2>{email.subject||"Recruiting email"}</h2><p>{email.sender||"Unknown sender"}</p><div className="notice">{email.snippet||"No preview available."}</div>{email.classificationReason?<p>{email.classificationReason}</p>:null}{email.matchReason?<small>{email.matchReason}</small>:null}</section>
    <section className="card"><div className="cardHeader"><div><h2>Human review</h2><p>{email.classificationSource === "chatgpt" ? "ChatGPT has already assigned the email category. Review or override it only when the match or category is wrong." : "ChatGPT assigns ordinary email categories automatically; use this page only when the category or application match remains uncertain."}</p></div></div><EmailReviewForm emailId={email.id} applications={[...map.values()]} initialApplicationId={email.applicationId} initialClassification={email.classification} classificationSource={email.classificationSource} live={mail.source==="supabase"}/></section>
  </AppShell>;
}
