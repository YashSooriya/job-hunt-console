const REJECTION = [
  /regret to inform/i, /not be progressing/i, /not been selected/i, /application has been unsuccessful/i,
  /will not be moving forward/i, /not moving forward/i, /not progressed/i, /unable to progress/i,
  /decided not to proceed/i, /other candidates/i,
];
const ASSESSMENT = [
  /online assessment/i, /complete (?:an|the|your) assessment/i, /assessment.*required/i,
  /psychometric/i, /situational judgement/i, /numerical reasoning/i, /verbal reasoning/i,
  /coding assessment/i, /technical assessment/i,
];
const INTERVIEW = [
  /invite(?:d)? (?:you )?to (?:an )?interview/i, /interview invitation/i, /schedule (?:an|your) interview/i,
  /interview with/i, /interview slot/i, /book.*interview/i,
];
const OFFER = [
  /pleased to offer/i, /offer of employment/i, /job offer/i, /formal offer/i, /offer letter/i,
];
const CONFIRMATION = [
  /application has been received/i, /application (?:was|has been) successfully submitted/i,
  /thank you for (?:submitting|your) application/i, /thank you for applying/i,
  /received your application/i, /acknowledg(?:e|ing).*application/i,
];
const SURVEY_OR_MARKETING = [
  /application experience/i, /what made you apply/i, /recommend applying/i, /survey/i,
  /latest jobs/i, /is hiring/i, /job alert/i, /explore.*jobs/i, /new opportunities/i,
  /welcome to .*job/i,
];
const RECRUITER = [
  /could we (?:speak|chat|talk)/i, /availability for (?:a )?(?:call|chat)/i,
  /would like to discuss/i, /can we arrange/i, /hiring manager would like/i, /recruiter/i,
];

function clean(v = "") { return String(v || "").replace(/\s+/g, " ").trim(); }
function corpus(email) { return clean([email.subject, email.snippet, email.body].filter(Boolean).join("\n")); }
function senderDomain(sender = "") {
  const match = String(sender).match(/@([A-Za-z0-9.-]+)/);
  return match ? match[1].toLowerCase() : "";
}
function normalizeTokens(value = "") {
  const stop = new Set(["the","and","for","with","engineer","engineering","developer","specialist","analyst","senior","junior","graduate","team","group","limited","ltd","plc","role","position","job","application"]);
  return clean(value).toLowerCase().replace(/[^a-z0-9+.# ]/g," ").split(/\s+/).filter(t => t.length >= 3 && !stop.has(t));
}
function overlap(a,b) {
  const A = new Set(normalizeTokens(a)), B = new Set(normalizeTokens(b));
  if (!A.size || !B.size) return 0;
  let n=0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(1, Math.min(A.size,B.size));
}
function firstMatch(patterns, text) { return patterns.find(p => p.test(text)) || null; }
function externalJobId(text) {
  const patterns = [/(JR\d{5,})/i, /(?:job|role|requisition|req|reference|ref|id)\s*[:#-]?\s*([A-Z]{0,4}\d{4,})/i, /\((\d{4,})\)/];
  for (const p of patterns) { const m=text.match(p); if (m) return m[1].toUpperCase(); }
  return null;
}
function relativeDeadline(email, text) {
  if (!email.receivedAt) return null;
  const m = text.match(/within\s+(\d{1,2})\s+days?\s+of\s+receiving/i);
  if (!m) return null;
  const d = new Date(email.receivedAt); if (Number.isNaN(d.valueOf())) return null;
  d.setUTCDate(d.getUTCDate()+Number(m[1])); return d.toISOString();
}
function roleHint(subject="") {
  let s=clean(subject).replace(/^urgent\s*[–—:-]\s*/i,"");
  s=s.replace(/^(?:thank you for applying to|your application (?:for|to)|application confirmation[: -]*)/i,"");
  const forMatch=s.match(/(?:for|to)\s+(.+?)(?:\s+with\s+|\s+at\s+|$)/i);
  if (forMatch && forMatch[1].length>4) return clean(forMatch[1]);
  const dash=s.split(/\s[-–—]\s/)[0];
  return dash && dash.length>4 && dash.length<120 ? dash : null;
}
function companyHint(email) {
  const sender=clean(email.sender||"").replace(/<[^>]+>/g,"").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g,"").trim();
  if (sender && !/^(no-?reply|careers?|talent acquisition team|recruitment team|system)$/i.test(sender)) return sender.replace(/\b(careers|workday|recruiting team|hiring team)\b/ig,"").trim() || null;
  return null;
}

export function classifyRecruitingEmail(email) {
  const text=corpus(email), subject=clean(email.subject||"");
  const extracted={ externalJobId: externalJobId(text), roleHint: roleHint(subject), companyHint: companyHint(email), deadlineAt: null, providerHint: senderDomain(email.sender||"") || null };
  if (firstMatch(SURVEY_OR_MARKETING,text)) return { classification:"other", confidence:0.98, reason:"Applicant survey, job alert, or recruiting marketing rather than an application-status event.", extracted };
  if (firstMatch(REJECTION,text)) return { classification:"rejection", confidence:0.99, reason:"Explicit rejection/non-progression language detected.", extracted };
  if (firstMatch(OFFER,text)) return { classification:"offer", confidence:0.98, reason:"Explicit employment-offer language detected.", extracted };
  if (firstMatch(INTERVIEW,text)) return { classification:"interview", confidence:0.97, reason:"Explicit interview invitation or scheduling language detected.", extracted };
  if (firstMatch(ASSESSMENT,text)) { extracted.deadlineAt=relativeDeadline(email,text); return { classification:"assessment", confidence:0.98, reason:"Explicit assessment requirement/invitation language detected.", extracted }; }
  if (firstMatch(CONFIRMATION,text)) return { classification:"confirmation", confidence:0.96, reason:"Application receipt/submission acknowledgement detected.", extracted };
  if (firstMatch(RECRUITER,text) || (/^[^@]+@[A-Za-z0-9.-]+/.test(clean(email.sender||"")) && /application|role|position|opportunity/i.test(text))) return { classification:"recruiter_message", confidence:0.72, reason:"Recruiting-related message that is not a deterministic status event.", extracted };
  if (/application|candidate|recruit|hiring|career/i.test(text)) return { classification:"uncertain", confidence:0.58, reason:"Recruiting context detected but no reliable status pattern matched.", extracted };
  return { classification:"other", confidence:0.95, reason:"No recruiting status signal detected.", extracted };
}

function idScore(extractedId, candidateId) {
  if (!extractedId || !candidateId) return 0;
  const a=String(extractedId).toUpperCase().replace(/[^A-Z0-9]/g,"");
  const b=String(candidateId).toUpperCase().replace(/[^A-Z0-9]/g,"");
  return a===b ? 0.62 : (a.includes(b)||b.includes(a) ? 0.46 : 0);
}
function companyScore(email, app) {
  const text=corpus(email).toLowerCase(), company=clean(app.company||"").toLowerCase();
  if (!company) return 0;
  if (company.length>=4 && text.includes(company)) return 0.35;
  const ov=overlap(`${email.sender||""} ${email.subject||""}`,company);
  return Math.min(0.28, ov*0.28);
}
function roleScore(email, app) {
  const text=corpus(email), role=clean(app.role||"");
  if (!role) return 0;
  if (text.toLowerCase().includes(role.toLowerCase())) return 0.52;
  return Math.min(0.46, overlap(`${email.subject||""} ${email.snippet||""}`,role)*0.46);
}
function timeScore(email, app) {
  if (!email.receivedAt || !app.appliedAt) return 0;
  const a=new Date(email.receivedAt), b=new Date(app.appliedAt); if (Number.isNaN(a.valueOf())||Number.isNaN(b.valueOf())) return 0;
  const days=Math.abs(a.valueOf()-b.valueOf())/86400000;
  return days<=2?0.08:days<=14?0.05:days<=45?0.02:0;
}
export function matchEmailToApplication(email, classification, applications) {
  const scored=(applications||[]).map(app=>{
    const id=idScore(classification.extracted.externalJobId,app.externalJobId);
    const role=roleScore(email,app), company=companyScore(email,app), time=timeScore(email,app);
    const confidence=Math.min(1, id+role+company+time);
    const parts=[]; if(id) parts.push("job/reference ID"); if(role) parts.push("role/title"); if(company) parts.push("company/sender"); if(time) parts.push("application timing");
    return {applicationId:app.id,confidence:Number(confidence.toFixed(3)),reason:parts.length?`Matched by ${parts.join(", ")}.`:"No meaningful identifier overlap."};
  }).sort((a,b)=>b.confidence-a.confidence);
  const top=scored[0], second=scored[1];
  if (!top || top.confidence<0.55) return {applicationId:null,confidence:top?.confidence||0,reason:"No application candidate reached the minimum match threshold.",method:"unmatched",alternatives:scored.slice(0,3)};
  if (second && top.confidence-second.confidence<0.12 && top.confidence<0.9) return {applicationId:null,confidence:top.confidence,reason:"Two application candidates are too close to link automatically.",method:"ambiguous",alternatives:scored.slice(0,3)};
  const method=classification.extracted.externalJobId && top.reason.includes("reference ID") ? "reference_id" : top.reason.includes("role/title") && top.reason.includes("company") ? "role_company" : "fuzzy";
  return {applicationId:top.applicationId,confidence:top.confidence,reason:top.reason,method,alternatives:scored.slice(0,3)};
}
export function emailRequiresUser(classification, match) {
  if (["offer","recruiter_message","uncertain"].includes(classification.classification)) return true;
  if (classification.classification==="other") return false;
  if (!match.applicationId) return true;
  const classFloor=classification.classification==="confirmation"?0.9:0.94;
  const matchFloor=classification.classification==="confirmation"?0.78:0.86;
  return classification.confidence<classFloor || match.confidence<matchFloor;
}
