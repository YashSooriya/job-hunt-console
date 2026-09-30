import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackground, buildCriteria, buildFitInput, employmentDays, semanticKey } from './input.ts';
import { calculateAssessment, parseAssessmentResponse, validateAssessmentResponse } from './assessment.ts';
import { buildAssessmentSteps, MAX_CONTEXT_PROMPT_CHARS, MAX_SAFE_FIT_PROMPT_CHARS } from './prompt.ts';
import { buildCriteriaPreparationSteps } from './prompt.ts';
import { finalizePreparedCriteria, validateCriterionGroupResponse, validateCriterionUnitResponse } from './criteria-preparation.ts';
import { evaluatePreferences, priorityAndRecommendation } from './priority.ts';
import { assessmentDispatchKey, isRequeuedUnsentDispatch, isSafeUnsentComposerMismatch, isSafeUnsentPreDeliveryV2Dispatch, processExactResponse, responseCheckEligibility, MAX_RESPONSE_CHECK_ATTEMPTS, RESPONSE_CHECK_COOLDOWN_MS } from './workflow.ts';
import { buildPersistencePayload } from './server.ts';
import { CALIBRATION_FIXTURES, validateRepeatedCalibration } from './calibration.ts';
import { CHATGPT_TESTING_MODE_PREFIX } from '../chatgpt/testing-mode.ts';
import { RESPONSE_VERSION, RUBRIC_VERSION } from './contract.ts';

const background = buildBackground({project:[{id:'p1',verification_status:'verified',title:'Structural simulation',details:'Developed Python finite element simulations and validated numerical models.'}],skill:[{id:'s1',verification_status:'verified',name:'Python'}],education:[{id:'ed1',verification_status:'verified',qualification:'PhD in Mechanical Engineering'}],fact:[{id:'f1',verification_status:'verified',fact_key:'work_authorisation',value_json:'Confirmed legal right to work in the United Kingdom.'}]});
const vacancy = {company:'Example',title:'Simulation Engineer',description:'Develop and validate computational models for structural engineering applications.',essential_requirements:['Required: Python finite element simulation expertise.'],responsibilities:['Develop computational models and validate simulation results.'],location:'London',work_mode:'hybrid',salary_min:50000,salary_max:60000,salary_currency:'GBP',salary_period:'annual',salary_source:'advertised',posted_at:'2026-09-29'};
function input(v=vacancy,b=background) {return buildFitInput({requestId:'req-1',jobId:'job-1',snapshotId:'snap-1',jobRevision:1,profileId:'profile-1',profileRevision:1,background:b,vacancy:v});}
function response(i, match='direct',reference='project:p1',quote='Developed Python finite element simulations') {return {schema_version:RESPONSE_VERSION,assessment_request_id:i.assessment_request_id,job_id:i.job_id,profile_snapshot_hash:i.profile_snapshot_hash,vacancy_snapshot_hash:i.vacancy_snapshot_hash,rubric_version:RUBRIC_VERSION,criteria:i.criteria.map(c=>({requirement_reference:c.reference,match,evidence:['not_evidenced','not_assessable'].includes(match)?[]:[{reference,quote}],explanation:'The supplied verified record supports this criterion.'})),dimension_applicability:Object.fromEntries(['seniority','domain','qualification'].map(d=>[d,i.criteria.some(c=>c.dimension===d)?'applicable':'not_specified'])),eligibility_findings:[],summary:'Verified simulation background supports the advertised work.',limitations:[]};}

test('structured verified background works without evidence_items; private/unapproved facts are excluded',()=>{
 assert.equal(background.length,4);assert.ok(background.some(r=>r.record_type==='project'));
 assert.deepEqual(buildBackground({fact:[{id:'x',fact_key:'email',value_json:'private@example.com',verification_status:'verified'}],skill:[{id:'y',name:'Invented',verification_status:'needs_review'}]}),[]);
 assert.throws(()=>input(vacancy,[]),/professional background/);
});
test('requirements are not lost to 360-character or first-16 caps; alternatives remain one criterion',()=>{
 const requirements=Array.from({length:25},(_,n)=>`Required criterion ${n} ${'complete source text '.repeat(25)}`);
 const criteria=buildCriteria({...vacancy,essential_requirements:[...requirements,'PhD or equivalent experience.']},'s');
 assert.equal(criteria.filter(c=>c.source_field==='essential_requirements').length,26);
 assert.equal(criteria.filter(c=>c.text==='PhD or equivalent experience.').length,1);
});
test('description requirements remain available when structured requirement arrays are populated',()=>{
 const fullDescription='Responsibilities include reliable solver development.\n\nA doctorate or equivalent research experience is required.\n\nApplicants must already hold UK work authorisation.';
 const criteria=buildCriteria({...vacancy,description:fullDescription,essential_requirements:['Python simulation experience.'],responsibilities:['Develop solver models.']},'snapshot');
 assert.ok(criteria.some(c=>c.source_field==='description'&&c.text==='A doctorate or equivalent research experience is required.'));
 assert.ok(criteria.some(c=>c.source_field==='description'&&c.text==='Applicants must already hold UK work authorisation.'));
});
test('criterion preparation is source-complete, dimension-aware and rejects paraphrase or discarded structured requirements',()=>{
 const i=input();
 const steps=buildCriteriaPreparationSteps(i,true);
 assert.ok(steps.length<i.criteria_source_units.length,'bounded grouping reduces ChatGPT exchanges');
 assert.ok(steps.every(s=>s.phase==='criteria'&&s.text.startsWith(CHATGPT_TESTING_MODE_PREFIX)&&s.text.length<=MAX_SAFE_FIT_PROMPT_CHARS));
 const prepared=steps.flatMap(step=>{
  const units=step.source_unit_references.map(reference=>i.criteria_source_units.find(unit=>unit.reference===reference));
  const results=units.map(unit=>({source_unit_reference:unit.reference,disposition:'criteria',criteria:[{text:unit.text,dimension:unit.source_field==='responsibilities'?'role_type':unit.source_field==='description'?'role_type':'technical',importance:unit.importance}],reason:'This saved source states a job-relevant capability or scope.'}));
  return validateCriterionGroupResponse({schema_version:'job-fit-criteria-group-v3.2',assessment_request_id:i.assessment_request_id,job_id:i.job_id,vacancy_snapshot_hash:i.vacancy_snapshot_hash,group_id:step.group_id,source_unit_references:step.source_unit_references,results},i,step.group_id,units);
 });
 assert.equal(prepared.length,i.criteria_source_units.length,'every source unit receives exactly one validated result');
 const criteria=finalizePreparedCriteria(i,prepared);
 assert.equal(criteria.length,i.criteria_source_units.length);
 assert.ok(criteria.every(c=>i.criteria_source_units.some(unit=>unit.text.includes(c.text))));
 const structured=i.criteria_source_units.find(u=>u.source_field==='essential_requirements');
 const bad={schema_version:'job-fit-criteria-unit-v3.1',assessment_request_id:i.assessment_request_id,job_id:i.job_id,vacancy_snapshot_hash:i.vacancy_snapshot_hash,source_unit_reference:structured.reference,disposition:'criteria',criteria:[{text:'Excellent Python experience',dimension:'technical',importance:'essential'}],duplicate_of_source_unit_reference:null,reason:'Paraphrased'};
 assert.throws(()=>validateCriterionUnitResponse(bad,i,structured),/exact non-empty text span/);
 assert.throws(()=>validateCriterionUnitResponse({...bad,disposition:'non_requirement',criteria:[],duplicate_of_source_unit_reference:null},i,structured),/cannot be discarded/);
 const grouped=steps[0],groupUnits=grouped.source_unit_references.map(reference=>i.criteria_source_units.find(unit=>unit.reference===reference));
 const groupResponse={schema_version:'job-fit-criteria-group-v3.2',assessment_request_id:i.assessment_request_id,job_id:i.job_id,vacancy_snapshot_hash:i.vacancy_snapshot_hash,group_id:grouped.group_id,source_unit_references:grouped.source_unit_references,results:groupUnits.map(unit=>({source_unit_reference:unit.reference,disposition:'non_requirement',criteria:[],reason:'No role criterion appears in this source.'}))};
 assert.throws(()=>validateCriterionGroupResponse(groupResponse,i,grouped.group_id,groupUnits),/cannot be discarded/,'a grouped model response cannot discard a structured requirement');
 assert.throws(()=>validateCriterionGroupResponse({...groupResponse,source_unit_references:grouped.source_unit_references.slice(1)},i,grouped.group_id,groupUnits),/cover its exact saved source units/);
});
test('semantic hash ignores preferences and non-semantic salary, place and dates but detects fit-content changes',()=>{
 const a=input(),b=input(vacancy,[...background].reverse());assert.equal(semanticKey('user',a),semanticKey('user',b));
 assert.notEqual(semanticKey('other',a),semanticKey('user',a));
 assert.equal(semanticKey('user',a,{locations:['London']}),semanticKey('user',a,{locations:['Bristol']}));
 assert.equal(semanticKey('user',a),semanticKey('user',input({...vacancy,location:'Edinburgh',salary_min:70000,posted_at:'2026-09-01'})));
 assert.notEqual(semanticKey('user',a),semanticKey('user',input({...vacancy,title:'Different role'})));
 assert.notEqual(semanticKey('user',a),semanticKey('user',input({...vacancy,description:vacancy.description+' Additional technical scope.'})));
});
test('all categories have exact fixed values and no constant defaults',()=>{
 for(const [match,expected] of Object.entries({direct:100,strong_transfer:75,partial:50,weak_transfer:25,not_evidenced:0,conflict:0})){
  const i=input(),result=calculateAssessment(i,response(i,match));assert.equal(result.fit_score,expected);assert.equal(result.components.seniority.score,null);assert.equal(result.components.qualification.state,'not_specified');
 }
});
test('essential weighted average divides by sum of weights',()=>{
 const i=input({...vacancy,essential_requirements:['Required Python simulation capability.'],desirable_requirements:['Desirable CFD modelling capability.']});
 const r=response(i);r.criteria.find(f=>f.requirement_reference===i.criteria.find(c=>c.importance==='desirable').reference).match='partial';
 const fit=calculateAssessment(i,r);assert.equal(fit.components.technical.score,87.5);
});
test('bare skill declarations contribute half substantive-record evidence support',()=>{
 const i=input(),fit=calculateAssessment(i,response(i,'direct','skill:s1','Python'));
 assert.equal(fit.components.technical.score,100);assert.equal(fit.components.evidence.score,50);assert.equal(fit.fit_score,83.3);
});
test('unassessable inputs yield partial and no final score, while missing evidence is honestly zero',()=>{
 const i=input();assert.equal(calculateAssessment(i,response(i,'not_assessable')).fit_score,null);
 assert.equal(calculateAssessment(i,response(i,'not_evidenced')).fit_score,0);
});
test('missing technical criteria can never be hidden by normalising the remaining weights',()=>{
 const full=input();
 const roleOnly={...full,criteria:full.criteria.filter(c=>c.dimension==='role_type')};
 const fit=calculateAssessment(roleOnly,response(roleOnly));
 assert.equal(fit.components.technical.state,'not_specified');
 assert.equal(fit.components.role_type.state,'assessed');
 assert.equal(fit.completeness,'partial');
 assert.equal(fit.fit_score,null);
});
test('incomplete evidence persists without fabricated zero scores or false rejection triage',()=>{
 const i=input(),fit=calculateAssessment(i,response(i,'not_assessable'));
 const saved=buildPersistencePayload(i,fit,preferences,new Date('2026-09-30'));
 assert.equal(saved.analysis.fit_score,null);assert.equal(saved.analysis.priority_score,null);
 assert.equal(saved.analysis.triage,'maybe');assert.equal(saved.analysis.triage_reason,'Needs information');
});
test('calibration scenarios are explicit and repeated score drift above five points is rejected',()=>{
 assert.equal(CALIBRATION_FIXTURES.length,12);
 assert.deepEqual(validateRepeatedCalibration([78,81,83]),{spread:5,passed:true});
 assert.throws(()=>validateRepeatedCalibration([78,84,81]),/varied by 6 points/);
});
test('strict validation rejects wrong job/hashes, missing or duplicate criteria, extra scores and fabricated quotes',()=>{
 const i=input();for(const change of [r=>r.job_id='other',r=>r.profile_snapshot_hash='bad',r=>r.criteria.pop(),r=>r.criteria[1]=r.criteria[0],r=>r.fit_score=99,r=>r.criteria[0].evidence[0].quote='Made-up qualification',r=>r.criteria[0].evidence[0].reference='project:another-user']){const r=response(i);change(r);assert.throws(()=>validateAssessmentResponse(r,i));}
});
test('JSON parsing accepts one fenced object, rejects commentary, multiple objects, arrays and malformed JSON',()=>{
 assert.deepEqual(parseAssessmentResponse('```json\n{"a":1}\n```'),{a:1});
 for(const raw of ['Here is the result: {"a":1}','{"a":1}{"b":2}','[]','{"a":1,}'])assert.throws(()=>parseAssessmentResponse(raw),/not one valid JSON object/);
});
test('context chunking preserves all Unicode/source text within the safe prompt target and testing prefixes every message',()=>{
 const i=input(vacancy,background.map(r=>({...r,content:{...r.content,details:'😀 complete verified detail '.repeat(500)}})));
 const steps=buildAssessmentSteps(i,true);assert.ok(steps.length>3);for(const s of steps){assert.ok(s.text.length<=MAX_SAFE_FIT_PROMPT_CHARS);if(s.phase==='context')assert.ok(s.text.length<=MAX_CONTEXT_PROMPT_CHARS);assert.ok(s.text.startsWith(CHATGPT_TESTING_MODE_PREFIX));}
 const concatenated=steps.filter(s=>s.phase==='context').map(s=>s.text.split('BEGIN SOURCE PART\n')[1].split('\nEND SOURCE PART')[0]).join('');assert.deepEqual(JSON.parse(concatenated),i);
});
test('experience duration merges concurrent employment and does not count education',()=>{
 const records=buildBackground({employment:[{id:'a',verification_status:'verified',start_date:'2020-01-01',end_date:'2022-01-01',role_title:'Engineer'},{id:'b',verification_status:'verified',start_date:'2021-01-01',end_date:'2023-01-01',role_title:'Researcher'}],education:[{id:'c',verification_status:'verified',start_date:'2010-01-01',end_date:'2020-01-01',qualification:'Degree'}]});
 assert.equal(employmentDays(records,new Date('2026-01-01')),1096);
 assert.equal(employmentDays(buildBackground({employment:[{id:'bad',verification_status:'verified',role_title:'Engineer'}]}),new Date()),null);
});
test('direct years-of-experience claims require sufficient cited employment history, frozen to the assessment date',()=>{
 const history=buildBackground({employment:[{id:'e1',verification_status:'verified',role_title:'Simulation Engineer',start_date:'2018-01-01',end_date:'2024-01-01',details:'Built and validated engineering simulation models.'}]});
 const v={...vacancy,essential_requirements:['At least 5 years of simulation engineering experience.']};
 const i=input(v,history),r=response(i,'direct','employment:e1','Built and validated engineering simulation models.');
 const fit=calculateAssessment(i,r,new Date('2026-01-01T00:00:00.000Z'));
 assert.deepEqual(fit.seniority_calculations[0].cited_employment_references,['employment:e1']);
 assert.equal(fit.seniority_calculations[0].established,true);
 const shortHistory=buildBackground({employment:[{id:'e2',verification_status:'verified',role_title:'Simulation Engineer',start_date:'2023-01-01',end_date:'2024-01-01',details:'Built and validated engineering simulation models.'}]});
 const shortInput=input(v,shortHistory),shortResponse=response(shortInput,'direct','employment:e2','Built and validated engineering simulation models.');
 assert.throws(()=>calculateAssessment(shortInput,shortResponse,new Date('2026-01-01T00:00:00.000Z')),/not supported by the cited verified employment intervals/);
});
const preferences={locations:['London'],work_modes:['hybrid'],salary:{minimum:40000,target:50000,currency:'GBP'},posting_age_policy:{max_days:21},min_fit_score_10:6};
test('work-mode match does not excuse incompatible location; country aliases are explicit',()=>{
 const e=evaluatePreferences({...vacancy,location:'Berlin'},preferences,new Date('2026-09-30'));assert.equal(e.constraints.location.state,'conflict');assert.equal(e.components.geography,0);
 assert.equal(evaluatePreferences({...vacancy,location:'Bristol'},{...preferences,locations:['UK']},new Date()).constraints.location.state,'satisfied');
});
test('salary period/provenance prevents hourly amounts or estimates becoming false hard conflicts',()=>{
 for(const v of [{...vacancy,salary_min:40,salary_max:50,salary_period:'hourly'},{...vacancy,salary_min:20000,salary_max:30000,salary_source:'chatgpt_estimate'}])assert.equal(evaluatePreferences(v,preferences,new Date()).constraints.salary.state,'unknown');
 assert.equal(evaluatePreferences({...vacancy,salary_min:40,salary_max:50,salary_period:'hourly',salary_hours_per_week:37.5},preferences,new Date()).constraints.salary.state,'satisfied');
 assert.equal(evaluatePreferences({...vacancy,salary_min:20000,salary_max:30000},preferences,new Date()).constraints.salary.state,'conflict');
 assert.equal(evaluatePreferences({...vacancy,salary_min:35000,salary_max:45000},preferences,new Date()).constraints.salary.state,'unknown');
});
test('priority honours time and threshold preferences, removes screening probability and never requests documents',()=>{
 const i=input(),fit=calculateAssessment(i,response(i));const now=new Date('2026-09-30');
 assert.equal(priorityAndRecommendation(fit,{...vacancy,closes_at:'2026-09-01'},preferences,now).recommendation,'Closed');
 const half=calculateAssessment(i,response(i,'partial'));assert.equal(priorityAndRecommendation(half,vacancy,{...preferences,min_fit_score_10:6},now).recommendation,'Below your fit threshold');
 assert.equal(priorityAndRecommendation(half,vacancy,{...preferences,min_fit_score_10:4},now).recommendation,'Worth reviewing');
 const result=priorityAndRecommendation(fit,vacancy,preferences,now);assert.equal(result.recommendation,'Recommended');assert.equal(result.components.screening_probability,undefined);assert.equal(result.documents,undefined);
 assert.equal(evaluatePreferences({...vacancy,posted_at:'2030-01-01'},preferences,now).constraints.posting_age.state,'unknown');
});
test('exact dispatch, conversation and assistant-turn provenance are mandatory; processing is repeatable without sending',()=>{
 const i=input(),steps=buildAssessmentSteps(i),step=steps.at(-1);const provenance={conversationUrl:'https://chatgpt.com/c/abc',userTurnFingerprint:'sent-user-turn-hash',userTurnMessageId:'user-message-id',assistantMessageId:'assistant-message-id',assistantFingerprint:'assistant-turn-hash',source:'assistant_turn',generationFinished:true};
 const d={id:'dispatch',action_type:'jobs.analyse_selected',idempotency_key:assessmentDispatchKey('task',1,step.ordinal),subject_refs:{job_ids:['job-1']},state:'completed',output_refs:{response_provenance_recorded:true},response_provenance:provenance,delivery_turn_anchor:{conversationUrl:provenance.conversationUrl},delivery_user_turn_fingerprint:provenance.userTurnFingerprint,bridge_response_at:'2026-09-30',bridge_response:JSON.stringify(response(i))};
 const args={input:i,taskId:'task',attempt:1,step,dispatch:d,expectedDispatchId:'dispatch',assessmentAsOf:new Date('2026-09-30T00:00:00Z')};
 assert.deepEqual(processExactResponse(args),processExactResponse(args));
 assert.throws(()=>processExactResponse({...args,dispatch:{...d,output_refs:{}}}),/provenance/);
 assert.throws(()=>processExactResponse({...args,dispatch:{...d,subject_refs:{job_ids:['other']}}}),/does not belong/);
 assert.throws(()=>processExactResponse({...args,expectedConversationUrl:'expected'}),/conversation changed/);
 assert.throws(()=>processExactResponse({...args,dispatch:{...d,response_provenance:{...provenance,assistantMessageId:null,assistantFingerprint:null}}}),/exact sent-user-turn/);
 assert.throws(()=>processExactResponse({...args,dispatch:{...d,delivery_turn_anchor:{conversationUrl:provenance.conversationUrl,lastAssistantMessageId:provenance.assistantMessageId}}}),/already existed at the saved pre-send boundary/);
 assert.throws(()=>processExactResponse({...args,dispatch:{...d,response_provenance:{...provenance,assistantMessageId:null},delivery_turn_anchor:{conversationUrl:provenance.conversationUrl,lastAssistantFingerprint:provenance.assistantFingerprint}}}),/already existed at the saved pre-send boundary/);
 assert.throws(()=>processExactResponse({...args,dispatch:{...d,response_provenance:{...provenance,source:'assistant_artifact',artifactKey:'old-file'},delivery_turn_anchor:{conversationUrl:provenance.conversationUrl,artifactKeys:['old-file']}}}),/already existed at the saved pre-send boundary/);
});
test('only a server-confirmed, pre-Send composer mismatch is safe to retry',()=>{
 const dispatch={state:'user_required',error:{code:'composer_mismatch'},retry_allowed:true,sent_at:null,send_attempted_at:null,sent_confirmed_at:null,has_delivery_turn_anchor:false,response_hash:null,bridge_response:null};
 assert.equal(isSafeUnsentComposerMismatch(dispatch),true);
 for(const change of [
  {sent_at:'2026-09-30T00:00:00Z'},
  {send_attempted_at:'2026-09-30T00:00:00Z'},
  {sent_confirmed_at:'2026-09-30T00:00:00Z'},
  {has_delivery_turn_anchor:true},
  {response_hash:'a'.repeat(64)},
  {bridge_response:'a captured assistant reply'},
  {retry_allowed:false},
  {state:'completed'},
  {error:{code:'delivery_uncertain'}},
 ]) assert.equal(isSafeUnsentComposerMismatch({...dispatch,...change}),false);
});
test('server-confirmed V2 pre-Send failures are retryable without trusting their error label',()=>{
 const dispatch={state:'user_required',protocol:'v2',error:{code:'delivery_uncertain'},retry_allowed:true,sent_at:null,send_attempted_at:null,sent_confirmed_at:null,has_delivery_turn_anchor:false,response_hash:null,bridge_response:null};
 assert.equal(isSafeUnsentPreDeliveryV2Dispatch(dispatch),true);
 for(const errorCode of ['composer_mismatch','delivery_lease_expired','delivery_uncertain']){
  assert.equal(isSafeUnsentPreDeliveryV2Dispatch({...dispatch,error:{code:errorCode}}),true);
 }
 for(const change of [
  {protocol:'v1'},
  {protocol:undefined},
  {retry_allowed:false},
  {state:'completed'},
  {sent_at:'2026-09-30T00:00:00Z'},
  {send_attempted_at:'2026-09-30T00:00:00Z'},
  {sent_confirmed_at:'2026-09-30T00:00:00Z'},
  {has_delivery_turn_anchor:true},
  {response_hash:'a'.repeat(64)},
  {bridge_response:'already captured'},
 ]) assert.equal(isSafeUnsentPreDeliveryV2Dispatch({...dispatch,...change}),false);
});
test('only the generic bridge retry marker can resume a queued, unsent step',()=>{
 const dispatch={state:'queued',progress:{stage:'requeued_by_user'},sent_at:null,send_attempted_at:null,sent_confirmed_at:null,has_delivery_turn_anchor:false,response_hash:null,bridge_response:null};
 assert.equal(isRequeuedUnsentDispatch(dispatch),true);
 for(const change of [
  {progress:{stage:'other'}},
  {sent_at:'2026-09-30T00:00:00Z'},
  {send_attempted_at:'2026-09-30T00:00:00Z'},
  {sent_confirmed_at:'2026-09-30T00:00:00Z'},
  {has_delivery_turn_anchor:true},
  {response_hash:'a'.repeat(64)},
  {bridge_response:'a captured assistant reply'},
 ]) assert.equal(isRequeuedUnsentDispatch({...dispatch,...change}),false);
});
test('exact-turn recovery allows bounded cooldown retries and makes an in-flight check idempotent',()=>{
 const now=Date.parse('2026-09-30T12:00:15.000Z');
 const source='original-dispatch', reader='response-check-ticket';
 const first=responseCheckEligibility({state:'needs_user',attemptCount:0,sourceDispatchId:null,activeDispatchId:source,requestedSourceDispatchId:source,lastRequestedAt:null,nowMs:now});
 assert.equal(first.allowed,true);assert.equal(first.idempotent,false);
 const waiting=responseCheckEligibility({state:'waiting_for_bridge',attemptCount:1,sourceDispatchId:source,activeDispatchId:reader,requestedSourceDispatchId:source,lastRequestedAt:'2026-09-30T12:00:14.000Z',nowMs:now});
 assert.equal(waiting.allowed,true);assert.equal(waiting.idempotent,true);
 const cooldown=responseCheckEligibility({state:'needs_user',attemptCount:1,sourceDispatchId:source,activeDispatchId:reader,requestedSourceDispatchId:source,lastRequestedAt:'2026-09-30T12:00:01.000Z',nowMs:now});
 assert.deepEqual(cooldown,{allowed:false,reason:'rate_limited',retryAfterSeconds:1});
 const readyAgain=responseCheckEligibility({state:'needs_user',attemptCount:1,sourceDispatchId:source,activeDispatchId:reader,requestedSourceDispatchId:source,lastRequestedAt:'2026-09-30T12:00:00.000Z',nowMs:now});
 assert.equal(readyAgain.allowed,true);assert.equal(readyAgain.idempotent,false);
 const exhausted=responseCheckEligibility({state:'needs_user',attemptCount:MAX_RESPONSE_CHECK_ATTEMPTS,sourceDispatchId:source,activeDispatchId:reader,requestedSourceDispatchId:source,lastRequestedAt:null,nowMs:now});
 assert.equal(exhausted.allowed,false);assert.equal(exhausted.reason,'exhausted');
 const stale=responseCheckEligibility({state:'needs_user',attemptCount:1,sourceDispatchId:source,activeDispatchId:reader,requestedSourceDispatchId:'different-dispatch',lastRequestedAt:null,nowMs:now});
 assert.equal(stale.allowed,false);assert.equal(stale.reason,'stale');
 assert.equal(RESPONSE_CHECK_COOLDOWN_MS,15000);
});
test('eligibility requires explicit facts and rejects employment-based inference',()=>{
 const i=input({...vacancy,essential_requirements:[...vacancy.essential_requirements,'Legal right to work in the United Kingdom is required.']});const r=response(i);const c=i.criteria.find(c=>c.dimension==='eligibility');
 r.eligibility_findings=[{requirement_reference:c.reference,state:'confirmed_eligible',evidence:[{reference:'fact:f1',quote:'Confirmed legal right to work in the United Kingdom.'}],explanation:'Explicit verified authorisation fact.'}];assert.equal(calculateAssessment(i,r).eligibility,'confirmed_eligible');
 r.eligibility_findings[0].evidence=[{reference:'project:p1',quote:'Developed Python finite element simulations'}];assert.throws(()=>calculateAssessment(i,r),/explicit verified/);
});
