import "server-only";
import { refreshGoogleAccessToken } from "@/lib/gmail-api";
import {
  applicationManifestHash,
  applicationSheetHash,
  applicationSheetPublicationDecision,
  normalizeApplicationValues,
} from "@/lib/application-sheet-contract";

const SHEETS_API = "https://sheets.googleapis.com/v4";
const TRACKER_HEADERS = [
  "Application ID", "Company", "Role", "External job ID", "Application date", "Last relevant email",
  "Status", "Stage", "Priority", "Next action", "Deadline", "Notes", "Email source",
];

export type TrackerSheetRow = {
  applicationId: string;
  company: string | null;
  role: string | null;
  externalJobId?: string | null;
  applicationDate?: string | null;
  lastEmail?: string | null;
  status?: string | null;
  stage?: string | null;
  priority?: string | null;
  nextAction?: string | null;
  deadline?: string | null;
  notes?: string | null;
  emailSource?: string | null;
};

type SpreadsheetResponse = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
};

type SpreadsheetBatchUpdateResponse = {
  replies?: Array<{ addSheet?: { properties?: { sheetId?: number; title?: string } } }>;
};

function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function googleAccessError(status: number, payload: any) {
  if (status === 401) return "google_access_token_rejected";
  const reason = [payload?.error?.status, ...(payload?.error?.errors || []).map((item: any) => item?.reason), payload?.error?.message]
    .filter(Boolean).join(" ");
  if (status === 403 && /scope|insufficient.?auth|insufficient.?permission/i.test(reason)) return "google_permission_required";
  if (status === 403 || status === 404) return "google_sheet_not_accessible";
  return "";
}

function spreadsheetId(value: unknown) {
  const id = cleanText(value, 200);
  return /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : "";
}

function quoteSheetName(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sheetRange(sheetName: string, range: string) {
  return `${quoteSheetName(sheetName)}!${range}`;
}

async function googleJson<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  const accessError = googleAccessError(response.status, payload);
  if (accessError) throw new Error(accessError);
  if (!response.ok) {
    const detail = cleanText((payload as any)?.error?.message, 240);
    throw new Error(detail ? `google_sheets_${response.status}: ${detail}` : `google_sheets_${response.status}`);
  }
  return payload as T;
}

async function googleEmpty(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const accessError = googleAccessError(response.status, payload);
    if (accessError) throw new Error(accessError);
    const detail = cleanText((payload as any)?.error?.message, 240);
    throw new Error(detail ? `google_sheets_${response.status}: ${detail}` : `google_sheets_${response.status}`);
  }
}

export function trackerRowsFromRecords(records: Array<Record<string, any>>): TrackerSheetRow[] {
  return records.map((record) => ({
    applicationId: cleanText(record.applicationId || record.id, 120),
    company: cleanText(record.company, 240) || null,
    role: cleanText(record.role, 300) || null,
    externalJobId: cleanText(record.externalJobId, 160) || null,
    applicationDate: cleanText(record.applicationDate, 80) || null,
    lastEmail: cleanText(record.lastEmail, 80) || null,
    status: cleanText(record.status, 100) || null,
    stage: cleanText(record.stage || record.applicationState, 120) || null,
    priority: cleanText(record.priority, 80) || null,
    nextAction: cleanText(record.nextAction, 500) || null,
    deadline: cleanText(record.deadline, 80) || null,
    notes: cleanText(record.notes, 1000) || null,
    emailSource: cleanText(record.emailSource, 120) || null,
  }));
}

function trackerValues(rows: TrackerSheetRow[]) {
  return [
    TRACKER_HEADERS,
    ...rows.map((row) => [
      row.applicationId, row.company || "", row.role || "", row.externalJobId || "", row.applicationDate || "", row.lastEmail || "",
      row.status || "", row.stage || "", row.priority || "", row.nextAction || "", row.deadline || "", row.notes || "", row.emailSource || "",
    ]),
  ];
}

async function spreadsheetMetadata(accessToken: string, spreadsheetId: string) {
  return googleJson<SpreadsheetResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`, accessToken);
}

async function formatTrackerSheet(accessToken: string, spreadsheetId: string, sheetId: number, columnCount = TRACKER_HEADERS.length) {
  const requests: Record<string, unknown>[] = [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.12, green: 0.27, blue: 0.42 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: columnCount } } },
  ];
  if (columnCount === TRACKER_HEADERS.length) {
    requests.push(
      { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 170 }, fields: "pixelSize" } },
      { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 3 }, properties: { pixelSize: 220 }, fields: "pixelSize" } },
      { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 12 }, properties: { pixelSize: 190 }, fields: "pixelSize" } },
    );
  }
  await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

async function ensureManagedTrackerTab(accessToken: string, spreadsheetId: string, requestedTab: string) {
  const metadata = await spreadsheetMetadata(accessToken, spreadsheetId);
  const existing = metadata.sheets?.map((sheet) => sheet.properties).find((properties) => properties?.title === requestedTab);
  if (existing?.title && existing.sheetId != null) return existing;

  const created = await googleJson<SpreadsheetBatchUpdateResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: requestedTab } } }] }),
  });
  const properties = created.replies?.[0]?.addSheet?.properties;
  if (!properties?.title || properties.sheetId == null) throw new Error("google_sheet_tab_create_missing_id");
  return properties;
}

async function writeApplicationStage(accessToken: string, spreadsheetId: string, values: unknown[][], manifest: unknown[][]) {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const dataTitle = `_jhc_apps_data_${suffix}`;
  const manifestTitle = `_jhc_apps_manifest_${suffix}`;
  const created = await googleJson<SpreadsheetBatchUpdateResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests: [
      { addSheet: { properties: { title: dataTitle, gridProperties: { rowCount: Math.max(1000, values.length), columnCount: TRACKER_HEADERS.length, frozenRowCount: 1 } } } },
      { addSheet: { properties: { title: manifestTitle, gridProperties: { rowCount: 20, columnCount: 2, frozenRowCount: 1 } } } },
    ] }),
  });
  const data = created.replies?.[0]?.addSheet?.properties;
  const manifestSheet = created.replies?.[1]?.addSheet?.properties;
  if (data?.sheetId == null || manifestSheet?.sheetId == null) throw new Error("google_sheet_tab_create_missing_id");
  try {
    await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data: [
        { range: sheetRange(dataTitle, `A1:M${Math.max(1, values.length)}`), majorDimension: "ROWS", values },
        { range: sheetRange(manifestTitle, `A1:B${manifest.length}`), majorDimension: "ROWS", values: manifest },
      ] }),
    });
    const readback = normalizeApplicationValues(await readSheetValues(accessToken, spreadsheetId, dataTitle, `A1:M${Math.max(1, values.length)}`), TRACKER_HEADERS.length);
    const manifestReadback = await readSheetValues(accessToken, spreadsheetId, manifestTitle, `A1:B${manifest.length}`);
    const expectedHash = applicationSheetHash(values);
    if (applicationSheetHash(readback) !== expectedHash || applicationManifestHash(manifestReadback) !== expectedHash || readback.length !== values.length) {
      throw new Error("google_sheet_applications_hash_mismatch");
    }
    await formatTrackerSheet(accessToken, spreadsheetId, data.sheetId);
    await formatTrackerSheet(accessToken, spreadsheetId, manifestSheet.sheetId, 2);
  } catch (error) {
    await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: data.sheetId } }, { deleteSheet: { sheetId: manifestSheet.sheetId } }] }),
    }).catch(() => undefined);
    throw error;
  }
  return {
    data: { title: dataTitle, sheetId: data.sheetId },
    manifest: { title: manifestTitle, sheetId: manifestSheet.sheetId },
    suffix,
  };
}

async function removeApplicationStage(accessToken: string, spreadsheetId: string, stage: { data: { sheetId: number }; manifest: { sheetId: number } }) {
  await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: stage.data.sheetId } }, { deleteSheet: { sheetId: stage.manifest.sheetId } }] }),
  }).catch(() => undefined);
}

async function readSheetValues(accessToken: string, spreadsheetId: string, tab: string, range: string) {
  const result = await googleJson<any>(
    `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetRange(tab, range))}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    accessToken,
  );
  return Array.isArray(result.values) ? result.values as unknown[][] : [];
}

async function ensureTrackerTab(accessToken: string, spreadsheetId: string, title: string, headers: readonly string[]) {
  const metadata = await spreadsheetMetadata(accessToken, spreadsheetId);
  let tab = metadata.sheets?.map((item) => item.properties).find((item) => item?.title === title);
  if (!tab?.title) tab = await ensureManagedTrackerTab(accessToken, spreadsheetId, title);
  if (tab.sheetId == null) throw new Error("google_sheet_tab_conflict");
  const range = `A1:${String.fromCharCode(64 + headers.length)}1`;
  const values = await readSheetValues(accessToken, spreadsheetId, title, range);
  const current = Array.isArray(values[0]) ? values[0].map((value) => String(value ?? "")) : [];
  if (current.some(Boolean) && headers.some((header, index) => current[index] !== header)) {
    throw new Error("google_sheet_tab_conflict");
  }
  if (!tab.title || tab.sheetId == null) throw new Error("google_sheet_tab_conflict");
  return { title: tab.title, sheetId: tab.sheetId };
}

export async function writeTrackerSpreadsheet(accessToken: string, spreadsheetId: string, requestedTab: string, rows: TrackerSheetRow[], expectedContentHash: string | null = null) {
  if (requestedTab !== "Applications") throw new Error("managed_workbook_only");
  const tab = await ensureTrackerTab(accessToken, spreadsheetId, requestedTab, TRACKER_HEADERS);
  const manifestTab = await ensureTrackerTab(accessToken, spreadsheetId, "Applications Manifest", ["Field", "Value"]);
  const values = trackerValues(rows);
  const contentHash = applicationSheetHash(values);
  const manifest = [
    ["Field", "Value"],
    ["schema_version", "2"],
    ["source", "Supabase"],
    ["content_hash", contentHash],
    ["row_count", String(rows.length)],
    ["published_at", new Date().toISOString()],
    ["publication_id", crypto.randomUUID()],
  ];
  const [existingValues, existingManifest] = await Promise.all([
    readSheetValues(accessToken, spreadsheetId, tab.title, "A1:M"),
    readSheetValues(accessToken, spreadsheetId, manifestTab.title, "A1:B"),
  ]);
  const integrity = applicationSheetPublicationDecision({
    existingValues,
    existingManifest,
    desiredHash: contentHash,
    expectedHash: expectedContentHash,
    columnCount: TRACKER_HEADERS.length,
  });
  if (integrity === "external_edit") throw new Error("google_sheet_external_edit_detected");
  if (integrity === "unverified_existing_data") throw new Error("google_sheet_existing_data_unverified");
  if (integrity === "already_current") {
    const metadata = await spreadsheetMetadata(accessToken, spreadsheetId);
    return { spreadsheetId, spreadsheetUrl: metadata.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, tab: tab.title, rowCount: rows.length, contentHash };
  }

  const existingHash = existingValues.length ? applicationSheetHash(normalizeApplicationValues(existingValues, TRACKER_HEADERS.length)) : "";
  const existingManifestHash = applicationManifestHash(existingManifest);
  const stage = await writeApplicationStage(accessToken, spreadsheetId, values, manifest);
  let publishAttempted = false;
  try {
    // Check the live tabs again after staging. If a user edited either managed
    // tab while the new publication was being written, preserve that edit.
    const [latestValues, latestManifest] = await Promise.all([
      readSheetValues(accessToken, spreadsheetId, tab.title, "A1:M"),
      readSheetValues(accessToken, spreadsheetId, manifestTab.title, "A1:B"),
    ]);
    const latestHash = latestValues.length ? applicationSheetHash(normalizeApplicationValues(latestValues, TRACKER_HEADERS.length)) : "";
    const latestManifestHash = applicationManifestHash(latestManifest);
    if (latestHash !== existingHash || latestManifestHash !== existingManifestHash) throw new Error("google_sheet_external_edit_detected");

    const archiveDataTitle = `_jhc_apps_old_${stage.suffix}`;
    const archiveManifestTitle = `_jhc_apps_old_manifest_${stage.suffix}`;
    publishAttempted = true;
    await googleJson<SpreadsheetBatchUpdateResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ requests: [
        { updateSheetProperties: { properties: { sheetId: tab.sheetId, title: archiveDataTitle }, fields: "title" } },
        { updateSheetProperties: { properties: { sheetId: manifestTab.sheetId, title: archiveManifestTitle }, fields: "title" } },
        { updateSheetProperties: { properties: { sheetId: stage.data.sheetId, title: "Applications" }, fields: "title" } },
        { updateSheetProperties: { properties: { sheetId: stage.manifest.sheetId, title: "Applications Manifest" }, fields: "title" } },
        { deleteSheet: { sheetId: tab.sheetId } },
        { deleteSheet: { sheetId: manifestTab.sheetId } },
      ] }),
    });
  } catch (error) {
    // A network timeout after the atomic title swap is ambiguous. Keep the
    // staged tabs in that case: deleting by their old ids could delete the
    // newly published Applications tabs if Google committed the request.
    if (!publishAttempted) await removeApplicationStage(accessToken, spreadsheetId, stage);
    throw error;
  }
  const metadata = await spreadsheetMetadata(accessToken, spreadsheetId);
  return {
    spreadsheetId,
    spreadsheetUrl: metadata.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    tab: "Applications",
    rowCount: rows.length,
    contentHash,
  };
}

export async function syncTrackerSpreadsheetForCurrentUser() {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Authentication required");
  const { data: state, error: stateError } = await supabase.from("job_pool_sheet_sync").select("spreadsheet_id,spreadsheet_url,spreadsheet_title").eq("user_id", userData.user.id).maybeSingle();
  if (stateError) throw stateError;
  if (!state?.spreadsheet_id) return { status: "not_configured", rows: 0 };
  const { data: profile, error: profileError } = await supabase.from("candidate_profiles").select("id").eq("user_id", userData.user.id).single();
  if (profileError || !profile) throw new Error("Candidate profile not found");
  return syncTrackerIntoManagedWorkbook(supabase, profile.id, {
    spreadsheetId: state.spreadsheet_id,
    spreadsheetUrl: state.spreadsheet_url,
    spreadsheetTitle: state.spreadsheet_title,
  });
}

export async function syncTrackerIntoManagedWorkbook(
  supabase: any,
  profileId: string,
  workbook: { spreadsheetId: string; spreadsheetUrl?: string | null; spreadsheetTitle?: string | null },
) {
  const id = spreadsheetId(workbook.spreadsheetId);
  if (!id) throw new Error("google_sheet_not_accessible");
  const { data: refreshToken, error: refreshError } = await supabase.rpc("get_gmail_refresh_token");
  if (refreshError) throw new Error("google_credential_store_unavailable");
  if (!refreshToken) throw new Error("google_reconnect_required");
  const accessToken = await refreshGoogleAccessToken(String(refreshToken));
  const { getTrackerDataset } = await import("@/lib/data/repository");
  const tracker = await getTrackerDataset();
  if (tracker.source !== "supabase") throw new Error("live_tracker_required");
  const { data: existingSettings, error: settingsReadError } = await supabase.from("candidate_automation_settings")
    .select("google_spreadsheet_id,last_sheet_sync_hash").eq("profile_id", profileId).maybeSingle();
  if (settingsReadError) throw settingsReadError;
  const expectedHash = existingSettings?.google_spreadsheet_id === id && typeof existingSettings?.last_sheet_sync_hash === "string"
    ? existingSettings.last_sheet_sync_hash : null;
  const tab = await ensureTrackerTab(accessToken, id, "Applications", TRACKER_HEADERS);
  const applicationRows = trackerRecordsToRows(tracker.records as any[]);
  const written = await writeTrackerSpreadsheet(accessToken, id, tab.title, applicationRows, expectedHash);
  const latestTracker = await getTrackerDataset();
  if (latestTracker.source !== "supabase" || applicationSheetHash(trackerValues(trackerRecordsToRows(latestTracker.records as any[]))) !== written.contentHash) {
    throw new Error("google_sheet_applications_source_changed");
  }
  const canonicalUrl = workbook.spreadsheetUrl || written.spreadsheetUrl;
  const { error: settingsError } = await supabase.from("candidate_automation_settings").upsert({
    profile_id: profileId,
    spreadsheet_sync_enabled: true,
    google_spreadsheet_id: id,
    google_spreadsheet_url: canonicalUrl,
    google_spreadsheet_title: workbook.spreadsheetTitle || "JobHuntAI",
    google_spreadsheet_tab: "Applications",
    last_sheet_sync_hash: written.contentHash,
    last_sheet_sync_at: new Date().toISOString(),
    last_sheet_sync_status: "ok",
    last_sheet_sync_rows: written.rowCount,
    last_sheet_sync_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "profile_id" });
  if (settingsError) throw settingsError;
  // The settings upsert above is the single, complete publication receipt.
  // Do not follow it with the legacy record_tracker_sheet_sync RPC: a failure
  // there would report the workbook setup as failed after both Sheet tabs and
  // the database hash have already been committed successfully.
  return { ...written, spreadsheetUrl: canonicalUrl, title: workbook.spreadsheetTitle || "JobHuntAI", tab: "Applications", status: "ok" };
}

export function trackerRecordsToRows(records: Array<Record<string, any>>) {
  return trackerRowsFromRecords(records);
}
