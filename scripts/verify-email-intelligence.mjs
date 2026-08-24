import fs from "node:fs";
import assert from "node:assert/strict";
import { classifyRecruitingEmail, matchEmailToApplication, emailRequiresUser } from "../packages/email-intelligence/index.js";

const fixture = JSON.parse(fs.readFileSync("data/emails/recent.json", "utf8"));
const apps = [
  { id: "rolls", company: "Rolls-Royce", role: "Aerothermal Engineer", externalJobId: "JR6158436", appliedAt: "2026-08-22", state: "awaiting_response" },
  { id: "prima", company: "Prima", role: "Quantitative Analyst", externalJobId: null, appliedAt: "2026-08-18", state: "awaiting_response" },
  { id: "cadillac", company: "Cadillac Formula 1 Team", role: "Systems Simulation Engineer", externalJobId: null, appliedAt: "2026-08-19", state: "awaiting_response" },
  { id: "mott", company: "Mott MacDonald", role: "Systems Engineer", externalJobId: "16109", appliedAt: "2026-08-22", state: "awaiting_response" }
];

const rows=[];
for (const email of fixture.records) {
  const classification=classifyRecruitingEmail(email);
  assert.equal(classification.classification,email.expectedClassification,`${email.subject}: wrong classification`);
  const match=matchEmailToApplication(email,classification,apps);
  if (email.expectedApplication) assert.equal(match.applicationId,email.expectedApplication,`${email.subject}: wrong application match`);
  if (!email.expectedApplication && classification.classification !== "other") assert.equal(match.applicationId,null,`${email.subject}: unexpected application match`);
  if (email.id === "1a02b3608d493d9b") {
    assert.ok(classification.extracted.deadlineAt,"Assessment relative deadline should be extracted");
    assert.ok(match.confidence >= 0.9,"Rolls-Royce reference-id match should be high confidence");
    assert.equal(emailRequiresUser(classification,match),false,"High-confidence assessment should auto-process");
  }
  if (email.id === "1a02dfc09908503b") assert.equal(emailRequiresUser(classification,match),true,"Unmatched confirmation must need user review");
  if (classification.classification === "other") assert.equal(emailRequiresUser(classification,match),false,"Survey/marketing email should not create Needs You noise");
  rows.push({subject:email.subject,classification:classification.classification,classConfidence:classification.confidence,application:match.applicationId,matchConfidence:match.confidence,needsUser:emailRequiresUser(classification,match)});
}

const interview=classifyRecruitingEmail({sender:"recruiter@example.com",subject:"Interview invitation - Simulation Engineer",body:"We would like to invite you to an interview for the Simulation Engineer position."});
assert.equal(interview.classification,"interview");
const offer=classifyRecruitingEmail({sender:"recruiter@example.com",subject:"Offer of employment",body:"We are pleased to offer you the position."});
assert.equal(offer.classification,"offer");
assert.equal(emailRequiresUser(offer,{applicationId:"x",confidence:1,reason:"",method:"manual",alternatives:[]}),true,"Offers must require user attention");

console.table(rows);
console.log("Email intelligence verification passed.");
