import assert from "node:assert/strict";
import test from "node:test";
import { extractSourceProposals } from "./extract.ts";

const source = [
  "EXPERIENCE",
  "Data Quality Engineer at Northstar Analytics | Jan 2022 to Dec 2024",
  "- Built deterministic checks for fictional data.",
  "EDUCATION",
  "Ada Lovelace University | BSc Software Engineering | 2018 to 2021",
  "SKILLS",
  "Python, TypeScript, PostgreSQL",
  "PROJECTS",
  "Synthetic Quality Dashboard: Built a fictional dashboard for test fixtures.",
].join("\n");

test("extracts review proposals with source line provenance and no automatic verification", () => {
  const proposals = extractSourceProposals(source);
  const employment = proposals.find((item) => item.category === "employment");
  const education = proposals.find((item) => item.category === "education");
  const skill = proposals.find((item) => item.category === "skill" && item.proposed.name === "TypeScript");
  const project = proposals.find((item) => item.category === "project");

  assert.equal(employment.proposed.employer, "Northstar Analytics");
  assert.equal(employment.proposed.role_title, "Data Quality Engineer");
  assert.equal(employment.proposed.start_date, "2022-01-01");
  assert.equal(employment.locator, "line:2");
  assert.equal(education.proposed.institution, "Ada Lovelace University");
  assert.equal(education.proposed.qualification, "BSc Software Engineering");
  assert.ok(skill);
  assert.equal(project.proposed.title, "Synthetic Quality Dashboard");
  for (const proposal of proposals) {
    assert.match(proposal.proposalKey, /^[a-z]+_\d{3}$/);
    assert.match(proposal.locator, /^line:\d+$/);
    assert.equal("verification_status" in proposal, false);
  }
});

test("structured ChatGPT profile JSON is not split into misleading text proposals", () => {
  const proposals = extractSourceProposals(JSON.stringify({ profile: { employment: [{ company_name: "Example" }] } }));
  assert.deepEqual(proposals, []);
});

test("Markdown section headings classify claims and preserve conflicting employment dates", () => {
  const proposals = extractSourceProposals([
    "## Experience",
    "Data Quality Engineer at Northstar Analytics | Feb 2022 to Present",
  ].join("\n"));
  const employment = proposals.find((item) => item.category === "employment");
  assert.equal(employment?.proposed.employer, "Northstar Analytics");
  assert.equal(employment?.proposed.role_title, "Data Quality Engineer");
  assert.equal(employment?.proposed.start_date, "2022-02-01");
  assert.equal(employment?.proposed.current, true);
});
