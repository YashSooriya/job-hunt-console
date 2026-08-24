import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildSalaryContext,
  buildScreeningPackage,
  collectCoverLetterEvidenceLinks,
  generateCoverLetter,
  renderCoverLetterLatex,
} from '../packages/application-content/index.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const knowledge = JSON.parse(fs.readFileSync(path.join(root,'data/knowledge/knowledge-base.generated.json'),'utf8'));
const profile = {
  displayName: knowledge.profile.display_name,
  facts: knowledge.profile.facts.map(f => ({ factKey:f.fact_key, value:f.value, status:f.status })),
  evidence: knowledge.evidence.map(e => ({ id:e.evidence_key, evidenceKey:e.evidence_key, category:e.category, claim:e.claim, detail:e.detail, tags:e.tags, strength:e.strength, status:e.status })),
};
const evidenceIds = profile.evidence.slice(0,8).map(e => e.evidenceKey);
const application = { id:'app-m6-test', strategyText:'Emphasise coupled simulation, verified scientific software development and industrial collaboration.', evidenceIds };
const baseAnalysis = { recommendedCvFamily:'simulation_cae', coverLetterValue:'high' };
const job = {
  title:'Simulation Engineer', company:'Example Engineering', location:'Bristol', salaryCurrency:'GBP', salaryText:null, salaryMin:null, salaryMax:null,
  requirements:[{text:'Strong numerical modelling and Python experience'}], analysis:baseAnalysis,
};
const salary = buildSalaryContext({job,analysis:baseAnalysis});
assert.equal(salary.source,'estimated');
assert.ok(salary.estimated_low < salary.estimated_high);
assert.ok(salary.recommended_value >= salary.estimated_low && salary.recommended_value <= salary.estimated_high);
assert.equal(salary.trust,'proposed');

const advertised = buildSalaryContext({job:{...job,salaryText:'£50,000 - £60,000',salaryMin:50000,salaryMax:60000},analysis:baseAnalysis});
assert.equal(advertised.source,'advertised');
assert.equal(advertised.recommended_value,55000);

const letter = generateCoverLetter({application,job,evidence:profile.evidence,candidateName:profile.displayName});
assert.equal(letter.decision,'prepare');
assert.deepEqual(letter.structured.unsupported_claims,[]);
const material = letter.structured.paragraphs.filter(p => p.material);
assert.ok(material.length >= 2 && material.every(p => p.evidence_ids.length > 0));
const links = collectCoverLetterEvidenceLinks(letter.structured);
assert.ok(links.length >= 4);
assert.equal(generateCoverLetter({application,job:{...job,analysis:{...baseAnalysis,coverLetterValue:'low'}},evidence:profile.evidence,candidateName:profile.displayName}).decision,'skip');

const screening = buildScreeningPackage({application,job,profile,salaryContext:salary});
const byKey = new Map(screening.answers.map(a => [a.question_key,a]));
assert.equal(byKey.get('highest_qualification').trust,'verified');
assert.equal(byKey.get('salary_expectation').trust,'proposed');
assert.equal(byKey.get('why_this_role').trust,'proposed');
assert.equal(byKey.get('notice_period').trust,'user_required');
assert.equal(byKey.get('notice_period').answer_text,null);
assert.equal(byKey.get('work_authorisation_uk').trust,'user_required');
assert.equal(byKey.get('work_authorisation_uk').answer_text,null);
assert.ok(screening.summary.red >= 2);
assert.ok(screening.summary.unresolved_required >= 2);

const clearance = buildScreeningPackage({application,job:{...job,requirements:[{text:'Current SC security clearance required'}]},profile,salaryContext:salary});
assert.equal(new Map(clearance.answers.map(a => [a.question_key,a])).get('security_clearance').trust,'user_required');

const latex = renderCoverLetterLatex(letter.structured);
assert.match(latex,/Dear Hiring Manager/);
assert.ok(!latex.includes('—'));
const out = '/mnt/data/job-hunt-milestone6-cover-letter-verification.pdf';
const tex = '/mnt/data/job-hunt-milestone6-cover-letter-verification.tex';
fs.writeFileSync(tex,latex);
try {
  execFileSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','-output-directory','/mnt/data',tex],{stdio:'pipe'});
  fs.renameSync('/mnt/data/job-hunt-milestone6-cover-letter-verification.pdf',out);
} finally {
  for (const ext of ['aux','log','tex']) { try { fs.unlinkSync(`/mnt/data/job-hunt-milestone6-cover-letter-verification.${ext}`); } catch {} }
}
console.log(JSON.stringify({salary,screening:screening.summary,coverLetterEvidenceLinks:links.length,pdf:out},null,2));
