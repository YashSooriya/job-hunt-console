import { createHash } from "node:crypto";

export const JOB_POOL_SHEET_HEADERS = [
  "Job ID",
  "Company",
  "Job title",
  "Industry",
  "External job ID",
  "Listing URL",
  "Application URL",
  "Location",
  "Work mode",
  "Salary",
  "Salary minimum",
  "Salary maximum",
  "Salary currency",
  "Date posted",
  "Closing date",
  "Employment type",
  "User status",
  "AI triage",
] as const;

export type JobPoolSheetRow = readonly (string | number)[];

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function number(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "";
}

function iso(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? text(value, 80) : parsed.toISOString();
}

export function jobPoolSheetValues(records: Array<Record<string, any>>) {
  const rows = records.map((record): JobPoolSheetRow => {
    const companyValue = record.companies;
    const company = Array.isArray(companyValue) ? companyValue[0] : companyValue;
    return [
      text(record.id, 80),
      text(company?.canonical_name ?? record.company_name, 240),
      text(record.title, 300),
      text(record.industry, 160),
      text(record.external_job_id, 160),
      text(record.source_url, 2000),
      text(record.application_url, 2000),
      text(record.location_text, 500),
      text(record.work_mode, 100),
      text(record.salary_text, 500),
      number(record.salary_min),
      number(record.salary_max),
      text(record.salary_currency || "GBP", 12),
      iso(record.posted_at),
      iso(record.closes_at),
      text(record.employment_type, 100),
      text(record.user_status || "new", 40),
      text(record.triage, 40),
    ];
  });
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return [JOB_POOL_SHEET_HEADERS, ...rows];
}

/** Sheets omits trailing blank cells; restore the fixed-width row contract. */
export function normalizeJobPoolSheetValues(values: unknown, columnCount = JOB_POOL_SHEET_HEADERS.length): JobPoolSheetRow[] {
  if (!Array.isArray(values)) return [];
  return values.map((raw) => {
    const row = Array.isArray(raw) ? raw.slice(0, columnCount) : [];
    while (row.length < columnCount) row.push("");
    return row.map((value) => value === null || value === undefined ? "" : value) as JobPoolSheetRow;
  });
}

/** Read only rows that exist in the tab's grid, capped at the supported pool bound. */
export function boundedJobPoolReadRows(gridRows: unknown, maxRows: number, fallbackRows = 1_000) {
  const ceiling = Number.isSafeInteger(maxRows) && maxRows > 0 ? maxRows : 1;
  const fallback = Number.isSafeInteger(fallbackRows) && fallbackRows > 0 ? fallbackRows : 1;
  const parsed = typeof gridRows === "number" ? gridRows : Number(gridRows);
  const availableRows = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(availableRows, ceiling));
}

export function hashJobPoolSheetValues(values: JobPoolSheetRow[]) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** Build bounded Sheets API requests; one large pool never becomes one huge request. */
export function chunkJobPoolValues(values: JobPoolSheetRow[], maxBytes = 1_500_000) {
  const chunks: Array<{ startRow: number; values: JobPoolSheetRow[] }> = [];
  let current: JobPoolSheetRow[] = [];
  let currentBytes = 0;
  let startRow = 0;
  const encoder = new TextEncoder();
  for (let index = 0; index < values.length; index += 1) {
    const row = values[index];
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (rowBytes > maxBytes - 256) throw new Error("A job-pool Sheet row exceeds the safe Google Sheets request size.");
    if (current.length && currentBytes + rowBytes > maxBytes - 256) {
      chunks.push({ startRow, values: current });
      startRow = index;
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length) chunks.push({ startRow, values: current });
  return chunks;
}

export type ExpectedJobPoolSnapshot = {
  publicationId: string;
  revision: number;
  rowCount: number;
  verificationToken: string;
};

export type JobPoolPublicationStatus = {
  configured: boolean;
  lastSyncStatus: string;
  sourceRevision: number;
  publishedRevision: number | null;
  driveVerifiedAt: string | null;
  driveVerifiedVersion: string | null;
  driveFileVersion: string | null;
  driveCheckActive: boolean;
};

/** Match the same short-lived Drive-version proof required by search dispatch. */
export function isCurrentJobPoolPublication(status: JobPoolPublicationStatus, now = Date.now()) {
  if (!status.configured || status.lastSyncStatus !== "ok"
    || status.publishedRevision === null || status.sourceRevision !== status.publishedRevision
    || status.driveCheckActive || !status.driveFileVersion
    || status.driveVerifiedVersion !== status.driveFileVersion || !status.driveVerifiedAt) return false;
  const verifiedAt = Date.parse(status.driveVerifiedAt);
  const age = now - verifiedAt;
  return Number.isFinite(verifiedAt) && age >= 0 && age < 120_000;
}

export function parseJobPoolSnapshotProof(value: unknown, expected: ExpectedJobPoolSnapshot) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ChatGPT did not return the required job-pool Sheet verification object.");
  const proof = value as Record<string, unknown>;
  const allowed = new Set(["publication_id", "revision", "access_check_token", "rows_read"]);
  for (const key of Object.keys(proof)) if (!allowed.has(key)) throw new Error(`The job-pool Sheet verification included unsupported field ${key}.`);
  if (proof.publication_id !== expected.publicationId || proof.revision !== expected.revision) {
    throw new Error("ChatGPT read a different job-pool Sheet snapshot. No vacancies were imported.");
  }
  if (proof.access_check_token !== expected.verificationToken) {
    throw new Error("ChatGPT could not verify access to the connected Google Sheet. Connect Google Drive in ChatGPT, then retry; no vacancies were imported.");
  }
  if (proof.rows_read !== expected.rowCount) {
    throw new Error(`ChatGPT confirmed reading ${String(proof.rows_read)} of ${expected.rowCount} active job rows. No vacancies were imported; retry after checking Google Drive access.`);
  }
  return {
    publicationId: expected.publicationId,
    revision: expected.revision,
    rowCount: expected.rowCount,
    verificationToken: expected.verificationToken,
  };
}

export function parseJobPoolAccessTestResponse(textValue: string, expected: ExpectedJobPoolSnapshot) {
  const trimmed = textValue.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed: unknown;
  try { parsed = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { throw new Error("ChatGPT did not return the access-test JSON. Reconnect Google Drive in ChatGPT and run the test again."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ChatGPT's access-test response was not one JSON object.");
  const response = parsed as Record<string, unknown>;
  const allowed = new Set(["access_test", "publication_id", "revision", "row_count", "access_check_token"]);
  for (const key of Object.keys(response)) if (!allowed.has(key)) throw new Error(`The Sheet access test included unsupported field ${key}.`);
  if (response.access_test !== "ok") throw new Error("ChatGPT could not access the connected Google Sheet. Connect Google Drive in ChatGPT, then retry.");
  if (response.publication_id !== expected.publicationId || response.revision !== expected.revision || response.row_count !== expected.rowCount || response.access_check_token !== expected.verificationToken) {
    throw new Error("ChatGPT did not verify the current Job Pool Sheet manifest. Check its Google Drive connection and retry.");
  }
  return { verified: true as const };
}
