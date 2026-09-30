import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  buildDocumentGenerationContext,
  parseDocumentJsonResponse,
  trustedDocumentContact,
  validateDocumentResponse,
} from "./generation-context.ts";
import { renderApplicationDocument } from "./render.ts";
import { advanceDocumentGeneration } from "./service.ts";
import { DOCUMENT_TEMPLATES } from "./templates.ts";

const applicationId = "77777777-7777-4777-8777-777777777777";
const job = {
  id: "88888888-8888-4888-8888-888888888888",
  company: "Fixture Engineering",
  title: "Simulation Engineer",
  industry: "Engineering",
  location: "Manchester, UK",
  description: "A synthetic role used only by renderer tests.",
  extractedRequirements: ["Finite element modelling", "Python"],
};
const evidence = [
  { id: "11111111-1111-4111-8111-111111111111", evidenceKey: "engineering", status: "verified" },
  { id: "22222222-2222-4222-8222-222222222222", evidenceKey: "research", status: "verified" },
  { id: "33333333-3333-4333-8333-333333333333", evidenceKey: "python", status: "verified" },
];
const profile = {
  displayName: "Taylor Example",
  facts: [
    { factKey: "contact.email", value: "taylor@example.test", status: "verified" },
    { factKey: "contact.phone", value: "+44 7700 900000", status: "verified" },
  ],
  evidence: evidence.map((item) => ({ ...item, category: "experience", claim: "Synthetic verified evidence", detail: "Test fixture only", tags: [] })),
  structured: { employment: [], education: [], skills: [], projects: [], publications: [] },
};

function response(kind, inputHash) {
  if (kind === "cv") {
    return {
      schema_version: "1.0",
      document_kind: "cv",
      application_id: applicationId,
      input_hash: inputHash,
      contact: { name: "Wrong unverified contact", email: "wrong@example.test" },
      headline: "Engineering researcher",
      headline_evidence_keys: ["research"],
      profile: { text: "Engineer with verified modelling and research experience.", evidence_keys: ["engineering", "research"] },
      experience: [{
        role: "Simulation Engineer",
        company: "Fixture Engineering",
        dates: "2022–2025",
        location: "Manchester",
        evidence_keys: ["engineering"],
        bullets: [{ text: "Built and validated numerical models for engineering decisions.", evidence_keys: ["engineering", "research"] }],
      }],
      skills: [{ category: "Technical", evidence_keys: ["python"], items: [{ text: "Python", evidence_keys: ["python"] }] }],
      projects: [],
      education: [],
      publications: [],
      tailoring: {},
    };
  }
  const paragraphs = [
    { text: "I am applying for this Simulation Engineer role because its emphasis on validated numerical modelling closely matches my documented engineering and research work. My experience includes building computational models, examining assumptions, and explaining results in a careful and useful way. I am particularly interested in applying that evidence to the practical engineering questions described in this vacancy. The examples in my application materials will let the panel assess this match against the underlying evidence.", evidence_keys: ["engineering", "research"], material: true },
    { text: "In my engineering experience, I built and checked computational models, compared their outputs with reference data, and explained the limits of the results to collaborators. This required keeping analysis reproducible and making technical decisions based on evidence rather than attractive but untested outputs. Those habits would help me contribute responsibly to the modelling work expected in this position.", evidence_keys: ["engineering"], material: true },
    { text: "My verified research work also involved Python-based analysis and careful interpretation of technical results, providing a strong foundation for the role's modelling responsibilities. I value clear communication between specialists and the wider project team, especially when assumptions or uncertainty affect an engineering recommendation. I would bring that evidence-led approach to Fixture Engineering's Simulation Engineer role.", evidence_keys: ["research", "python"], material: true },
    { text: "I am motivated by work where engineering analysis is both technically rigorous and useful in practice. I would bring an open, methodical approach to learning the team's specific tools and processes, while contributing the documented modelling, validation, and Python skills already demonstrated in my background. I would welcome the chance to discuss how this experience aligns with the responsibilities of the role.", evidence_keys: ["engineering", "research", "python"], material: true },
  ];
  return {
    schema_version: "1.0",
    document_kind: "cover_letter",
    application_id: applicationId,
    input_hash: inputHash,
    recipient: "",
    salutation: "Dear Hiring Manager,",
    paragraphs,
    closing: "Yours sincerely,",
    candidate_name: "Taylor Example",
    plaintext: ["Dear Hiring Manager,", ...paragraphs.map((item) => item.text), "Yours sincerely,", "Taylor Example"].join("\n\n"),
  };
}

function cvForRendering() {
  const bullet = (claim_key, text, source = evidence[0]) => ({
    claim_key, text, evidence_ids: [source.id], material: true,
  });
  const sections = [{
    section_key: "experience",
    heading: "Experience",
    entries: [
      { entry_key: "role_1", heading: "Senior Research Engineer", subheading: "Fixture Engineering Group", date: "2022–2025", location: "Manchester", bullets: [
        bullet("experience.1.1", "Built a Python finite-element model that compared design alternatives against measured reference data before a prototype release."),
        bullet("experience.1.2", "Introduced repeatable validation checks and documented model assumptions, reducing avoidable rework during engineering reviews."),
        bullet("experience.1.3", "Presented uncertainty and sensitivity findings to mechanical engineers, helping the team prioritise the tests with the greatest decision value.", evidence[1]),
      ] },
      { entry_key: "role_2", heading: "Research Associate", subheading: "North West Applied Research Centre", date: "2019–2022", location: "Manchester", bullets: [
        bullet("experience.2.1", "Analysed experimental and simulated datasets in Python, checking data quality before drawing conclusions from model outputs.", evidence[2]),
        bullet("experience.2.2", "Worked with cross-disciplinary collaborators to translate research questions into testable engineering studies and clear reports.", evidence[1]),
        bullet("experience.2.3", "Maintained traceable records of analysis steps, limitations, and decisions so that findings could be independently reviewed."),
      ] },
      { entry_key: "role_3", heading: "Mechanical Design Engineer", subheading: "Meridian Product Systems", date: "2016–2019", location: "Leeds", bullets: [
        bullet("experience.3.1", "Supported product design reviews with calculations, test interpretation, and concise evidence for engineering recommendations."),
        bullet("experience.3.2", "Collaborated with manufacturing and quality colleagues to resolve technical questions and communicate practical constraints."),
        bullet("experience.3.3", "Created reusable analysis notes that made assumptions and sources visible to future project teams.", evidence[1]),
      ] },
      { entry_key: "role_4", heading: "Graduate Engineer", subheading: "Meridian Product Systems", date: "2014–2016", location: "Leeds", bullets: [
        bullet("experience.4.1", "Prepared engineering calculations and checked results against design requirements under the guidance of senior colleagues."),
        bullet("experience.4.2", "Summarised test observations and technical findings for project files and internal design discussions.", evidence[1]),
      ] },
    ],
  }, {
    section_key: "skills",
    heading: "Technical Skills",
    entries: [{ entry_key: "skills_1", heading: "Engineering and Computing", bullets: [
      bullet("skills.1", "Python, numerical modelling, finite-element methods, data analysis, model validation and reproducible workflows.", evidence[2]),
      bullet("skills.2", "Technical reporting, uncertainty communication, design review support and cross-functional collaboration.", evidence[1]),
    ] }],
  }, {
    section_key: "projects",
    heading: "Selected Technical Work",
    entries: [
      { entry_key: "project_1", heading: "Thermal performance model", subheading: "Applied Engineering Study", date: "2021–2022", bullets: [
        bullet("projects.1.1", "Compared simulated thermal behaviour with test evidence and recorded the limits of the model before recommending design changes.", evidence[1]),
        bullet("projects.1.2", "Used Python to make the analysis repeatable and to communicate which parameters most affected the result.", evidence[2]),
        bullet("projects.1.3", "Prepared a concise technical summary that enabled reviewers to trace the recommendation to its supporting evidence.", evidence[0]),
      ] },
      { entry_key: "project_2", heading: "Vibration-test correlation", subheading: "Product Engineering Study", date: "2018–2019", bullets: [
        bullet("projects.2.1", "Compared vibration-test observations with model predictions and documented the conditions that affected correlation.", evidence[1]),
        bullet("projects.2.2", "Summarised the findings for a design review, separating measured results from assumptions and open questions.", evidence[0]),
      ] },
      { entry_key: "project_3", heading: "Reusable analysis workflow", subheading: "Research Engineering", date: "2020–2021", bullets: [
        bullet("projects.3.1", "Organised Python analysis steps so input data, validation checks, and plotted results could be reviewed consistently.", evidence[2]),
        bullet("projects.3.2", "Recorded sensitivity findings and limitations alongside conclusions to support reproducible technical decisions.", evidence[1]),
      ] },
    ],
  }, {
    section_key: "education",
    heading: "Education and Development",
    entries: [
      { entry_key: "education_1", heading: "PhD, Mechanical Engineering", subheading: "University of Manchester", date: "2016–2020", bullets: [bullet("education.1.1", "Research focused on numerical modelling, validation, and interpretation of engineering evidence.", evidence[1])] },
      { entry_key: "education_2", heading: "MEng, Mechanical Engineering", subheading: "University of Leeds", date: "2010–2014", bullets: [bullet("education.2.1", "Integrated master's degree with an engineering design and analysis focus.")] },
    ],
  }, {
    section_key: "publications",
    heading: "Research Communication",
    entries: [{ entry_key: "publication_1", heading: "Engineering modelling and validation", subheading: "Technical reports and research presentations", date: "2019–2024", bullets: [
      bullet("publications.1.1", "Presented modelling assumptions, validation evidence, uncertainty, and practical implications to engineering and research audiences.", evidence[1]),
      bullet("publications.1.2", "Prepared concise written summaries that connected technical analysis to recommendations and clearly stated limitations.", evidence[0]),
    ] }],
  }];
  return {
    contract_version: "1.0.0",
    candidate: { name: "Taylor Example", email: "taylor@example.test", phone: "+44 7700 900000", location: "Manchester", linkedin: "" },
    target: { job_id: job.id, company: job.company, title: job.title },
    headline: "Engineering researcher",
    profile_summary: { text: "Engineer with verified modelling and research experience, focused on validated numerical methods and clear technical communication.", evidence_ids: [evidence[0].id, evidence[1].id] },
    sections,
    unsupported_claims: [],
  };
}

function letterForRendering() {
  const paragraphs = [
    { text: "I am applying for the Simulation Engineer position because its focus on validated numerical modelling matches the engineering and research work I have carried out. My experience includes building computational models, examining their assumptions, and using reference evidence to understand where their conclusions are reliable. I am interested in applying that careful approach to the design questions facing Fixture Engineering.", evidence_ids: [evidence[0].id, evidence[1].id], material: true },
    { text: "In my recent research engineering work, I used Python and finite-element methods to compare design alternatives with measured data. I introduced repeatable checks and documented uncertainty so that colleagues could assess both the findings and their limitations. This helped technical reviews stay focused on evidence and on the tests most likely to change a decision.", evidence_ids: [evidence[0].id, evidence[2].id], material: true },
    { text: "Earlier roles strengthened my ability to work across design, manufacturing, and research teams. I prepared calculations and reports, discussed practical constraints, and made the reasoning behind recommendations clear to different audiences. I would bring that combination of analytical discipline and collaborative communication to your engineering projects.", evidence_ids: [evidence[0].id, evidence[1].id], material: true },
    { text: "The opportunity particularly appeals to me because rigorous modelling is most valuable when it informs practical engineering choices. I would contribute a methodical, open approach, build on the verified skills in my background, and learn the team's specific tools and processes. I would welcome the chance to discuss how this experience could support Fixture Engineering's work.", evidence_ids: [evidence[0].id, evidence[1].id], material: true },
  ];
  return {
    candidate_name: "Taylor Example",
    candidate_email: "taylor@example.test",
    candidate_phone: "+44 7700 900000",
    candidate_location: "Manchester",
    company: "Fixture Engineering",
    job_title: "Simulation Engineer",
    salutation: "Dear Hiring Manager,",
    paragraphs,
    closing: "Yours sincerely,",
    plaintext: ["Dear Hiring Manager,", ...paragraphs.map((item) => item.text), "Yours sincerely,", "Taylor Example"].join("\n\n"),
    unsupported_claims: [],
  };
}

test("context preserves complete instruction files and obeys the Website Bridge message budget", async () => {
  const result = await buildDocumentGenerationContext({
    kinds: ["cv", "cover_letter"],
    applicationId,
    templateId: DOCUMENT_TEMPLATES[0].id,
    profile,
    job,
    cvFamily: "engineering",
  });
  const cvInstructions = await readFile(new URL("../../content/document-instructions/custom_CV_instructions.md", import.meta.url), "utf8");
  const letterInstructions = await readFile(new URL("../../content/document-instructions/custom_Cover_Letter_instructions.md", import.meta.url), "utf8");
  assert.match(result.inputHash, /^[0-9a-f]{64}$/);
  assert.ok(result.chunks.length > 2);
  assert.ok(result.chunks.every((step) => step.text.length <= 5600 && /^[0-9a-f]{64}$/.test(step.sha256)));
  assert.ok(result.chunks.every((step, index) => step.ordinal === index + 1 && step.total === result.chunks.length));
  const sourceFrom = (label) => result.chunks
    .filter((step) => step.text.includes("SETUP CONTEXT (" + label + ";"))
    .map((step) => step.text.match(/BEGIN SOURCE TEXT\n([\s\S]*?)\nEND SOURCE TEXT/)?.[1] ?? "")
    .join("");
  assert.equal(sourceFrom("Complete CV instructions"), cvInstructions);
  assert.equal(sourceFrom("Complete cover-letter instructions"), letterInstructions);
  const cvFinal = result.chunks.find((step) => step.kind === "cv" && step.phase === "final").text;
  assert.match(cvFinal, /headline_evidence_keys/);
  assert.match(cvFinal, /The database CV family must be exactly "engineering"/);
  assert.match(cvFinal, /application_id/);
});

test("JSON parser accepts one object and rejects multiple or extra structured values", () => {
  assert.deepEqual(parseDocumentJsonResponse("Here is the draft:\n{\"ok\":true}"), { ok: true });
  assert.deepEqual(parseDocumentJsonResponse("\u0060\u0060\u0060json\n{\"ok\":true}\n\u0060\u0060\u0060"), { ok: true });
  assert.throws(() => parseDocumentJsonResponse("{\"ok\":true}\n{\"second\":true}"), /more than one JSON object/);
  assert.throws(() => parseDocumentJsonResponse("{\"ok\":true}\n\u0060\u0060\u0060json\n{\"second\":true}\n\u0060\u0060\u0060"), /outside the document JSON fence/);
  assert.throws(() => parseDocumentJsonResponse("No JSON was returned."), /no complete JSON/);
  assert.throws(() => parseDocumentJsonResponse("[{\"ok\":true}]"), /structured value|JSON/);
});

test("response validation binds job, application, exact input hash and every factual claim to verified evidence", async () => {
  const frozen = await buildDocumentGenerationContext({
    kinds: ["cv", "cover_letter"],
    applicationId,
    templateId: "classic-navy",
    profile,
    job,
    cvFamily: "engineering",
  });
  const approved = frozen.snapshot.profile.verified_evidence.map((item) => ({ evidenceKey: item.key, id: item.id, status: item.status }));
  const contact = trustedDocumentContact(profile);
  const cv = validateDocumentResponse(response("cv", frozen.inputHash), "cv", applicationId, frozen.inputHash, approved, "engineering", job, contact);
  assert.equal(cv.structured.candidate.name, "Taylor Example");
  assert.equal(cv.structured.candidate.email, "taylor@example.test");
  assert.equal(cv.structured.target.job_id, job.id);
  assert.ok(cv.evidenceLinks.some((item) => item.claimKey === "headline" && item.evidenceId === evidence[1].id));
  assert.ok(cv.evidenceLinks.some((item) => item.claimKey.startsWith("experience.") && item.evidenceId === evidence[0].id));

  const rawLetter = response("cover_letter", frozen.inputHash);
  const letter = validateDocumentResponse(rawLetter, "cover_letter", applicationId, frozen.inputHash, approved, "engineering", job, contact);
  assert.equal(letter.plaintext, rawLetter.plaintext);
  assert.ok(letter.evidenceLinks.length >= 3);
  assert.throws(() => validateDocumentResponse(response("cv", "0".repeat(64)), "cv", applicationId, frozen.inputHash, approved, "engineering", job, contact), /did not match this application/);

  const unsupported = response("cv", frozen.inputHash);
  unsupported.experience[0].evidence_keys = ["unverified-key"];
  assert.throws(() => validateDocumentResponse(unsupported, "cv", applicationId, frozen.inputHash, approved, "engineering", job, contact), /unknown or unverified/);
  const unanchored = response("cv", frozen.inputHash);
  unanchored.headline_evidence_keys = [];
  assert.throws(() => validateDocumentResponse(unanchored, "cv", applicationId, frozen.inputHash, approved, "engineering", job, contact), /no verified evidence/);
  const shortLetter = response("cover_letter", frozen.inputHash);
  shortLetter.paragraphs = shortLetter.paragraphs.slice(0, 1);
  shortLetter.plaintext = ["Dear Hiring Manager,", shortLetter.paragraphs[0].text, "Yours sincerely,", "Taylor Example"].join("\n\n");
  assert.throws(() => validateDocumentResponse(shortLetter, "cover_letter", applicationId, frozen.inputHash, approved, "engineering", job, contact), /invalid cover-letter paragraph list/);
});

test("all eight themes render a two-page CV and one-page cover letter as valid PDF and editable DOCX", async () => {
  for (const theme of DOCUMENT_TEMPLATES) {
    const cvFiles = await renderApplicationDocument("cv", cvForRendering(), theme.id);
    const cvPdf = await PDFDocument.load(cvFiles.pdf);
    assert.equal(cvPdf.getPageCount(), 2, theme.name + " CV PDF page count");
    assert.equal(cvFiles.quality.pageCount, 2);
    assert.ok(cvFiles.quality.pageUsage[1] >= 0.4, theme.name + " CV second-page balance");
    assert.equal(cvFiles.pdf.subarray(0, 4).toString("ascii"), "%PDF");
    assert.equal(cvFiles.docx.subarray(0, 2).toString("ascii"), "PK");

    const letterFiles = await renderApplicationDocument("cover_letter", letterForRendering(), theme.id);
    const letterPdf = await PDFDocument.load(letterFiles.pdf);
    assert.equal(letterPdf.getPageCount(), 1, theme.name + " cover-letter PDF page count");
    assert.equal(letterFiles.quality.pageCount, 1);
    assert.equal(letterFiles.pdf.subarray(0, 4).toString("ascii"), "%PDF");
    assert.equal(letterFiles.docx.subarray(0, 2).toString("ascii"), "PK");
    if (process.env.DOCUMENT_RENDER_TEST_OUTDIR) {
      await mkdir(process.env.DOCUMENT_RENDER_TEST_OUTDIR, { recursive: true });
      await writeFile(process.env.DOCUMENT_RENDER_TEST_OUTDIR + "/" + theme.id + "-cv.pdf", cvFiles.pdf);
      await writeFile(process.env.DOCUMENT_RENDER_TEST_OUTDIR + "/" + theme.id + "-cv.docx", cvFiles.docx);
      await writeFile(process.env.DOCUMENT_RENDER_TEST_OUTDIR + "/" + theme.id + "-letter.pdf", letterFiles.pdf);
      await writeFile(process.env.DOCUMENT_RENDER_TEST_OUTDIR + "/" + theme.id + "-letter.docx", letterFiles.docx);
    }
  }
});

test("renderer refuses a one-page CV and a cover letter that overflows one page", async () => {
  const tinyCv = {
    candidate: { name: "Taylor Example" },
    headline: "Engineer",
    profile_summary: { text: "A brief verified profile." },
    sections: [{ section_key: "experience", heading: "Experience", entries: [{ heading: "Engineer", bullets: [{ text: "One supported achievement." }] }] }],
  };
  await assert.rejects(() => renderApplicationDocument("cv", tinyCv, "classic-navy"), /did not fill the required two A4 pages/);
  const hugeLetter = { ...letterForRendering(), paragraphs: [{ text: "evidence ".repeat(10000) }] };
  await assert.rejects(() => renderApplicationDocument("cover_letter", hugeLetter, "classic-navy"), /theme is too full/);
});

test("a captured cover-letter response is reused after a transient storage failure without dispatching it again", async () => {
  const frozen = await buildDocumentGenerationContext({
    kinds: ["cover_letter"],
    applicationId,
    templateId: "classic-navy",
    profile,
    job,
    cvFamily: "engineering",
  });
  const requestId = "99999999-9999-4999-8999-999999999999";
  const dispatchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const itemId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const versionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const rawResponse = JSON.stringify(response("cover_letter", frozen.inputHash));
  const dispatch = {
    id: dispatchId,
    state: "completed",
    action_type: "documents.cover_letter.create",
    idempotency_key: "docgen-" + requestId + ":0",
    subject_refs: { application_ids: [applicationId] },
    output_refs: { response_provenance_recorded: true },
    bridge_response: rawResponse,
    bridge_response_at: "2026-09-30T00:00:00.000Z",
  };
  const request = {
    id: requestId,
    application_id: applicationId,
    current_chunk: 0,
    dispatch_id: null,
    context_chunks: [{ kind: "cover_letter", phase: "final" }],
    input_snapshot: frozen.snapshot,
    input_hash: frozen.inputHash,
    template_id: "classic-navy",
  };
  const item = { id: itemId, document_kind: "cover_letter", response_hash: null, state: "writing" };
  const calls = [];
  const stored = new Map();
  let failOnePdfUpload = true;
  let savedResponseCalls = 0;
  let createdVersionId = null;
  const supabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "get_chatgpt_dispatch_request") return { data: dispatch, error: null };
      if (name === "record_application_document_dispatch") return { data: true, error: null };
      if (name === "record_application_document_response") {
        savedResponseCalls++;
        return { data: true, error: null };
      }
      if (name === "create_application_document_version") {
        createdVersionId ||= versionId;
        return { data: { document_version_id: createdVersionId, version_number: 1 }, error: null };
      }
      if (name === "finalize_application_document_item") return { data: { ready: true }, error: null };
      throw new Error("Unexpected document workflow RPC: " + name);
    },
    storage: {
      from() {
        return {
          async upload(key, bytes) {
            if (failOnePdfUpload && key.endsWith("cover_letter.pdf")) {
              failOnePdfUpload = false;
              return { error: new Error("simulated temporary storage outage") };
            }
            stored.set(key, new Blob([bytes]));
            return { error: null };
          },
          async download(key) {
            const data = stored.get(key);
            return data ? { data, error: null } : { data: null, error: new Error("stored object not found") };
          },
        };
      },
    },
  };

  await assert.rejects(
    () => advanceDocumentGeneration(supabase, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", request, [item], 0, dispatchId),
    /simulated temporary storage outage/,
  );
  assert.equal(item.response_hash?.length, 64, "the exact response hash is durably captured before file upload");
  assert.equal(item.response_text, rawResponse);
  assert.equal(savedResponseCalls, 1);

  const recovered = await advanceDocumentGeneration(supabase, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", request, [item], 0, dispatchId);
  assert.equal(recovered.capturedDocument, true);
  assert.equal(recovered.finalized.ready, true);
  assert.equal(savedResponseCalls, 1, "retry does not recapture or resend the original assistant response");
  assert.equal(calls.filter((call) => call.name === "get_chatgpt_dispatch_request").length, 2);
  assert.equal(calls.some((call) => /dispatch|send/i.test(call.name) && call.name !== "get_chatgpt_dispatch_request" && call.name !== "record_application_document_dispatch"), false);
  assert.ok([...stored.keys()].some((key) => key.endsWith("cover_letter.pdf")));
  assert.ok([...stored.keys()].some((key) => key.endsWith("cover_letter.docx")));
});
