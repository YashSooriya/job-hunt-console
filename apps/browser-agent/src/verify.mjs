import assert from "node:assert/strict";
import { planAdaptivePage, buildFinalReviewDiff, validatePagePlan, isDangerousSubmissionLabel, isStartApplicationLabel } from "../../../packages/form-agent/index.js";

const context = {
  candidate: { name: "Test Person", firstName: "Test", lastName: "Person", email: "test@example.com", phone: "+44 7000000000" },
  facts: [{ id: "fact-1", factKey: "education.beng.institution", value: "Swansea University", verified: true }],
  answers: [
    { id: "ans-1", questionKey: "notice_period", questionText: "What is your notice period?", answerText: "Less than one month", trust: "proposed", approved: true },
    { id: "ans-2", questionKey: "work_authorisation_uk", questionText: "Are you legally authorized to work in the UK?", answerText: "Yes", trust: "user_required", approved: true },
  ],
  salary: { value: 51000, currency: "GBP", approved: true },
  documents: { cv: { url: "https://example.test/cv.pdf", versionId: "cv-1" }, coverLetter: { url: "https://example.test/cover.pdf", versionId: "cl-1" } },
  coverLetterContent: "Dear Hiring Manager,\n\nApproved letter text."
};
const base = { url: "https://careers.example.test/apply", title: "Application", bodyText: "Candidate details", flags:{} };

let plan = planAdaptivePage({ ...base, controls: [
  { fieldKey:"f1",label:"First name",controlType:"text",required:true,hasValue:false },
  { fieldKey:"f2",label:"Email",controlType:"text",required:true,hasValue:false },
  { fieldKey:"f3",label:"Continue",controlType:"button",required:false },
] }, context);
assert.equal(plan.must_pause, false);
assert.equal(plan.actions[0].target_key, "f1");
assert.equal(validatePagePlan(plan).ok, true);

// One-page ATS forms expose Submit before fields are filled. Safe work must happen first.
plan = planAdaptivePage({ ...base, bodyText:"Apply for this job", controls: [
  { fieldKey:"f1",label:"First Name*",controlType:"text",required:true,hasValue:false },
  { fieldKey:"f2",label:"Are you legally authorized to work in the UK?*",controlType:"select",required:true,hasValue:false,options:[{label:"Select...",value:""},{label:"Yes",value:"yes"},{label:"No",value:"no"}] },
  { fieldKey:"f3",label:"Submit application",controlType:"button" },
] }, context);
assert.equal(plan.submission_detected, false);
assert.equal(plan.must_pause, false);
assert.equal(plan.actions[0].target_key, "f1");

// User-only answers can be inserted after the user explicitly supplied and approved them.
plan = planAdaptivePage({ ...base, bodyText:"Screening", controls: [
  { fieldKey:"f1",label:"Are you legally authorized to work in the UK?*",controlType:"select",required:true,hasValue:false,options:[{label:"Select...",value:""},{label:"Yes",value:"yes"},{label:"No",value:"no"}] },
  { fieldKey:"f2",label:"Submit application",controlType:"button" },
] }, context);
assert.equal(plan.must_pause, false);
assert.equal(plan.fields[0].status, "ready");
assert.equal(plan.fields[0].trust, "user_required");
assert.equal(plan.fields[0].proposed_value, "Yes");

// Generic Apply is a start CTA, not a final submission control, when no form fields exist.
plan = planAdaptivePage({ ...base, title:"Software Engineer", bodyText:"Job description", controls:[{fieldKey:"f1",label:"Apply",controlType:"button"}] }, context);
assert.equal(isDangerousSubmissionLabel("Apply"), false);
assert.equal(isStartApplicationLabel("Apply"), true);
assert.equal(plan.submission_detected, false);
assert.equal(plan.actions[0].action, "navigate");

// Red field without a user-approved value still pauses.
plan = planAdaptivePage({ ...base, bodyText:"Equal opportunities monitoring", controls:[
  {fieldKey:"f1",label:"Ethnicity",controlType:"select",required:true,hasValue:false},
  {fieldKey:"f2",label:"Continue",controlType:"button"}
] }, context);
assert.equal(plan.must_pause, true);
assert.equal(plan.fields[0].trust, "user_required");

// Radio groups select only the option matching the approved value.
plan = planAdaptivePage({ ...base, bodyText:"Eligibility", controls:[
  {fieldKey:"f1",label:"Are you legally authorized to work in the UK?",optionLabel:"Yes",optionValue:"yes",controlType:"radio",required:true,hasValue:false},
  {fieldKey:"f2",label:"Are you legally authorized to work in the UK?",optionLabel:"No",optionValue:"no",controlType:"radio",required:true,hasValue:false},
  {fieldKey:"f3",label:"Submit application",controlType:"button"}
] }, context);
assert.equal(plan.must_pause, false);
assert.equal(plan.actions[0].target_key, "f1");
assert.equal(plan.fields.find((f)=>f.field_key==="f2").status, "unsupported");

// Text cover letters use the exact approved document text rather than inventing new prose.
plan = planAdaptivePage({ ...base, bodyText:"Documents", controls:[
  {fieldKey:"f1",label:"Cover Letter",controlType:"textarea",required:false,hasValue:false},
  {fieldKey:"f2",label:"Continue",controlType:"button"}
] }, context);
assert.equal(plan.actions[0].target_key, "f1");
assert.equal(plan.fields[0].proposed_value, context.coverLetterContent);

// Gate 2 starts only once required fields are complete and no safe approved fields remain.
plan = planAdaptivePage({ ...base, bodyText:"Review your application", controls:[
  {fieldKey:"f1",label:"First name",controlType:"text",required:true,currentValue:"Test",hasValue:true},
  {fieldKey:"f2",label:"Submit application",controlType:"button"}
] }, context);
assert.equal(plan.submission_detected, true);
assert.equal(plan.actions.length, 0);

const diff = buildFinalReviewDiff({ ...base, controls:[{fieldKey:"f1",label:"First name",controlType:"text",required:true,currentValue:"Test",hasValue:true}] }, planAdaptivePage({ ...base, controls:[{fieldKey:"f1",label:"First name",controlType:"text",required:true,currentValue:"Test",hasValue:true}] }, context));
assert.equal(diff.summary.total, 1);
console.log("Form-agent generic planning verification passed.");
