import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8, zlibSync } from "fflate";
import { detectDocumentFormat, extractDocumentText } from "./document-parser.ts";

const resumeText = [
  "Fictional candidate: Alex Example",
  "EXPERIENCE",
  "Data Quality Engineer at Northstar Analytics — Jan 2022 to Dec 2024",
  "- Built synthetic quality checks for sample datasets.",
  "EDUCATION",
  "BSc Software Engineering, Ada Lovelace University, 2018 to 2021",
  "SKILLS",
  "Python, TypeScript, PostgreSQL",
].join("\n");

function pdfBytes(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const content = "BT /F1 12 Tf 50 700 Td (" + escaped + ") Tj ET";
  return new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream\nendobj\n%%EOF");
}

function docxBytes(text) {
  const paragraphs = text.split("\n").map((line) => "<w:p><w:r><w:t>" + line.replaceAll("&", "&amp;").replaceAll("<", "&lt;") + "</w:t></w:r></w:p>").join("");
  return zipSync({ "word/document.xml": strToU8("<w:document>" + paragraphs + "</w:document>") });
}

function compressedPdfBytes(text) {
  const compressed = zlibSync(new TextEncoder().encode(text));
  const prefix = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length " + compressed.byteLength + " >>\nstream\n");
  const suffix = new TextEncoder().encode("\nendstream\nendobj\n%%EOF");
  const bytes = new Uint8Array(prefix.byteLength + compressed.byteLength + suffix.byteLength);
  bytes.set(prefix, 0);
  bytes.set(compressed, prefix.byteLength);
  bytes.set(suffix, prefix.byteLength + compressed.byteLength);
  return bytes;
}

test("detects all requested professional source formats", () => {
  assert.equal(detectDocumentFormat("resume.pdf", "application/pdf"), "pdf");
  assert.equal(detectDocumentFormat("resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(detectDocumentFormat("resume.txt", "text/plain"), "txt");
  assert.equal(detectDocumentFormat("resume.markdown", "text/markdown"), "markdown");
  assert.equal(detectDocumentFormat("resume.rtf", "application/rtf"), "rtf");
});

test("extracts text from PDF, DOCX, TXT, Markdown and RTF fixtures", () => {
  const fixtures = [
    ["resume.pdf", "application/pdf", pdfBytes(resumeText)],
    ["resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docxBytes(resumeText)],
    ["resume.txt", "text/plain", new TextEncoder().encode(resumeText)],
    ["resume.md", "text/markdown", new TextEncoder().encode(resumeText)],
    ["resume.rtf", "application/rtf", new TextEncoder().encode("{\\rtf1\\ansi " + resumeText.replaceAll("\n", "\\par ") + "}")],
  ];
  for (const [name, mime, bytes] of fixtures) {
    const result = extractDocumentText(bytes, name, mime);
    assert.equal(result.error, null, name + " should be readable");
    assert.equal(result.format, detectDocumentFormat(name, mime));
    assert.match(result.text, /Northstar Analytics/, name + " should preserve its employer text");
    assert.match(result.text, /Ada Lovelace University/, name + " should preserve its education text");
  }
});

test("malformed and image-only documents produce a recoverable extraction error", () => {
  const malformed = extractDocumentText(new Uint8Array([0, 1, 2, 3]), "scan.pdf", "application/pdf");
  assert.equal(malformed.format, "pdf");
  assert.ok(malformed.error);
  assert.equal(extractDocumentText(new TextEncoder().encode("not a supported document"), "resume.bin").format, null);
});

test("bounds expansion of compressed DOCX and PDF content", () => {
  const oversizedXml = "<w:document>" + "x".repeat(2 * 1024 * 1024 + 1) + "</w:document>";
  const docx = extractDocumentText(docxBytes(oversizedXml), "large.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(docx.error || "", /safe extraction limit/);

  const pdf = extractDocumentText(compressedPdfBytes("x".repeat(600 * 1024)), "large.pdf", "application/pdf");
  assert.match(pdf.error || "", /safe per-stream limit/);
});
