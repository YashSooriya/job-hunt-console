import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { refreshGoogleAccessToken } from "@/lib/gmail-api";

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

function sheetTitle(value: unknown) {
  const title = cleanText(value, 100);
  return title || "Job Application Tracker";
}

function managedTabTitle(value: unknown, fallback = "JobHuntAI Applications") {
  const title = cleanText(value, 100);
  if (/[\r\n\\/?*\[\]:]/.test(title)) throw new Error("google_sheet_tab_invalid");
  return title || fallback;
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
  if (response.status === 401 || response.status === 403) throw new Error("google_reconnect_required");
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
  if (response.status === 401 || response.status === 403) throw new Error("google_reconnect_required");
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
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

function trackerStatusForState(state: unknown) {
  switch (state) {
    case "rejected":
    case "withdrawn":
    case "expired":
      return "Closed";
    case "offer":
      return "Offer";
    case "assessment":
    case "interview":
    case "form_needs_user":
    case "final_review":
    case "approved_for_submission":
      return "Action Required";
    case "submitted":
    case "awaiting_response":
      return "Under Review";
    case "preparing":
    case "ready_for_review":
    case "revision_requested":
    case "content_approved":
    case "form_in_progress":
      return "Preparing";
    default:
      return "Active";
  }
}

function trackerStageForState(state: unknown) {
  switch (state) {
    case "submitted": return "Applied";
    case "awaiting_response": return "Awaiting response";
    case "assessment": return "Assessment";
    case "interview": return "Interview";
    case "offer": return "Offer";
    case "rejected":
    case "withdrawn":
    case "expired":
      return "Closed";
    default: return typeof state === "string" && state ? state.replaceAll("_", " ") : "Active";
  }
}

async function spreadsheetMetadata(accessToken: string, spreadsheetId: string) {
  return googleJson<SpreadsheetResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`, accessToken);
}

export async function createTrackerSpreadsheet(accessToken: string, requestedTitle?: string) {
  const title = sheetTitle(requestedTitle);
  const created = await googleJson<SpreadsheetResponse>(`${SHEETS_API}/spreadsheets`, accessToken, {
    method: "POST",
    body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: "Applications" } }] }),
  });
  const firstSheet = created.sheets?.[0]?.properties;
  if (!created.spreadsheetId || !firstSheet?.title) throw new Error("google_sheet_create_missing_id");
  if (firstSheet.sheetId == null) throw new Error("google_sheet_create_missing_tab");
  await formatTrackerSheet(accessToken, created.spreadsheetId, firstSheet.sheetId);
  return {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
    title: created.properties?.title || title,
    tab: firstSheet.title,
  };
}

async function formatTrackerSheet(accessToken: string, spreadsheetId: string, sheetId: number) {
  await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: TRACKER_HEADERS.length },
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
        { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: TRACKER_HEADERS.length } } },
        { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 170 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 3 }, properties: { pixelSize: 220 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 12 }, properties: { pixelSize: 190 }, fields: "pixelSize" } },
      ],
    }),
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

export async function writeTrackerSpreadsheet(accessToken: string, spreadsheetId: string, requestedTab: string, rows: TrackerSheetRow[]) {
  const metadata = await spreadsheetMetadata(accessToken, spreadsheetId);
  const available = metadata.sheets?.map((sheet) => sheet.properties).filter(Boolean) || [];
  const tab = available.find((sheet) => sheet?.title === requestedTab);
  if (!tab?.title || tab.sheetId == null) throw new Error("google_sheet_tab_missing");

  const values = trackerValues(rows);
  const clearRange = encodeURIComponent(sheetRange(tab.title, "A:M"));
  await googleEmpty(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${clearRange}:clear`, accessToken, { method: "POST", body: "{}" });
  const endRow = Math.max(1, values.length);
  await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", includeValuesInResponse: false, data: [{ range: sheetRange(tab.title, `A1:M${endRow}`), majorDimension: "ROWS", values }] }),
  });
  await formatTrackerSheet(accessToken, spreadsheetId, tab.sheetId);
  return {
    spreadsheetId,
    spreadsheetUrl: metadata.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    tab: tab.title,
    rowCount: rows.length,
  };
}

function createGoogleDataClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

function createServerCredentialClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("server_service_role_not_configured");
  return createSupabaseClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "job-hunt-server-sheet-broker" } },
  });
}

export async function syncTrackerSpreadsheetForChatGPT(accessToken: string, createIfMissing = false) {
  const supabase = createGoogleDataClient();
  const settingsResult = await supabase.rpc("chatgpt_get_automation_settings", { p_access_token: accessToken });
  if (settingsResult.error) throw settingsResult.error;
  const settings = (settingsResult.data || {}) as Record<string, any>;
  if (!settings.spreadsheet_sync_enabled) return { status: "disabled", rows: 0, reason: "Spreadsheet sync is disabled in Settings." };

  let spreadsheetId = typeof settings.google_spreadsheet_id === "string" ? settings.google_spreadsheet_id : "";
  let tab = typeof settings.google_spreadsheet_tab === "string" ? settings.google_spreadsheet_tab : "Applications";
  let spreadsheetUrl = settings.google_spreadsheet_url || null;
  if (!spreadsheetId && !createIfMissing) return { status: "not_configured", rows: 0, reason: "Create or choose the optional tracker Sheet in Settings first." };

  const credentialClient = createServerCredentialClient();
  const refreshResult = await credentialClient.rpc("chatgpt_server_get_google_refresh_token", { p_access_token: accessToken });
  if (refreshResult.error) throw refreshResult.error;
  if (!refreshResult.data) throw new Error("google_reconnect_required");
  const googleAccessToken = await refreshGoogleAccessToken(String(refreshResult.data));

  if (!spreadsheetId) {
    const created = await createTrackerSpreadsheet(googleAccessToken, "Job Application Tracker");
    spreadsheetId = created.spreadsheetId;
    tab = created.tab;
    spreadsheetUrl = created.spreadsheetUrl;
    const configured = await supabase.rpc("chatgpt_configure_tracker_sheet", {
      p_access_token: accessToken,
      p_spreadsheet_id: spreadsheetId,
      p_spreadsheet_url: spreadsheetUrl,
      p_title: created.title,
      p_tab: tab,
    });
    if (configured.error) throw configured.error;
  }

  try {
    const trackerResult = await supabase.rpc("chatgpt_get_application_tracker", { p_access_token: accessToken });
    if (trackerResult.error) throw trackerResult.error;
    const records = Array.isArray((trackerResult.data as any)?.records) ? (trackerResult.data as any).records : [];
    const rows = trackerRowsFromRecords(records.map((record: any) => ({
      applicationId: record.application_id,
      company: record.company,
      role: record.role,
      externalJobId: record.external_job_id,
      applicationDate: record.application_date,
      lastEmail: record.last_email,
      status: trackerStatusForState(record.state),
      stage: trackerStageForState(record.state),
      priority: record.priority_score == null ? null : Number(record.priority_score) >= 80 ? "High" : Number(record.priority_score) >= 60 ? "Medium" : "Low",
      nextAction: record.next_action,
      deadline: record.deadline,
      notes: record.notes,
      emailSource: record.email_source,
    })));
    const written = await writeTrackerSpreadsheet(googleAccessToken, spreadsheetId, tab, rows);
    await supabase.rpc("chatgpt_record_tracker_sheet_sync", { p_access_token: accessToken, p_status: "ok", p_rows: written.rowCount, p_error: null });
    return { status: "ok", rows: written.rowCount, spreadsheetId: written.spreadsheetId, spreadsheetUrl: written.spreadsheetUrl, tab: written.tab };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Sheet sync failed.";
    try { await supabase.rpc("chatgpt_record_tracker_sheet_sync", { p_access_token: accessToken, p_status: "error", p_rows: 0, p_error: message }); } catch { /* preserve the original sync failure */ }
    throw error;
  }
}

export async function createTrackerSpreadsheetForCurrentUser() {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Authentication required");
  const { data: refreshToken, error: refreshError } = await supabase.rpc("get_gmail_refresh_token");
  if (refreshError || !refreshToken) throw new Error("google_reconnect_required");
  const accessToken = await refreshGoogleAccessToken(String(refreshToken));
  const created = await createTrackerSpreadsheet(accessToken, "Job Application Tracker");
  const { getTrackerDataset } = await import("@/lib/data/repository");
  const tracker = await getTrackerDataset();
  if (tracker.source !== "supabase") throw new Error("live_tracker_required");
  const written = await writeTrackerSpreadsheet(accessToken, created.spreadsheetId, created.tab, trackerRecordsToRows(tracker.records as any[]));
  const { data: profile, error: profileError } = await supabase.from("candidate_profiles").select("id").eq("user_id", userData.user.id).single();
  if (profileError || !profile) throw new Error("Candidate profile not found");
  const { error: saveError } = await supabase.from("candidate_automation_settings").upsert({
    profile_id: profile.id, spreadsheet_sync_enabled: true, google_spreadsheet_id: created.spreadsheetId,
    google_spreadsheet_url: created.spreadsheetUrl, google_spreadsheet_title: created.title, google_spreadsheet_tab: created.tab,
    updated_at: new Date().toISOString(),
  }, { onConflict: "profile_id" });
  if (saveError) throw saveError;
  await supabase.rpc("record_tracker_sheet_sync", { p_status: "ok", p_rows: written.rowCount, p_error: null });
  return { ...created, rows: written.rowCount };
}

export async function connectTrackerSpreadsheetForCurrentUser(requestedSpreadsheetId: string, requestedTab?: string) {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Authentication required");
  const id = spreadsheetId(requestedSpreadsheetId);
  if (!id) throw new Error("Enter or select a valid Google Sheet.");

  const { data: refreshToken, error: refreshError } = await supabase.rpc("get_gmail_refresh_token");
  if (refreshError || !refreshToken) throw new Error("google_reconnect_required");
  const accessToken = await refreshGoogleAccessToken(String(refreshToken));
  let metadata: SpreadsheetResponse;
  try {
    metadata = await spreadsheetMetadata(accessToken, id);
  } catch (error) {
    if (error instanceof Error && error.message === "google_reconnect_required") throw new Error("google_sheet_not_accessible");
    throw error;
  }
  if (metadata.spreadsheetId !== id || !metadata.sheets?.length) throw new Error("google_sheet_not_accessible");

  const tab = await ensureManagedTrackerTab(accessToken, id, managedTabTitle(requestedTab));
  const { getTrackerDataset } = await import("@/lib/data/repository");
  const tracker = await getTrackerDataset();
  if (tracker.source !== "supabase") throw new Error("live_tracker_required");
  const written = await writeTrackerSpreadsheet(accessToken, id, tab.title!, trackerRecordsToRows(tracker.records as any[]));

  const { data: profile, error: profileError } = await supabase.from("candidate_profiles").select("id").eq("user_id", userData.user.id).single();
  if (profileError || !profile) throw new Error("Candidate profile not found");
  const { error: saveError } = await supabase.from("candidate_automation_settings").upsert({
    profile_id: profile.id,
    spreadsheet_sync_enabled: true,
    google_spreadsheet_id: id,
    google_spreadsheet_url: metadata.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`,
    google_spreadsheet_title: metadata.properties?.title || "Selected Google Sheet",
    google_spreadsheet_tab: tab.title,
    updated_at: new Date().toISOString(),
  }, { onConflict: "profile_id" });
  if (saveError) throw saveError;
  await supabase.rpc("record_tracker_sheet_sync", { p_status: "ok", p_rows: written.rowCount, p_error: null });

  return {
    spreadsheetId: id,
    spreadsheetUrl: metadata.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`,
    title: metadata.properties?.title || "Selected Google Sheet",
    tab: tab.title,
    rows: written.rowCount,
  };
}

export async function syncTrackerSpreadsheetForCurrentUser() {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: settings, error: settingsError } = await supabase.rpc("get_automation_settings");
  if (settingsError) throw settingsError;
  const row = (settings || {}) as Record<string, any>;
  if (!row.spreadsheet_sync_enabled || !row.google_spreadsheet_id) return { status: "not_configured", rows: 0 };
  const { data: refreshToken, error: refreshError } = await supabase.rpc("get_gmail_refresh_token");
  if (refreshError || !refreshToken) throw new Error("google_reconnect_required");
  const accessToken = await refreshGoogleAccessToken(String(refreshToken));
  const { getTrackerDataset } = await import("@/lib/data/repository");
  const tracker = await getTrackerDataset();
  if (tracker.source !== "supabase") throw new Error("live_tracker_required");
  const written = await writeTrackerSpreadsheet(accessToken, row.google_spreadsheet_id, row.google_spreadsheet_tab || "Applications", trackerRecordsToRows(tracker.records as any[]));
  await supabase.rpc("record_tracker_sheet_sync", { p_status: "ok", p_rows: written.rowCount, p_error: null });
  return { ...written, status: "ok" };
}

export function trackerRecordsToRows(records: Array<Record<string, any>>) {
  return trackerRowsFromRecords(records);
}
