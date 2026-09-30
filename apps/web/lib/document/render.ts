import { BorderStyle, Document, HeadingLevel, Packer, Paragraph, TextRun, type IParagraphOptions } from "docx";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getDocumentTemplate, type DocumentTemplate } from "./templates.ts";

type Content = Record<string, any>;
const MM_TO_PT=72/25.4;
const PAGE_W=595.28, PAGE_H=841.89;

function ascii(value: unknown) {
  return String(value??"")
    .replace(/[–—−]/g,"-").replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
    .replace(/[•▪]/g,"-").replace(/→/g,"to").replace(/≤/g,"<=").replace(/≥/g,">=")
    .replace(/μ/g,"micro").replace(/×/g,"x").replace(/…/g,"...")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^\x20-\x7e\n\t]/g," ");
}

function hexColor(hex:string) {
  const value=hex.replace("#","");
  return rgb(parseInt(value.slice(0,2),16)/255,parseInt(value.slice(2,4),16)/255,parseInt(value.slice(4,6),16)/255);
}

function wrap(text:string,font:PDFFont,size:number,maxWidth:number) {
  const words=ascii(text).trim().split(/\s+/).filter(Boolean),lines:string[]=[];
  let line="";
  for(const word of words) {
    const next=line?`${line} ${word}`:word;
    if(line&&font.widthOfTextAtSize(next,size)>maxWidth){lines.push(line);line=word;}else line=next;
  }
  if(line)lines.push(line);
  return lines;
}

function addPdfText(page:PDFPage,font:PDFFont,text:string,x:number,y:number,size:number,color=rgb(0.12,0.14,0.18)) {
  page.drawText(ascii(text),{x,y,size,font,color,maxWidth:PAGE_W-x-24});
}

async function makePdfWriter(pdf:PDFDocument,template:DocumentTemplate,maxPages:number) {
  const font=await pdf.embedFont(template.font==="Georgia"?StandardFonts.TimesRoman:StandardFonts.Helvetica);
  const bold=await pdf.embedFont(template.font==="Georgia"?StandardFonts.TimesRomanBold:StandardFonts.HelveticaBold);
  const accent=hexColor(template.accent);
  const left=template.marginMm*MM_TO_PT,right=PAGE_W-left;
  let page=pdf.addPage([PAGE_W,PAGE_H]),pageNumber=1,y=PAGE_H-left;
  const pageBottoms=[PAGE_H-left];
  const recordBottom=(bottom:number)=>{pageBottoms[pageNumber-1]=Math.min(pageBottoms[pageNumber-1]??PAGE_H-left,bottom);};
  const ensure=(space:number)=>{
    if(y-space>=left)return;
    if(pageNumber>=maxPages)throw new Error(`The selected ${maxPages===2?"CV":"cover letter"} theme is too full. Shorten or prioritise content before creating the PDF.`);
    page=pdf.addPage([PAGE_W,PAGE_H]);pageNumber++;pageBottoms.push(PAGE_H-left);y=PAGE_H-left;
  };
  const lines=(text:string,size=template.bodySize,indent=0,color=rgb(0.12,0.14,0.18),strong=false,gap=3.2)=>{
    const typeface=strong?bold:font,maxWidth=right-left-indent;
    for(const line of wrap(text,typeface,size,maxWidth)){
      ensure(size+gap);page.drawText(line,{x:left+indent,y:y-size,size,font:typeface,color});recordBottom(y-size);y-=size+gap;
    }
  };
  const heading=(text:string)=>{
    // Keep a section title with at least its first content line; otherwise a
    // page break can strand a heading at the foot of an otherwise full page.
    ensure(template.headingSize+template.bodySize+22);y-=7;
    page.drawText(ascii(text.toUpperCase()),{x:left,y:y-template.headingSize,size:template.headingSize,font:bold,color:accent});recordBottom(y-template.headingSize);
    y-=template.headingSize+4;
    if(template.id!=="clean-charcoal"&&template.id!=="minimal-black")page.drawLine({start:{x:left,y:y+1},end:{x:right,y:y+1},thickness:0.6,color:accent});
  };
  return {font,bold,accent,left,right,get page(){return page;},get pageNumber(){return pageNumber;},get y(){return y;},set y(v:number){y=v;},get pageUsage(){const available=PAGE_H-2*left;return pageBottoms.map(bottom=>Math.max(0,Math.min(1,((PAGE_H-left)-bottom)/available)));},recordBottom,lines,heading,ensure};
}

async function cvPdf(pdf:PDFDocument,content:Content,template:DocumentTemplate) {
  const w=await makePdfWriter(pdf,template,2);
  w.ensure(template.nameSize+30);
  const candidate=content.candidate||{};
  const name=ascii(candidate.name||content.contact?.name||"");
  w.page.drawText(name,{x:w.left,y:w.y-template.nameSize,size:template.nameSize,font:w.bold,color:w.accent});
  w.recordBottom(w.y-template.nameSize);
  w.y-=template.nameSize+2;
  w.lines(content.headline||"",11,0,w.accent,true,3);
  const contact=[candidate.email,candidate.phone,candidate.location,candidate.linkedin].filter(Boolean).join("  |  ");
  if(contact)w.lines(contact,9,0,rgb(0.25,0.28,0.32),false,3);
  w.heading("Profile");
  w.lines(content.profile_summary?.text||content.profile?.text||"",template.bodySize,0,rgb(0.14,0.15,0.18),false,3.4);
  for(const section of content.sections||[]) {
    const entries=section.entries||[];
    const textHeight=(value:string,size:number,indent=0,strong=false,gap=2.7)=>
      wrap(value,strong?w.bold:w.font,size,w.right-w.left-indent).length*(size+gap);
    const entryHeight=(entry:Content)=>{
      const title=[entry.heading,entry.date].filter(Boolean).join("  |  ");
      const sub=[entry.subheading,entry.location].filter(Boolean).join("  |  ");
      return (title?textHeight(title,template.bodySize,0,true,2.5):0)
        +(sub?textHeight(sub,9.5,0,false,2.5):0)
        +(entry.bullets||[]).reduce((total:number,bullet:Content|string)=>total+textHeight("• "+(typeof bullet==="string"?bullet:bullet.text),template.bodySize,9,false,2.7),0)+3;
    };
    // Move a section title and its first complete entry together when possible.
    w.ensure(template.headingSize+template.bodySize+22+(entries[0]?entryHeight(entries[0]):0));
    w.heading(section.heading||section.section_key||"Experience");
    for(const entry of entries) {
      // Keep each role/project/qualification intact when it fits on one page.
      w.ensure(entryHeight(entry));
      const title=[entry.heading,entry.date].filter(Boolean).join("  |  ");
      if(title)w.lines(title,template.bodySize,0,rgb(0.12,0.14,0.18),true,2.5);
      const sub=[entry.subheading,entry.location].filter(Boolean).join("  |  ");
      if(sub)w.lines(sub,9.5,0,rgb(0.32,0.34,0.38),false,2.5);
      for(const bullet of entry.bullets||[]) {
        const bulletText=typeof bullet==="string"?bullet:bullet.text;
        w.lines(`• ${bulletText}`,template.bodySize,9,rgb(0.14,0.15,0.18),false,2.7);
      }
      w.y-=3;
    }
  }
  if(w.pageNumber!==2)throw new Error("The CV content did not fill the required two A4 pages. Add relevant evidence or adjust the content before rendering.");
  if(w.pageUsage[1]<0.4)throw new Error("The CV's second page is too empty. Rebalance the strongest verified experience and project evidence across both pages before creating the PDF.");
  return {pageCount:w.pageNumber,pageUsage:w.pageUsage,wordCount:JSON.stringify(content).split(/\s+/).length};
}

async function letterPdf(pdf:PDFDocument,content:Content,template:DocumentTemplate) {
  const w=await makePdfWriter(pdf,template,1);
  w.ensure(template.nameSize+22);
  w.page.drawText(ascii(content.candidate_name||""),{x:w.left,y:w.y-template.nameSize,size:template.nameSize,font:w.bold,color:w.accent});
  w.recordBottom(w.y-template.nameSize);
  w.y-=template.nameSize+4;
  const contact=[content.candidate_email,content.candidate_phone,content.candidate_location].filter(Boolean).join("  |  ");
  if(contact)w.lines(contact,9,0,rgb(0.25,0.28,0.32),false,3);
  w.y-=8;
  if(content.company)w.lines(content.company,template.bodySize,0,rgb(0.12,0.14,0.18),true,3);
  if(content.job_title)w.lines(content.job_title,template.bodySize,0,rgb(0.25,0.28,0.32),false,3);
  w.y-=7;
  if(content.salutation)w.lines(content.salutation,template.bodySize,0,rgb(0.14,0.15,0.18),false,7);
  for(const paragraph of content.paragraphs||[])w.lines(paragraph.text,template.bodySize,0,rgb(0.14,0.15,0.18),false,7);
  if(content.closing)w.lines(content.closing,template.bodySize,0,rgb(0.14,0.15,0.18),false,9);
  if(content.candidate_name)w.lines(content.candidate_name,template.bodySize,0,rgb(0.14,0.15,0.18),false,4);
  return {pageCount:w.pageNumber,wordCount:(content.plaintext||"").split(/\s+/).filter(Boolean).length};
}

function headingPara(value:string,template:DocumentTemplate) {
  const p: IParagraphOptions={heading:HeadingLevel.HEADING_2,spacing:{before:200,after:70},keepNext:true,
    ...(template.id==="clean-charcoal"||template.id==="minimal-black"?{}:{border:{bottom:{style:BorderStyle.SINGLE,size:4,color:template.accent.slice(1)}}})};
  return new Paragraph({...p,children:[new TextRun({text:value.toUpperCase(),bold:true,color:template.accent.slice(1),font:template.font,size:template.headingSize*2})]});
}

function cvDocx(content:Content,template:DocumentTemplate) {
  const children:Paragraph[]=[];
  const candidate=content.candidate||{};
  children.push(new Paragraph({spacing:{after:30},children:[new TextRun({text:candidate.name||content.contact?.name||"",bold:true,size:template.nameSize*2,color:template.accent.slice(1),font:template.font})]}));
  if(content.headline)children.push(new Paragraph({spacing:{after:90},children:[new TextRun({text:content.headline,bold:true,size:22,color:template.accent.slice(1)})]}));
  const contact=[candidate.email,candidate.phone,candidate.location,candidate.linkedin].filter(Boolean).join("  |  ");
  if(contact)children.push(new Paragraph({spacing:{after:100},children:[new TextRun({text:contact,size:18,color:"444444"})]}));
  children.push(headingPara("Profile",template),new Paragraph({spacing:{after:80},children:[new TextRun({text:content.profile_summary?.text||content.profile?.text||"",size:template.bodySize*2,font:template.font})]}));
  for(const section of content.sections||[]) {
    children.push(headingPara(section.heading||section.section_key||"Experience",template));
    for(const entry of section.entries||[]) {
      const heading=[entry.heading,entry.date].filter(Boolean).join("\t");
      if(heading)children.push(new Paragraph({keepNext:true,spacing:{after:20},children:[new TextRun({text:heading,bold:true,size:template.bodySize*2})]}));
      if(entry.subheading||entry.location)children.push(new Paragraph({keepNext:true,spacing:{after:40},children:[new TextRun({text:[entry.subheading,entry.location].filter(Boolean).join("  |  "),italics:true,size:19,color:"444444"})]}));
      const bullets=entry.bullets||[];
      for(let index=0;index<bullets.length;index++) {
        const bullet=bullets[index];
        children.push(new Paragraph({keepNext:index<bullets.length-1,bullet:{level:0},spacing:{after:35},children:[new TextRun({text:typeof bullet==="string"?bullet:bullet.text,size:template.bodySize*2})]}));
      }
    }
  }
  return new Document({styles:{default:{document:{run:{font:template.font,size:template.bodySize*2}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:template.marginMm*56.7,bottom:template.marginMm*56.7,left:template.marginMm*56.7,right:template.marginMm*56.7}}},children}]});
}

function letterDocx(content:Content,template:DocumentTemplate) {
  const children:Paragraph[]=[];
  const font=template.font;
  children.push(new Paragraph({spacing:{after:80},children:[new TextRun({text:content.candidate_name||"",bold:true,size:template.nameSize*2,color:template.accent.slice(1),font})]}));
  const contact=[content.candidate_email,content.candidate_phone,content.candidate_location].filter(Boolean).join("  |  ");
  if(contact)children.push(new Paragraph({spacing:{after:280},children:[new TextRun({text:contact,size:18,color:"444444"})]}));
  if(content.company)children.push(new Paragraph({spacing:{after:30},children:[new TextRun({text:content.company,bold:true})]}));
  if(content.job_title)children.push(new Paragraph({spacing:{after:240},children:[new TextRun({text:content.job_title})]}));
  if(content.salutation)children.push(new Paragraph({spacing:{after:140},children:[new TextRun({text:content.salutation})]}));
  for(const paragraph of content.paragraphs||[])children.push(new Paragraph({spacing:{after:140,line:276},children:[new TextRun({text:paragraph.text})]}));
  if(content.closing)children.push(new Paragraph({spacing:{before:180,after:80},children:[new TextRun({text:content.closing})]}));
  if(content.candidate_name)children.push(new Paragraph({children:[new TextRun({text:content.candidate_name})]}));
  return new Document({styles:{default:{document:{run:{font,size:22}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:template.marginMm*56.7,bottom:template.marginMm*56.7,left:template.marginMm*56.7,right:template.marginMm*56.7}}},children}]});
}

export async function renderApplicationDocument(kind:"cv"|"cover_letter",content:Content,templateId:string) {
  const template=getDocumentTemplate(templateId);
  const pdf=await PDFDocument.create();
  pdf.setTitle(kind==="cv"?"Tailored CV":"Tailored Cover Letter");
  pdf.setSubject("JobHuntAI application document");
  pdf.setCreator("JobHuntAI");
  const quality=await (kind==="cv"?cvPdf(pdf,content,template):letterPdf(pdf,content,template));
  const pdfBytes=Buffer.from(await pdf.save({useObjectStreams:true}));
  const document=kind==="cv"?cvDocx(content,template):letterDocx(content,template);
  const docxBytes=Buffer.from(await Packer.toBuffer(document));
  const extracted=kind==="cover_letter"?(content.plaintext||""):JSON.stringify(content);
  if(!extracted.trim()||pdfBytes.length<500||docxBytes.length<1000)throw new Error("Document rendering produced an incomplete file.");
  return {pdf:pdfBytes,docx:docxBytes,quality:{...quality,pdfBytes:pdfBytes.length,docxBytes:docxBytes.length,templateId:template.id,renderer:"pdf-lib+docx",textSelectable:true}};
}
