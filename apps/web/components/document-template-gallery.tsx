"use client";

import { useState } from "react";
import { DOCUMENT_TEMPLATES, type DocumentTemplate } from "@/lib/document/templates";

function PreviewLines({count}:{count:number}) {
  return <>{Array.from({length:count},(_,index)=><div key={index} className={`templatePaperLine ${index%5===4?"medium":index%4===2?"":"long"}`} />)}</>;
}

function SampleDocument({theme,kind}:{theme:DocumentTemplate;kind:"CV"|"Cover letter"}) {
  const title=kind==="CV"?"Research Engineer, Computational Modelling":"Application for Senior Simulation Engineer";
  return <div className="templatePaper" style={{fontFamily:theme.font==="Georgia"?"Georgia,serif":"Arial,sans-serif",borderTopColor:theme.accent}}>
    <div className="templatePaperName" style={{color:theme.accent,fontSize:theme.nameSize}}>{kind==="CV"?"Alex Morgan":"Alex Morgan"}</div>
    <div className="templatePaperRole" style={{color:theme.accent}}>{title}</div>
    <div className="templatePaperContact">Manchester · alex@example.test · linkedin.com/in/alexmorgan</div>
    {kind==="CV"?<>
      <div className="templatePaperHeading" style={{color:theme.accent,borderColor:theme.accent}}>PROFILE</div>
      <PreviewLines count={3}/>
      <div className="templatePaperHeading" style={{color:theme.accent,borderColor:theme.accent}}>TECHNICAL SKILLS</div>
      <PreviewLines count={4}/>
      <div className="templatePaperHeading" style={{color:theme.accent,borderColor:theme.accent}}>EXPERIENCE</div>
      <strong>Research Engineer · Example Engineering</strong><PreviewLines count={4}/>
      <strong>Research Associate · Applied Research</strong><PreviewLines count={3}/>
      <div className="templatePaperHeading" style={{color:theme.accent,borderColor:theme.accent}}>SELECTED TECHNICAL WORK</div>
      <strong>Validated modelling project</strong><PreviewLines count={4}/>
      <div className="templatePaperHeading" style={{color:theme.accent,borderColor:theme.accent}}>EDUCATION</div>
      <strong>MEng, Mechanical Engineering</strong><PreviewLines count={2}/>
    </>:<>
      <strong>Dear Hiring Manager,</strong>
      <div style={{marginTop:8}}><PreviewLines count={4}/></div>
      <div style={{marginTop:8}}><PreviewLines count={4}/></div>
      <div style={{marginTop:8}}><PreviewLines count={4}/></div>
      <div style={{marginTop:8}}><PreviewLines count={4}/></div>
      <p>Yours sincerely,</p><p>Alex Morgan</p>
    </>}
  </div>;
}

export function DocumentTemplateGallery({defaultTemplateId}:{defaultTemplateId:string}) {
  const [selected,setSelected]=useState(defaultTemplateId);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [expanded,setExpanded]=useState<string|null>(null);
  async function saveDefault() {
    setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/documents/preferences",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({defaultTemplateId:selected})});
      const data=await response.json().catch(()=>null);
      if(!response.ok||!data?.ok)throw new Error(data?.error||"Could not save the default theme.");
      setMessage("Default theme saved. It will be used for future requests.");
    } catch(error) {setMessage(error instanceof Error?error.message:"Could not save the default theme.");}
    finally {setBusy(false);}
  }
  return <>
    <div className="documentTemplateGrid">
      {DOCUMENT_TEMPLATES.map(theme=><article className={`documentTemplateCard ${selected===theme.id?"selected":""}`} key={theme.id}>
        <button className="documentTemplateSelect" type="button" onClick={()=>setSelected(theme.id)} aria-pressed={selected===theme.id}>
          <span className="documentTemplatePreviews"><SampleDocument theme={theme} kind="CV"/><SampleDocument theme={theme} kind="Cover letter"/></span>
          <span className="documentTemplateDetails"><span className="documentTemplateTitle">{theme.name}</span><span>{theme.description}</span><span className="documentTemplateSpecs">{theme.font} · {theme.bodySize} pt body · A4</span></span>
        </button>
        <button className="textLink" type="button" onClick={()=>setExpanded(theme.id)}>View larger preview</button>
      </article>)}
    </div>
    <div className="documentTemplateFooter"><p>{message||"Choose a paired CV and cover-letter design. The same theme will be used for both documents."}</p><button className="primaryButton" type="button" disabled={busy} onClick={()=>void saveDefault()}>{busy?"Saving…":"Set as default"}</button></div>
    {expanded?(()=>{const theme=DOCUMENT_TEMPLATES.find(item=>item.id===expanded)!;return <div className="templatePreviewOverlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setExpanded(null);}}><section className="templatePreviewDialog" role="dialog" aria-modal="true" aria-label={`${theme.name} document previews`}><div className="templatePreviewDialogHead"><div><h2>{theme.name}</h2><p>{theme.description}</p></div><button className="secondaryButton" type="button" onClick={()=>setExpanded(null)}>Close</button></div><div className="templatePreviewLarge"><SampleDocument theme={theme} kind="CV"/><SampleDocument theme={theme} kind="Cover letter"/></div></section></div>;})():null}
  </>;
}
