import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { planAdaptivePage, isDangerousSubmissionLabel, isStartApplicationLabel } from "../packages/form-agent/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root,"data/acceptance/live-source-fixtures.json"),"utf8"));
const required = ["greenhouse","lever","workday","ashby","smartrecruiters","custom"];
assert.equal(corpus.cases.length, required.length);
for (const provider of required) assert(corpus.cases.some((c)=>c.providerFamily===provider), `Missing acceptance provider ${provider}`);
for (const c of corpus.cases) {
  assert(c.sourceUrl, `${c.id} missing source URL`);
  assert(c.fixture, `${c.id} missing fixture`);
  assert(fs.existsSync(path.join(root,"data/acceptance",c.fixture)), `${c.id} fixture missing`);
}

assert.equal(isDangerousSubmissionLabel("Apply"), false);
assert.equal(isStartApplicationLabel("Apply"), true);
assert.equal(isStartApplicationLabel("Apply Manually"), true);
assert.equal(isDangerousSubmissionLabel("Submit application"), true);

const ctx = {
  candidate:{firstName:"Test",lastName:"Candidate",email:"test@example.test"},
  answers:[{id:"red",questionKey:"work_auth",questionText:"Are you legally authorized to work in the country where the job is located?",answerText:"Yes",trust:"user_required",approved:true}],
};
let p = planAdaptivePage({url:"https://example.test",title:"Job",bodyText:"Job description",controls:[{fieldKey:"f1",label:"Apply",controlType:"button"}],flags:{}},ctx);
assert.equal(p.actions[0].action,"navigate");
assert.equal(p.submission_detected,false);

p = planAdaptivePage({url:"https://example.test/apply",title:"Application",bodyText:"Apply for this job",controls:[
  {fieldKey:"f1",label:"First Name*",controlType:"text",required:true,hasValue:false},
  {fieldKey:"f2",label:"Are you legally authorized to work in the country where the job is located?*",controlType:"select",required:true,hasValue:false,options:[{label:"Select...",value:""},{label:"Yes",value:"yes"},{label:"No",value:"no"}]},
  {fieldKey:"f3",label:"Submit application",controlType:"button"}
],flags:{}},ctx);
assert.equal(p.must_pause,false);
assert.equal(p.submission_detected,false);
assert.equal(p.actions[0].target_key,"f1");

const prodFiles = [
  "packages/form-agent/index.js",
  "apps/browser-agent/src/observe.mjs",
  "apps/browser-agent/src/execute.mjs",
  "apps/browser-agent/src/cli.mjs",
];
const providerPattern = /\b(workday|greenhouse|lever|ashby|smartrecruiters|successfactors)\b/i;
for (const f of prodFiles) {
  const text=fs.readFileSync(path.join(root,f),"utf8");
  assert.equal(providerPattern.test(text),false,`Provider-specific production logic leaked into ${f}`);
}

const liveFull = corpus.cases.filter((c)=>c.evidenceLevel==="live_form_labels").length;
console.log(`Acceptance corpus verified: ${corpus.cases.length} provider-diverse cases (${liveFull} with live form labels).`);
console.log("Production form-agent remains provider-independent.");
