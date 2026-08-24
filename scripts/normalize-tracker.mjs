import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "data/imports/job-application-tracker.sample.csv");
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, "data/imports/tracker.normalized.json");

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function applicationState(status, stage) {
  const s = `${status} ${stage}`.toLowerCase();
  if (s.includes("rejected") || s.includes("closed")) return "rejected";
  if (s.includes("assessment")) return "assessment";
  if (s.includes("interview")) return "interview";
  if (s.includes("offer")) return "offer";
  if (s.includes("withdraw")) return "withdrawn";
  return "awaiting_response";
}

function externalJobId(role) {
  const matches = [...role.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim());
  for (const candidate of matches.reverse()) {
    if (/^(?:ID\s*)?[A-Z]{0,4}\d{3,}$/i.test(candidate)) return candidate.replace(/^ID\s*/i, "");
  }
  const ref = role.match(/\bRef\s+([A-Z0-9-]{4,})\b/i);
  return ref?.[1] ?? null;
}

const csv = await fs.readFile(inputPath, "utf8");
const rows = parseCsv(csv);
if (rows.length < 2) throw new Error("Tracker CSV contained no data rows");

const headers = rows[0];
const index = Object.fromEntries(headers.map((h, i) => [h, i]));
const value = (row, key) => row[index[key]]?.trim() ?? "";

const records = rows.slice(1).map((row, offset) => {
  const status = value(row, "Status");
  const stage = value(row, "Stage");
  const notesRaw = value(row, "Notes");
  return {
    sourceRow: offset + 2,
    company: value(row, "Company"),
    role: value(row, "Role"),
    externalJobId: externalJobId(value(row, "Role")),
    applicationDate: value(row, "Application Date") || null,
    lastEmail: value(row, "Last Email") || null,
    status,
    stage,
    priority: value(row, "Priority") || "Medium",
    nextAction: value(row, "Next Action") || null,
    deadline: value(row, "Deadline / Follow-up") || null,
    daysSinceUpdate: Number(value(row, "Days Since Update")) || null,
    notes: notesRaw === "#VALUE!" ? "Tracker note contained a spreadsheet formula error at snapshot time." : notesRaw || null,
    emailSource: value(row, "Email Source") || null,
    applicationState: applicationState(status, stage),
  };
});

const summary = {
  total: records.length,
  actionRequired: records.filter((r) => r.status === "Action Required").length,
  underReview: records.filter((r) => r.status === "Under Review").length,
  received: records.filter((r) => r.status === "Received").length,
  rejected: records.filter((r) => r.applicationState === "rejected").length,
  assessments: records.filter((r) => r.applicationState === "assessment").length,
  interviews: records.filter((r) => r.applicationState === "interview").length,
};

const qualityIssues = [];
for (const record of records) {
  if (/not identified/i.test(record.company)) {
    qualityIssues.push({ sourceRow: record.sourceRow, code: "unknown_company", severity: "warning", message: `Employer is not identified for ${record.role}.` });
  }
  if (/role not identified/i.test(record.role)) {
    qualityIssues.push({ sourceRow: record.sourceRow, code: "unknown_role", severity: "warning", message: `Role is not identified for ${record.company}.` });
  }
  if (/spreadsheet formula error/i.test(record.notes || "")) {
    qualityIssues.push({ sourceRow: record.sourceRow, code: "source_formula_error", severity: "info", message: `${record.company} has a tracker note that originated from a spreadsheet formula error.` });
  }
}
const seenRows = new Set();
for (const record of records) {
  if (seenRows.has(record.sourceRow)) {
    qualityIssues.push({ sourceRow: record.sourceRow, code: "duplicate_source_row", severity: "error", message: `Duplicate source row ${record.sourceRow}.` });
  }
  seenRows.add(record.sourceRow);
}

const quality = {
  issueCount: qualityIssues.length,
  errorCount: qualityIssues.filter((issue) => issue.severity === "error").length,
  warningCount: qualityIssues.filter((issue) => issue.severity === "warning").length,
  infoCount: qualityIssues.filter((issue) => issue.severity === "info").length,
  issues: qualityIssues,
};

const normalized = {
  schemaVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  source: {
    type: "google_sheet_snapshot",
    title: "Job Application Tracker",
    spreadsheetId: "1WP7j3YjIko_NO_UHQqQttoeTf6KUxIcgq4MhBXJWc8w",
    sheet: "Applications",
  },
  summary,
  quality,
  records,
};

await fs.writeFile(outputPath, JSON.stringify(normalized, null, 2) + "\n");
console.log(`Tracker snapshot written to ${outputPath}`);
console.log(`${summary.total} applications: ${summary.assessments} assessment, ${summary.underReview} under review, ${summary.rejected} rejected`);
