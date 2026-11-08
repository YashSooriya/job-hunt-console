import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import {
  buildDocumentGenerationContext,
  parseDocumentJsonResponse,
  trustedDocumentContact,
  validateDocumentResponse,
} from "./generation-context.ts";
import { renderApplicationDocument } from "./render.ts";
import { DOCUMENT_PREVIEW_CV, DOCUMENT_PREVIEW_LETTER } from "./preview-content.ts";
import { advanceDocumentGeneration } from "./service.ts";
import { DEFAULT_DOCUMENT_TEMPLATE, DOCUMENT_TEMPLATES, isDocumentTemplateId } from "./templates.ts";

const applicationId = "77777777-7777-4777-8777-777777777777";
const pdftotextBin = process.env.PDFTOTEXT_BIN || (process.platform === "win32" ? "pdftotext.exe" : "pdftotext");
let pdftotextAvailable = true;
try { execFileSync(pdftotextBin, ["-v"], { stdio: "ignore" }); } catch { pdftotextAvailable = false; }

function normalizedDocumentText(value) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function assertReadingOrder(value, phrases, label) {
  const text = normalizedDocumentText(value);
  let previous = -1;
  for (const phrase of phrases) {
    const current = text.indexOf(normalizedDocumentText(phrase), previous + 1);
    assert.ok(current >= 0, label + " does not contain expected text: " + phrase);
    assert.ok(current > previous, label + " reading order differs at: " + phrase);
    previous = current;
  }
}

function docxText(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    .join(" ");
}

function assertDocxA4(xml, label) {
  const pageSize = xml.match(/<w:pgSz\b([^>]*)\/?\s*>/)?.[1] || "";
  assert.match(pageSize, /\bw:w="11906"/i, label + " uses A4 width");
  assert.match(pageSize, /\bw:h="16838"/i, label + " uses A4 height");
}

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
  const memoryOnly = (source) => source
    .replace(/Master CV\s*\/\s*Professional Evidence Bank/gi, "ChatGPT Memory")
    .replace(/Master CV/gi, "ChatGPT Memory")
    .replace(/evidence_keys/g, "memory_support")
    + "\n\nMANDATORY MEMORY-ONLY OVERRIDE: This request contains no candidate background, CV, evidence bank, profile facts, or candidate preferences. Ignore any earlier source instruction that refers to supplied documents, CVs, evidence records, project context, previous messages, or other material as candidate-fact sources. Use only facts independently recalled from ChatGPT Memory for the user. The vacancy and selected visual theme are the only user-specific information supplied by the application. If Memory is insufficient, omit unsupported content and report the limitation; never fill gaps from conversation context or guesswork.";
  assert.equal(sourceFrom("Complete CV instructions"), memoryOnly(cvInstructions));
  assert.equal(sourceFrom("Complete cover-letter instructions"), memoryOnly(letterInstructions));
  const cvFinal = result.chunks.find((step) => step.kind === "cv" && step.phase === "final").text;
  assert.match(cvFinal, /headline_memory_support/);
  assert.match(cvFinal, /use only facts you recall reliably from ChatGPT Memory/);
  assert.doesNotMatch(cvFinal, /verified evidence|evidence_keys/);
  assert.ok(!JSON.stringify(result).includes("Synthetic verified evidence"));
  assert.match(cvFinal, /The database CV family must be exactly "engineering"/);
  assert.match(cvFinal, /application_id/);
  assert.match(sourceFrom("Complete CV instructions"), /MANDATORY MEMORY-ONLY OVERRIDE/);
  const safetyFilterInput = JSON.stringify(result.chunks).replace(/https?:\/\/\S+/gi, "");
  assert.doesNotMatch(safetyFilterInput, /(jobhuntai|\bmcp\b|dispatch request|claim_dispatch|chatgpt_bridge)/i,
    "Memory-only generation instructions must pass the existing Website Bridge text guard without weakening it");
  assert.equal(result.snapshot.memory_only, true);
  assert.equal("profile" in result.snapshot, false);
  assert.equal(result.snapshot.template_id, DEFAULT_DOCUMENT_TEMPLATE);
  const alternateTheme = await buildDocumentGenerationContext({
    kinds: ["cv", "cover_letter"], applicationId, templateId: "technical-slate", profile, job, cvFamily: "engineering",
  });
  assert.equal(alternateTheme.snapshot.template_id, "technical-slate");
  assert.notEqual(alternateTheme.inputHash, result.inputHash, "theme selection remains part of the durable request identity");
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
  const approved = evidence.map((item) => ({ evidenceKey: item.evidenceKey, id: item.id, status: item.status }));
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

test("Memory-only document prompts and validation never require or emit local profile evidence", async () => {
  const frozen = await buildDocumentGenerationContext({
    kinds: ["cv", "cover_letter"], applicationId, templateId: "classic-navy", profile, job, cvFamily: "engineering",
  });
  const prompts = frozen.chunks.map((chunk) => chunk.text).join("\n");
  assert.doesNotMatch(prompts, /Taylor Example|taylor@example\.test|\+44 7700 900000|Synthetic verified evidence/);
  assert.doesNotMatch(prompts, /candidate_background|profile_snapshot_hash|evidence_ids|evidence_keys/);
  const cvResponse = {
    schema_version: "2.0", source_mode: "chatgpt_memory", document_kind: "cv", application_id: applicationId,
    input_hash: frozen.inputHash, contact: {}, headline: "Engineering researcher", headline_memory_support: ["Prior discussion of engineering research"],
    profile: { text: "An engineering researcher with modelling experience.", memory_support: ["Prior discussion of modelling work"] },
    skills: [{ category: "Technical", memory_support: ["Prior discussion of technical skills"], items: [{ text: "Python", memory_support: ["Prior discussion of Python"] }] }],
    experience: [{ role: "Research Engineer", company: "Example Employer", dates: "2020–2024", location: "", memory_support: ["Prior discussion of this role"],
      bullets: [{ text: "Built and validated numerical models.", memory_support: ["Prior discussion of modelling work"] }] }],
    projects: [], education: [], publications: [], tailoring: { gaps: "Check all dates and details." },
  };
  const validated = validateDocumentResponse(cvResponse, "cv", applicationId, frozen.inputHash, [], "engineering", job, trustedDocumentContact(profile), true);
  assert.equal(validated.structured.engine_version, "chatgpt-memory-v4");
  assert.equal(validated.structured.memory_review_required, true);
  assert.equal(validated.evidenceLinks.length, 0);
  assert.equal(validated.structured.candidate.email, "taylor@example.test");
  assert.throws(() => validateDocumentResponse({ ...cvResponse, experience: [{ ...cvResponse.experience[0], bullets: [{ text: "Unsupported claim", memory_support: [] }] }] },
    "cv", applicationId, frozen.inputHash, [], "engineering", job, trustedDocumentContact(profile), true), /no Memory support/);
});

test("Memory-only cover-letter response stays contact-free and adds verified local contact only to the saved text", async () => {
  const frozen = await buildDocumentGenerationContext({
    kinds: ["cover_letter"], applicationId, templateId: "modern-teal", profile, job, cvFamily: "engineering",
  });
  const paragraphs = [
    "My remembered engineering work has focused on understanding how analytical models represent real systems and where their assumptions matter. I have approached technical problems by breaking them into manageable questions, checking the information available, and explaining the reasoning behind a proposed solution. That careful method is relevant to a simulation role, where useful results depend on both sound implementation and a clear account of uncertainty. I would bring curiosity, patience and a practical interest in improving engineering decisions.",
    "I also recall working with computational tools to organise technical information and make analysis repeatable. In that work, I valued simple checks that exposed errors early and clear notes that helped another person follow the result. Those habits would support collaboration with engineers who need reliable models and understandable conclusions. I would take time to learn the team's established methods, contribute consistently, and ask focused questions when the evidence or assumptions do not support a confident answer.",
    "The opportunity appeals to me because it connects detailed analysis with outcomes that people can use. I would contribute a thoughtful approach to model development, validation and communication, while remaining open about the limits of what I know. My remembered background is not a substitute for checking specific dates, tools or achievements, so this draft should be reviewed against the underlying facts before it is used. I would welcome a conversation about the work and the evidence the team considers most useful.",
  ];
  const responseLetter = {
    schema_version: "2.0", source_mode: "chatgpt_memory", document_kind: "cover_letter",
    application_id: applicationId, input_hash: frozen.inputHash, recipient: "", salutation: "Dear Hiring Manager,",
    paragraphs: paragraphs.map((text) => ({ text, memory_support: ["Synthetic controlled Memory fixture for the document workflow test."], material: true })),
    closing: "Yours sincerely,", candidate_name: "",
  };
  responseLetter.plaintext = [responseLetter.salutation, ...paragraphs, responseLetter.closing].join("\n\n");
  const rawResponse = JSON.stringify(responseLetter);
  assert.doesNotMatch(rawResponse, /Taylor Example|taylor@example\.test|\+44 7700 900000/);
  const validated = validateDocumentResponse(
    responseLetter, "cover_letter", applicationId, frozen.inputHash, [], "engineering", job, trustedDocumentContact(profile), true,
  );
  assert.equal(validated.structured.engine_version, "chatgpt-memory-v4");
  assert.equal(validated.structured.memory_review_required, true);
  assert.equal(validated.structured.candidate_name, "Taylor Example");
  assert.equal(validated.structured.candidate_email, "taylor@example.test");
  assert.equal(validated.structured.candidate_phone, "+44 7700 900000");
  assert.match(validated.plaintext, /Yours sincerely,\n\nTaylor Example$/);
  assert.doesNotMatch(validated.plaintext, /taylor@example\.test|\+44 7700 900000/);
  assert.equal(validated.structured.plaintext, validated.plaintext);
});

test("all eight paired themes render the shared fictional CV and letter with A4, ordered text and theme identity", async (t) => {
  assert.equal(DOCUMENT_TEMPLATES.length, 8);
  assert.equal(new Set(DOCUMENT_TEMPLATES.map((theme) => theme.id)).size, 8);
  assert.equal(DEFAULT_DOCUMENT_TEMPLATE, "classic-navy");
  assert.ok(DOCUMENT_TEMPLATES.every((theme) => isDocumentTemplateId(theme.id)));
  if (!pdftotextAvailable) t.diagnostic("pdftotext was unavailable; PDF extraction and reading-order checks were skipped.");

  const keepArtifacts = Boolean(process.env.DOCUMENT_RENDER_TEST_OUTDIR);
  const outputDir = keepArtifacts ? process.env.DOCUMENT_RENDER_TEST_OUTDIR : await mkdtemp(join(tmpdir(), "jobhunt-m06-document-render-"));
  await mkdir(outputDir, { recursive: true });
  try {
    for (const theme of DOCUMENT_TEMPLATES) {
      const cvFiles = await renderApplicationDocument("cv", DOCUMENT_PREVIEW_CV, theme.id);
      const cvPdf = await PDFDocument.load(cvFiles.pdf);
      assert.equal(cvPdf.getPageCount(), 2, theme.name + " CV PDF page count");
      assert.equal(cvFiles.quality.pageCount, 2);
      assert.ok(cvFiles.quality.pageUsage[1] >= 0.4, theme.name + " CV second-page balance");
      assert.equal(cvFiles.quality.templateId, theme.id);
      assert.equal(cvFiles.quality.docxFont, theme.font);
      assert.equal(cvFiles.quality.pdfFont, theme.pdfFont);
      assert.equal(cvFiles.pdf.subarray(0, 4).toString("ascii"), "%PDF");
      assert.equal(cvFiles.docx.subarray(0, 2).toString("ascii"), "PK");
      for (const page of cvPdf.getPages()) {
        const size = page.getSize();
        assert.ok(Math.abs(size.width - 595.28) < 0.02, theme.name + " CV PDF A4 width");
        assert.ok(Math.abs(size.height - 841.89) < 0.02, theme.name + " CV PDF A4 height");
      }

      const letterFiles = await renderApplicationDocument("cover_letter", DOCUMENT_PREVIEW_LETTER, theme.id);
      const letterPdf = await PDFDocument.load(letterFiles.pdf);
      assert.equal(letterPdf.getPageCount(), 1, theme.name + " cover-letter PDF page count");
      assert.equal(letterFiles.quality.pageCount, 1);
      assert.equal(letterFiles.quality.templateId, theme.id);
      assert.equal(letterFiles.pdf.subarray(0, 4).toString("ascii"), "%PDF");
      assert.equal(letterFiles.docx.subarray(0, 2).toString("ascii"), "PK");
      const letterSize = letterPdf.getPage(0).getSize();
      assert.ok(Math.abs(letterSize.width - 595.28) < 0.02, theme.name + " letter PDF A4 width");
      assert.ok(Math.abs(letterSize.height - 841.89) < 0.02, theme.name + " letter PDF A4 height");

      const cvDocx = new TextDecoder().decode(unzipSync(cvFiles.docx)["word/document.xml"]);
      const letterDocx = new TextDecoder().decode(unzipSync(letterFiles.docx)["word/document.xml"]);
      assertDocxA4(cvDocx, theme.name + " CV DOCX");
      assertDocxA4(letterDocx, theme.name + " letter DOCX");
      assert.ok(cvDocx.includes('w:ascii="' + theme.font + '"'), theme.name + " CV DOCX font");
      assert.ok(letterDocx.includes('w:ascii="' + theme.font + '"'), theme.name + " letter DOCX font");
      assertReadingOrder(docxText(cvDocx), ["Taylor Example", "Engineering researcher", "PROFILE", "EXPERIENCE", "Senior Research Engineer", "Research Associate", "TECHNICAL SKILLS", "SELECTED TECHNICAL WORK", "EDUCATION AND DEVELOPMENT", "RESEARCH COMMUNICATION"], theme.name + " CV DOCX");
      assertReadingOrder(docxText(letterDocx), ["Taylor Example", "Fixture Engineering", "Simulation Engineer", "Dear Hiring Manager,", DOCUMENT_PREVIEW_LETTER.paragraphs[0].text, "Yours sincerely,"], theme.name + " letter DOCX");

      const prefix = join(outputDir, theme.id);
      await writeFile(prefix + "-cv.pdf", cvFiles.pdf);
      await writeFile(prefix + "-cv.docx", cvFiles.docx);
      await writeFile(prefix + "-letter.pdf", letterFiles.pdf);
      await writeFile(prefix + "-letter.docx", letterFiles.docx);
      if (pdftotextAvailable) {
        const cvText = execFileSync(pdftotextBin, ["-layout", prefix + "-cv.pdf", "-"], { encoding: "utf8" });
        const letterText = execFileSync(pdftotextBin, ["-layout", prefix + "-letter.pdf", "-"], { encoding: "utf8" });
        assertReadingOrder(cvText, ["Taylor Example", "Engineering researcher", "taylor@example.test", "PROFILE", "Engineer with verified", "EXPERIENCE", "Senior Research Engineer", "Research Associate", "TECHNICAL SKILLS", "SELECTED TECHNICAL WORK", "EDUCATION AND DEVELOPMENT", "RESEARCH COMMUNICATION"], theme.name + " CV PDF");
        assertReadingOrder(letterText, ["Taylor Example", "Fixture Engineering", "Simulation Engineer", "Dear Hiring Manager,", DOCUMENT_PREVIEW_LETTER.paragraphs[0].text, "Yours sincerely,"], theme.name + " letter PDF");
      }
    }
    t.diagnostic("Generated all eight themes from one fictional CV and letter in " + outputDir);
  } finally {
    if (!keepArtifacts) await rm(outputDir, { recursive: true, force: true });
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
  const hugeLetter = { ...DOCUMENT_PREVIEW_LETTER, paragraphs: [{ text: "evidence ".repeat(10000) }] };
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
  const paragraphs = [
    "I am applying for this Simulation Engineer role because it brings together the numerical modelling and practical engineering questions that I have discussed in my professional background. My remembered experience includes building computational models, checking assumptions against reference evidence, and explaining where conclusions are reliable. I am interested in using that careful, evidence-led approach on the responsibilities described for Fixture Engineering and contributing to decisions grounded in sound analysis.",
    "In previous engineering and research work, I have used numerical methods to investigate technical problems and to compare model outputs with relevant reference data. I have learned to document assumptions, investigate unexpected results, and communicate limitations alongside conclusions. This combination helps colleagues understand not only what a model predicts, but also how much confidence they should place in it when choosing what to test or develop next.",
    "I would bring a methodical approach to the modelling responsibilities in the vacancy, together with the ability to explain technical findings clearly to people with different areas of expertise. The work appeals to me because it connects rigorous analysis with practical engineering outcomes. I would aim to understand the team's specific methods and priorities while contributing the relevant capabilities I can substantiate from my background.",
    "The opportunity at Fixture Engineering is particularly attractive because the advertised role centres on applying technical analysis to meaningful engineering decisions. I would welcome the chance to discuss how my remembered experience in modelling, validation, and technical communication could support the work described in the listing. I will verify every personal claim in this draft before using it and will add any missing details myself.",
  ];
  const rawResponse = JSON.stringify({
    schema_version: "2.0", source_mode: "chatgpt_memory", document_kind: "cover_letter", application_id: applicationId,
    input_hash: frozen.inputHash, recipient: "", salutation: "Dear Hiring Manager,",
    paragraphs: paragraphs.map((text) => ({ text, memory_support: ["Recalled professional background relevant to engineering modelling"], material: true })),
    closing: "Yours sincerely,",
    plaintext: ["Dear Hiring Manager,", ...paragraphs, "Yours sincerely,"].join("\n\n"),
  });
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
  let versionCreateCalls = 0;
  let finalizeCalls = 0;
  let secondUploadFinished = false;
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
        versionCreateCalls++;
        createdVersionId ||= versionId;
        return { data: { document_version_id: createdVersionId, version_number: 1 }, error: null };
      }
      if (name === "finalize_application_document_item") { finalizeCalls++; return { data: { ready: true }, error: null }; }
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
            if (key.endsWith("cover_letter.docx")) await new Promise((resolve) => setTimeout(resolve, 25));
            stored.set(key, new Blob([bytes]));
            if (key.endsWith("cover_letter.docx")) secondUploadFinished = true;
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
  assert.equal(secondUploadFinished, true, "recovery waits for both concurrent Storage uploads to settle before retrying");
  assert.equal(item.response_hash?.length, 64, "the exact response hash is durably captured before file upload");
  assert.equal(item.response_text, rawResponse);
  assert.equal(savedResponseCalls, 1);

  const recovered = await advanceDocumentGeneration(supabase, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", request, [item], 0, dispatchId);
  assert.equal(recovered.capturedDocument, true);
  assert.equal(recovered.finalized.ready, true);
  assert.equal(savedResponseCalls, 1, "retry does not recapture or resend the original assistant response");
  assert.equal(versionCreateCalls, 2, "retry uses the same saved response and idempotent version RPC");
  assert.equal(finalizeCalls, 1, "the document finalizes only after both exact assets verify");
  assert.equal(calls.filter((call) => call.name === "get_chatgpt_dispatch_request").length, 2);
  assert.equal(calls.some((call) => /dispatch|send/i.test(call.name) && call.name !== "get_chatgpt_dispatch_request" && call.name !== "record_application_document_dispatch"), false);
  assert.equal(calls.find((call) => call.name === "create_application_document_version")?.args.p_structured_content.document_template_id, request.template_id);
  assert.equal(calls.find((call) => call.name === "finalize_application_document_item")?.args.p_structured_content.document_template_id, request.template_id);
  assert.ok([...stored.keys()].some((key) => key.endsWith("cover_letter.pdf")));
  assert.ok([...stored.keys()].some((key) => key.endsWith("cover_letter.docx")));
});
