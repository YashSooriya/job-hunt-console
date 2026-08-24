function clean(line:string){return line.replace(/\s+/g,' ').trim()}
const sectionAliases:Record<string,string>={experience:'experience',employment:'experience','work experience':'experience',education:'education',skills:'skills','technical skills':'skills',projects:'projects','selected projects':'projects',publications:'publications','conference presentations':'publications','research posters':'publications'};
export type ExtractedProposal={category:'employment'|'education'|'skill'|'project'|'publication'|'evidence';claim:string;detail:string|null;tags:string[];locator:string;proposalKey:string};
export function extractCvProposals(raw:string){
  const lines=raw.split(/\r?\n/).map(clean).filter(Boolean); let section='general'; const proposals:ExtractedProposal[]=[]; const seen=new Set<string>();
  for(let i=0;i<lines.length;i++){
    const line=lines[i]; const key=line.toLowerCase().replace(/[:\s]+$/,''); if(sectionAliases[key]){section=sectionAliases[key];continue}
    if(line.length<12||line.length>700) continue; if(/^(profile|summary|additional information|interests)$/i.test(line)) continue;
    const claim=line.replace(/^[•●▪◦*-]\s*/, '').trim(); if(claim.length<12||seen.has(claim.toLowerCase()))continue; seen.add(claim.toLowerCase());
    const category=section==='experience'?'employment':section==='education'?'education':section==='skills'?'skill':section==='projects'?'project':section==='publications'?'publication':'evidence';
    proposals.push({category,claim,detail:null,tags:[category],locator:`line:${i+1}`,proposalKey:`${category}_${String(proposals.length+1).padStart(3,'0')}`});
  }
  return proposals.slice(0,120);
}
export function extractSimpleFacts(raw:string){
  const facts:Array<{key:string;value:string}>=[]; const email=raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]; if(email)facts.push({key:'email',value:email.toLowerCase()});
  const phone=raw.match(/(?:\+44|0)\s?\d(?:[\s-]?\d){8,11}/)?.[0]; if(phone)facts.push({key:'phone',value:phone}); return facts;
}
