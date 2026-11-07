import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { refreshGoogleAccessToken } from "@/lib/gmail-api";
import {
  chunkJobPoolValues,
  boundedJobPoolReadRows,
  hashJobPoolSheetValues,
  isCurrentJobPoolPublication,
  JOB_POOL_SHEET_HEADERS,
  jobPoolSheetValues,
  normalizeJobPoolSheetValues,
  type ExpectedJobPoolSnapshot,
  type JobPoolSheetRow,
} from "@/lib/job-pool-sheet-contract";

const SHEETS_API = "https://sheets.googleapis.com/v4";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MANIFEST_HEADERS = ["Field", "Value"] as const;
const MANIFEST_RANGE = "A1:B7";
const MAX_POOL_ROWS = 25_000;
const READ_CHUNK_ROWS = 250;
const READ_BATCH_ROWS = 1_000;

type GoogleSheet = { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } };
type Spreadsheet = { spreadsheetId?: string; spreadsheetUrl?: string; properties?: { title?: string }; sheets?: GoogleSheet[] };
type ApiResponse = Record<string, any>;
type PoolState = Record<string, any>;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function clean(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function quoteSheet(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function fullUrl(id: string) {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

function a1Column(index: number) {
  let value = index + 1;
  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function googleJson<T extends ApiResponse>(url: string, accessToken: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    const delay = Math.min(1600, 200 * (2 ** attempt));
    await wait(delay);
    return googleJson<T>(url, accessToken, init, attempt + 1);
  }
  const responseText = await response.text().catch(() => "");
  // Drive returns file.version as a JSON int64. Preserve the decimal digits so
  // version comparisons remain reliable after JavaScript's safe-integer range.
  const losslessResponseText = responseText.replace(/("version"\s*:\s*)(\d+)/g, '$1"$2"');
  let payload: unknown = {};
  try { payload = JSON.parse(losslessResponseText); } catch { /* handled as an empty error payload below */ }
  if (response.status === 401) throw new Error("google_access_token_rejected");
  if (response.status === 403) {
    const reason = [
      (payload as any)?.error?.status,
      ...((payload as any)?.error?.errors || []).map((item: any) => item?.reason),
      (payload as any)?.error?.message,
    ].filter(Boolean).join(" ");
    throw new Error(/scope|insufficient.?auth|insufficient.?permission/i.test(reason) ? "google_permission_required" : "google_sheet_not_accessible");
  }
  if (!response.ok) {
    const detail = clean((payload as any)?.error?.message, 240);
    if (response.status === 404) throw new Error("google_sheet_not_accessible");
    throw new Error(detail ? `google_sheet_api_${response.status}: ${detail}` : `google_sheet_api_${response.status}`);
  }
  return payload as T;
}

async function googleEmpty(url: string, accessToken: string, init: RequestInit = {}, attempt = 0) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    await wait(Math.min(1600, 200 * (2 ** attempt)));
    return googleEmpty(url, accessToken, init, attempt + 1);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("google_access_token_rejected");
    if (response.status === 403) {
      const reason = [payload?.error?.status, ...(payload?.error?.errors || []).map((item: any) => item?.reason), payload?.error?.message].filter(Boolean).join(" ");
      throw new Error(/scope|insufficient.?auth|insufficient.?permission/i.test(reason) ? "google_permission_required" : "google_sheet_not_accessible");
    }
    const detail = clean((payload as any)?.error?.message, 240);
    throw new Error(detail ? `google_sheet_api_${response.status}: ${detail}` : `google_sheet_api_${response.status}`);
  }
}

async function accessTokenForUser(supabase: any) {
  const { data, error } = await supabase.rpc("get_gmail_refresh_token");
  if (error || !data) throw new Error("google_reconnect_required");
  return refreshGoogleAccessToken(String(data));
}

function spreadsheetId(value: unknown) {
  const id = clean(value, 200);
  return /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : "";
}

async function driveMetadata(accessToken: string, id: string) {
  const file = await googleJson<ApiResponse>(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,version,webViewLink,trashed`, accessToken);
  if (file.trashed || file.mimeType !== "application/vnd.google-apps.spreadsheet" || file.version == null) {
    throw new Error("google_sheet_not_accessible");
  }
  return {
    version: String(file.version),
    title: clean(file.name, 160) || "Job Hunt Console Job Pool",
    url: typeof file.webViewLink === "string" && file.webViewLink.startsWith("https://docs.google.com/spreadsheets/d/") ? file.webViewLink : fullUrl(id),
  };
}

async function sheetMetadata(accessToken: string, id: string) {
  const result = await googleJson<Spreadsheet>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`, accessToken);
  if (result.spreadsheetId !== id) throw new Error("google_sheet_not_accessible");
  return result;
}

async function findManagedWorkbook(accessToken: string, userId: string) {
  const query = `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and appProperties has { key = 'jobhuntai_owner_id' and value = '${userId}' }`;
  const params = new URLSearchParams({ q: query, spaces: "drive", pageSize: "10", fields: "files(id,name,mimeType,webViewLink,version,appProperties)" });
  const result = await googleJson<ApiResponse>(`${DRIVE_API}/files?${params.toString()}`, accessToken);
  const matches = Array.isArray(result.files) ? result.files : [];
  if (matches.length > 1) throw new Error("google_sheet_setup_duplicate_files");
  const file = matches[0];
  const id = spreadsheetId(file?.id);
  if (!id || file?.mimeType !== "application/vnd.google-apps.spreadsheet") return null;
  return { id, title: clean(file.name, 160) || "JobHuntAI", url: clean(file.webViewLink, 1000) || fullUrl(id) };
}

async function createWorkbook(accessToken: string, userId: string) {
  const createdFile = await googleJson<ApiResponse>(`${DRIVE_API}/files?fields=id,name,mimeType,webViewLink,version`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      name: "JobHuntAI",
      mimeType: "application/vnd.google-apps.spreadsheet",
      appProperties: { jobhuntai_owner_id: userId },
    }),
  });
  const id = spreadsheetId(createdFile.id);
  if (!id || createdFile.mimeType !== "application/vnd.google-apps.spreadsheet") throw new Error("google_sheet_create_missing_id");
  const initial = await sheetMetadata(accessToken, id);
  const first = initial.sheets?.[0]?.properties;
  if (first?.sheetId == null) throw new Error("google_sheet_create_missing_tabs");
  const createRequests: Record<string, unknown>[] = [
    { updateSheetProperties: { properties: { sheetId: first.sheetId, title: "Job Pool", gridProperties: { rowCount: 1000, columnCount: JOB_POOL_SHEET_HEADERS.length, frozenRowCount: 1 } }, fields: "title,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount" } },
    { addSheet: { properties: { title: "Job Pool Manifest", gridProperties: { rowCount: 20, columnCount: 2, frozenRowCount: 1 } } } },
    { addSheet: { properties: { title: "Applications", gridProperties: { rowCount: 1000, columnCount: 13, frozenRowCount: 1 } } } },
    { addSheet: { properties: { title: "Applications Manifest", gridProperties: { rowCount: 20, columnCount: 2, frozenRowCount: 1 } } } },
  ];
  await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, accessToken, { method: "POST", body: JSON.stringify({ requests: createRequests }) });
  const result = await sheetMetadata(accessToken, id);
  const props = result.sheets?.map((sheet) => sheet.properties).filter(Boolean) || [];
  const data = props.find((sheet) => sheet?.title === "Job Pool");
  const manifest = props.find((sheet) => sheet?.title === "Job Pool Manifest");
  if (data?.sheetId == null || manifest?.sheetId == null) throw new Error("google_sheet_create_missing_tabs");
  const requests = [
    {
      repeatCell: {
        range: { sheetId: data.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: JOB_POOL_SHEET_HEADERS.length },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.12, green: 0.27, blue: 0.42 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    { autoResizeDimensions: { dimensions: { sheetId: data.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: JOB_POOL_SHEET_HEADERS.length } } },
    {
      repeatCell: {
        range: { sheetId: manifest.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.12, green: 0.27, blue: 0.42 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
  ];
  await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, accessToken, { method: "POST", body: JSON.stringify({ requests }) });
  return { id, title: clean(result.properties?.title, 160) || "JobHuntAI", url: result.spreadsheetUrl || fullUrl(id), data, manifest };
}

async function deleteCreatedWorkbook(accessToken: string, id: string) {
  await googleEmpty(`${DRIVE_API}/files/${encodeURIComponent(id)}`, accessToken, { method: "DELETE" });
}

function sheetMap(metadata: Spreadsheet) {
  const sheets = metadata.sheets?.map((sheet) => sheet.properties).filter((value): value is NonNullable<typeof value> => Boolean(value)) || [];
  const data = sheets.find((sheet) => sheet.title === "Job Pool");
  const manifest = sheets.find((sheet) => sheet.title === "Job Pool Manifest");
  if (data?.sheetId == null || manifest?.sheetId == null) throw new Error("google_sheet_tabs_missing");
  return { data, manifest };
}

async function ensurePoolTabs(accessToken: string, id: string, metadata: Spreadsheet) {
  const sheets = metadata.sheets?.map((sheet) => sheet.properties).filter((sheet): sheet is NonNullable<typeof sheet> => Boolean(sheet)) || [];
  const checks = [
    { title: "Job Pool", headers: [...JOB_POOL_SHEET_HEADERS] as string[], range: "A1:R1", columns: JOB_POOL_SHEET_HEADERS.length },
    { title: "Job Pool Manifest", headers: ["Field", "Value"], range: "A1:B1", columns: 2 },
  ];
  const requests: Record<string, unknown>[] = [];
  for (const expected of checks) {
    const existing = sheets.find((sheet) => sheet.title === expected.title);
    if (!existing) {
      requests.push({ addSheet: { properties: { title: expected.title, gridProperties: { rowCount: expected.title === "Job Pool" ? 1000 : 20, columnCount: expected.columns, frozenRowCount: 1 } } } });
      continue;
    }
    if (existing.sheetId == null) throw new Error("google_sheet_tab_conflict");
    const values = await readRange(accessToken, id, `'${expected.title}'!${expected.range}`);
    const header = Array.isArray(values[0]) ? values[0].map((cell: unknown) => String(cell ?? "")) : [];
    if (header.some(Boolean) && expected.headers.some((value, index) => header[index] !== value)) {
      throw new Error("google_sheet_tab_conflict");
    }
  }
  if (requests.length) {
    await googleJson(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, accessToken, { method: "POST", body: JSON.stringify({ requests }) });
    return sheetMetadata(accessToken, id);
  }
  return metadata;
}

async function addStagingTabs(accessToken: string, id: string, suffix: string, dataRows: number) {
  const dataTitle = `_jhc_data_${suffix}`;
  const manifestTitle = `_jhc_manifest_${suffix}`;
  const result = await googleJson<ApiResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests: [
      { addSheet: { properties: { title: dataTitle, gridProperties: { rowCount: Math.max(1, dataRows), columnCount: JOB_POOL_SHEET_HEADERS.length } } } },
      { addSheet: { properties: { title: manifestTitle, gridProperties: { rowCount: 20, columnCount: 2 } } } },
    ] }),
  });
  const data = result.replies?.[0]?.addSheet?.properties;
  const manifest = result.replies?.[1]?.addSheet?.properties;
  if (data?.sheetId == null || manifest?.sheetId == null) throw new Error("google_sheet_stage_create_failed");
  return { dataId: data.sheetId as number, dataTitle, manifestId: manifest.sheetId as number, manifestTitle };
}

function valuesRange(title: string, startRow: number, endRow: number, columnCount: number) {
  return `${quoteSheet(title)}!A${startRow + 1}:${a1Column(columnCount - 1)}${Math.max(startRow + 1, endRow)}`;
}

async function writeValues(accessToken: string, id: string, title: string, values: JobPoolSheetRow[]) {
  const chunks = chunkJobPoolValues(values);
  for (const chunk of chunks) {
    const range = valuesRange(title, chunk.startRow, chunk.startRow + chunk.values.length, JOB_POOL_SHEET_HEADERS.length);
    await googleJson<ApiResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}/values:batchUpdate`, accessToken, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", includeValuesInResponse: false, data: [{ range, majorDimension: "ROWS", values: chunk.values }] }),
    });
  }
}

async function readRange(accessToken: string, id: string, range: string) {
  const url = `${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const result = await googleJson<ApiResponse>(url, accessToken);
  return Array.isArray(result.values) ? result.values : [];
}

async function readDataTab(accessToken: string, id: string, title: string, maxRows = MAX_POOL_ROWS + 1) {
  const raw: unknown[][] = [];
  for (let offset = 0; offset < maxRows; offset += READ_BATCH_ROWS) {
    const ranges = [];
    for (let start = offset; start < Math.min(offset + READ_BATCH_ROWS, maxRows); start += READ_CHUNK_ROWS) {
      const end = Math.min(start + READ_CHUNK_ROWS, maxRows);
      ranges.push(valuesRange(title, start, end, JOB_POOL_SHEET_HEADERS.length));
    }
    const params = new URLSearchParams();
    params.set("majorDimension", "ROWS");
    params.set("valueRenderOption", "UNFORMATTED_VALUE");
    for (const range of ranges) params.append("ranges", range);
    const result = await googleJson<ApiResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${params.toString()}`, accessToken);
    const valueRanges = Array.isArray(result.valueRanges) ? result.valueRanges : [];
    for (let index = 0; index < ranges.length; index += 1) {
      const start = offset + index * READ_CHUNK_ROWS;
      const capacity = Math.min(READ_CHUNK_ROWS, maxRows - start);
      const chunk = Array.isArray(valueRanges[index]?.values) ? valueRanges[index].values : [];
      for (let row = 0; row < capacity; row += 1) raw[start + row] = Array.isArray(chunk[row]) ? chunk[row] : [];
    }
  }
  const rows = normalizeJobPoolSheetValues(raw, JOB_POOL_SHEET_HEADERS.length);
  while (rows.length && rows[rows.length - 1].every((value) => value === "")) rows.pop();
  return rows;
}

function manifestValues(input: {
  publicationId: string;
  sourceRevision: number;
  rowCount: number;
  contentHash: string;
  verificationToken: string;
  publishedAt: string;
}): JobPoolSheetRow[] {
  return [
    MANIFEST_HEADERS,
    ["publication_id", input.publicationId],
    ["source_revision", input.sourceRevision],
    ["row_count", input.rowCount],
    ["content_hash", input.contentHash],
    ["access_check_token", input.verificationToken],
    ["published_at", input.publishedAt],
  ];
}

function manifestValue(values: unknown[][], key: string) {
  const row = values.find((value) => Array.isArray(value) && value[0] === key);
  return row?.[1] ?? null;
}

function manifestMatches(values: unknown[][], input: { publicationId: string; sourceRevision: number; rowCount: number; contentHash: string; verificationToken: string }) {
  return manifestValue(values, "publication_id") === input.publicationId
    && Number(manifestValue(values, "source_revision")) === input.sourceRevision
    && Number(manifestValue(values, "row_count")) === input.rowCount
    && manifestValue(values, "content_hash") === input.contentHash
    && manifestValue(values, "access_check_token") === input.verificationToken;
}

async function readManifest(accessToken: string, id: string, title: string) {
  return readRange(accessToken, id, `${quoteSheet(title)}!${MANIFEST_RANGE}`);
}

async function writeStaging(accessToken: string, id: string, stage: { dataId: number; dataTitle: string; manifestId: number; manifestTitle: string }, dataValues: JobPoolSheetRow[], manifest: JobPoolSheetRow[]) {
  await writeValues(accessToken, id, stage.dataTitle, dataValues);
  await writeValues(accessToken, id, stage.manifestTitle, manifest);
  const readback = await readDataTab(accessToken, id, stage.dataTitle, dataValues.length);
  if (hashJobPoolSheetValues(readback) !== hashJobPoolSheetValues(dataValues)) throw new Error("google_sheet_stage_hash_mismatch");
  const manifestReadback = await readManifest(accessToken, id, stage.manifestTitle);
  if (JSON.stringify(manifestReadback) !== JSON.stringify(manifest)) throw new Error("google_sheet_stage_manifest_mismatch");
}

async function atomicallyPublish(accessToken: string, id: string, active: { data: NonNullable<GoogleSheet["properties"]>; manifest: NonNullable<GoogleSheet["properties"]> }, stage: { dataId: number; dataTitle: string; manifestId: number; manifestTitle: string }, valueRows: number) {
  const dataSheetId = active.data.sheetId!;
  const manifestSheetId = active.manifest.sheetId!;
  const currentRows = Math.max(1, Number(active.data.gridProperties?.rowCount || 1000));
  const nextGridRows = Math.max(currentRows, valueRows);
  const clearRows = Math.max(currentRows, valueRows);
  const requests: Record<string, unknown>[] = [];
  if (nextGridRows !== currentRows) {
    requests.push({ updateSheetProperties: { properties: { sheetId: dataSheetId, gridProperties: { rowCount: nextGridRows } }, fields: "gridProperties.rowCount" } });
  }
  requests.push({
    repeatCell: {
      range: { sheetId: dataSheetId, startRowIndex: 0, endRowIndex: clearRows, startColumnIndex: 0, endColumnIndex: JOB_POOL_SHEET_HEADERS.length },
      cell: {},
      fields: "userEnteredValue",
    },
  });
  requests.push({
    copyPaste: {
      source: { sheetId: stage.dataId, startRowIndex: 0, endRowIndex: valueRows, startColumnIndex: 0, endColumnIndex: JOB_POOL_SHEET_HEADERS.length },
      destination: { sheetId: dataSheetId, startRowIndex: 0, endRowIndex: valueRows, startColumnIndex: 0, endColumnIndex: JOB_POOL_SHEET_HEADERS.length },
      pasteType: "PASTE_VALUES",
      pasteOrientation: "NORMAL",
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId: manifestSheetId, startRowIndex: 0, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 2 },
      cell: {},
      fields: "userEnteredValue",
    },
  });
  requests.push({
    copyPaste: {
      source: { sheetId: stage.manifestId, startRowIndex: 0, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 2 },
      destination: { sheetId: manifestSheetId, startRowIndex: 0, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 2 },
      pasteType: "PASTE_VALUES",
      pasteOrientation: "NORMAL",
    },
  });
  requests.push(
    { deleteSheet: { sheetId: stage.dataId } },
    { deleteSheet: { sheetId: stage.manifestId } },
  );
  await googleJson<ApiResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

async function queryJobRows(supabase: any, userId: string) {
  const output: Array<Record<string, any>> = [];
  for (let start = 0; start < MAX_POOL_ROWS; start += 1000) {
    const { data, error } = await supabase.from("jobs")
      .select("id,title,industry,external_job_id,source_url,application_url,location_text,work_mode,salary_text,salary_min,salary_max,salary_currency,posted_at,closes_at,employment_type,discovery_source,triage,user_status,archived_at,companies(canonical_name)")
      .eq("user_id", userId)
      .or("discovery_source.is.null,discovery_source.neq.historical_tracker")
      .is("archived_at", null)
      .order("id", { ascending: true })
      .range(start, start + 999);
    if (error) throw error;
    const page = (data || []) as Array<Record<string, any>>;
    output.push(...page);
    if (page.length < 1000) return output;
  }
  const { data: extra, error: extraError } = await supabase.from("jobs").select("id")
    .eq("user_id", userId).or("discovery_source.is.null,discovery_source.neq.historical_tracker").is("archived_at", null)
    .range(MAX_POOL_ROWS, MAX_POOL_ROWS);
  if (extraError) throw extraError;
  if (extra?.length) throw new Error(`The active pool exceeds the safe ${MAX_POOL_ROWS.toLocaleString()}-job Sheet limit. No search was sent.`);
  return output;
}

async function readPoolState(supabase: any, userId: string) {
  const { data, error } = await supabase.from("job_pool_sheet_sync").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return asRecord(data);
}

function publicationFromState(state: PoolState): ExpectedJobPoolSnapshot & Record<string, any> {
  if (!state.current_publication_id || !state.spreadsheet_id || state.published_revision == null || !state.verification_token) {
    throw new Error("job_pool_sheet_not_configured");
  }
  return {
    publicationId: String(state.current_publication_id),
    revision: Number(state.published_revision),
    rowCount: Number(state.row_count || 0),
    verificationToken: String(state.verification_token),
    spreadsheetId: String(state.spreadsheet_id),
    spreadsheetUrl: String(state.spreadsheet_url || fullUrl(state.spreadsheet_id)),
    spreadsheetTitle: String(state.spreadsheet_title || "Job Hunt Console Job Pool"),
    dataSheetId: Number(state.data_sheet_id),
    dataSheetTitle: String(state.data_sheet_title || "Job Pool"),
    manifestSheetId: Number(state.manifest_sheet_id),
    manifestSheetTitle: String(state.manifest_sheet_title || "Job Pool Manifest"),
    contentHash: String(state.content_hash || ""),
    driveFileVersion: String(state.drive_file_version || ""),
  };
}

function snapshotForRpc(input: {
  publicationId: string;
  sourceRevision: number;
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  dataSheetId: number;
  dataSheetTitle: string;
  manifestSheetId: number;
  manifestSheetTitle: string;
  contentHash: string;
  rowCount: number;
  driveFileVersion: string;
  verificationToken: string;
}) {
  return {
    publication_id: input.publicationId,
    source_revision: input.sourceRevision,
    spreadsheet_id: input.spreadsheetId,
    spreadsheet_url: input.spreadsheetUrl,
    spreadsheet_title: input.spreadsheetTitle,
    data_sheet_id: input.dataSheetId,
    data_sheet_title: input.dataSheetTitle,
    manifest_sheet_id: input.manifestSheetId,
    manifest_sheet_title: input.manifestSheetTitle,
    content_hash: input.contentHash,
    row_count: input.rowCount,
    drive_file_version: input.driveFileVersion,
    verification_token: input.verificationToken,
  };
}

async function finishLease(supabase: any, leaseId: string, snapshot: Record<string, unknown> | null, error?: string, keep = false) {
  const { data, error: rpcError } = await supabase.rpc("finish_job_pool_sheet_sync", {
    p_lease_id: leaseId,
    p_snapshot: snapshot,
    p_error: error || null,
    p_keep_lease: keep,
  });
  if (rpcError) throw rpcError;
  return asRecord(data);
}

async function cleanStage(accessToken: string, spreadsheetId: string, stageIds: number[]) {
  if (!stageIds.length) return;
  try {
    const metadata = await sheetMetadata(accessToken, spreadsheetId);
    const existing = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.sheetId));
    const requests = stageIds.filter((id) => existing.has(id)).map((sheetId) => ({ deleteSheet: { sheetId } }));
    if (requests.length) await googleJson<ApiResponse>(`${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, { method: "POST", body: JSON.stringify({ requests }) });
  } catch { /* A later successful publication replaces any orphaned staging tabs. */ }
}

export type JobPoolSyncOptions = { createIfMissing?: boolean; holdLease?: boolean };

export async function syncJobPoolSheetForCurrentUser(supabase: any, userId: string, options: JobPoolSyncOptions = {}) {
  const leaseId = crypto.randomUUID();
  const { data: leaseData, error: leaseError } = await supabase.rpc("begin_job_pool_sheet_sync", { p_lease_id: leaseId });
  if (leaseError) throw leaseError;
  const lease = asRecord(leaseData);
  if (lease.ok !== true) {
    if (lease.reason === "active_search") throw new Error("job_pool_sheet_search_active");
    if (lease.reason === "drive_check_active") throw new Error("job_pool_sheet_drive_check_active");
    throw new Error("job_pool_sheet_sync_busy");
  }

  let accessToken = "";
  let createdSpreadsheetId = "";
  let stageIds: number[] = [];
  try {
    accessToken = await accessTokenForUser(supabase);
    let spreadsheetIdValue = spreadsheetId(lease.spreadsheet_id);
    let currentSpreadsheetTitle = clean(lease.spreadsheet_title, 160);
    let spreadsheetUrl = clean(lease.spreadsheet_url, 1000);
    let initialSheetMetadata: Spreadsheet | null = null;
    if (!spreadsheetIdValue) {
      if (!options.createIfMissing) throw new Error("job_pool_sheet_not_configured");
      const recovered = await findManagedWorkbook(accessToken, userId);
      const created = recovered || await createWorkbook(accessToken, userId);
      spreadsheetIdValue = created.id;
      if (!recovered) createdSpreadsheetId = created.id;
      currentSpreadsheetTitle = created.title;
      spreadsheetUrl = created.url;
    }
    if (!spreadsheetIdValue) throw new Error("google_sheet_not_accessible");

    let sheetInfo = initialSheetMetadata || await sheetMetadata(accessToken, spreadsheetIdValue);
    sheetInfo = await ensurePoolTabs(accessToken, spreadsheetIdValue, sheetInfo);
    const driveBefore = await driveMetadata(accessToken, spreadsheetIdValue);
    const active = sheetMap(sheetInfo);
    const storedRevision = Number(lease.published_revision);
    const sourceRevision = Number(lease.source_revision || 0);
    const storedPublicationId = clean(lease.current_publication_id, 80);
    const hasPublication = Boolean(storedPublicationId && lease.content_hash && lease.verification_token);
    let observedRemoteRows = Number(lease.row_count || 0) + 1;

    if (!createdSpreadsheetId && hasPublication && sourceRevision === storedRevision && driveBefore.version === String(lease.drive_file_version || "")) {
      const current = publicationFromState({ ...lease, spreadsheet_id: spreadsheetIdValue });
      await finishLease(supabase, leaseId, snapshotForRpc({
        publicationId: current.publicationId,
        sourceRevision: current.revision,
        spreadsheetId: current.spreadsheetId,
        spreadsheetUrl: current.spreadsheetUrl,
        spreadsheetTitle: driveBefore.title,
        dataSheetId: current.dataSheetId,
        dataSheetTitle: current.dataSheetTitle,
        manifestSheetId: current.manifestSheetId,
        manifestSheetTitle: current.manifestSheetTitle,
        contentHash: current.contentHash,
        rowCount: current.rowCount,
        driveFileVersion: driveBefore.version,
        verificationToken: current.verificationToken,
      }), undefined, options.holdLease === true);
      return { ...current, status: "ok", synced: false, leaseId };
    }

    if (!createdSpreadsheetId && hasPublication && sourceRevision === storedRevision) {
      const [remoteValues, remoteManifest] = await Promise.all([
        readDataTab(accessToken, spreadsheetIdValue, active.data.title!, boundedJobPoolReadRows(active.data.gridProperties?.rowCount, MAX_POOL_ROWS + 1)),
        readManifest(accessToken, spreadsheetIdValue, active.manifest.title!),
      ]);
      observedRemoteRows = remoteValues.length;
      const remoteHash = hashJobPoolSheetValues(remoteValues);
      const manifestGood = manifestMatches(remoteManifest, {
        publicationId: storedPublicationId,
        sourceRevision: storedRevision,
        rowCount: Number(lease.row_count || 0),
        contentHash: String(lease.content_hash),
        verificationToken: String(lease.verification_token),
      });
      if (remoteHash === String(lease.content_hash) && manifestGood) {
        const current = publicationFromState({ ...lease, spreadsheet_id: spreadsheetIdValue });
        await finishLease(supabase, leaseId, snapshotForRpc({
          publicationId: current.publicationId,
          sourceRevision: current.revision,
          spreadsheetId: current.spreadsheetId,
          spreadsheetUrl: current.spreadsheetUrl,
          spreadsheetTitle: driveBefore.title,
          dataSheetId: active.data.sheetId!,
          dataSheetTitle: active.data.title!,
          manifestSheetId: active.manifest.sheetId!,
          manifestSheetTitle: active.manifest.title!,
          contentHash: current.contentHash,
          rowCount: current.rowCount,
          driveFileVersion: driveBefore.version,
          verificationToken: current.verificationToken,
        }), undefined, options.holdLease === true);
        return { ...current, status: "ok", synced: false, leaseId };
      }
      // A changed Drive version with invalid managed content is evidence of an
      // external edit. Preserve it and fail closed instead of falling through
      // to the publication path, which would replace the user's edit.
      if (remoteHash !== String(lease.content_hash) || !manifestGood) {
        throw new Error("google_sheet_external_edit_detected");
      }
    }

    const { data: revisionResult, error: revisionError } = await supabase.from("job_pool_sheet_sync").select("source_revision").eq("user_id", userId).single();
    if (revisionError) throw revisionError;
    if (Number(revisionResult?.source_revision || 0) !== sourceRevision) throw new Error("job_pool_changed_during_sync");

    const jobs = await queryJobRows(supabase, userId);
    if (jobs.length > MAX_POOL_ROWS) throw new Error(`The active pool exceeds the safe ${MAX_POOL_ROWS.toLocaleString()}-job Sheet limit. No search was sent.`);
    const dataValues = jobPoolSheetValues(jobs);
    const contentHash = hashJobPoolSheetValues(dataValues);
    const token = crypto.randomUUID();
    const publicationId = crypto.randomUUID();
    const publishedAt = new Date().toISOString();
    const manifest = manifestValues({ publicationId, sourceRevision, rowCount: jobs.length, contentHash, verificationToken: token, publishedAt });
    const suffix = `${sourceRevision}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const stage = await addStagingTabs(accessToken, spreadsheetIdValue, suffix, dataValues.length);
    stageIds = [stage.dataId, stage.manifestId];
    await writeStaging(accessToken, spreadsheetIdValue, stage, dataValues, manifest);

    const latestRevision = await supabase.from("job_pool_sheet_sync").select("source_revision").eq("user_id", userId).single();
    if (latestRevision.error) throw latestRevision.error;
    if (Number(latestRevision.data?.source_revision || 0) !== sourceRevision) throw new Error("job_pool_changed_during_sync");

    await atomicallyPublish(accessToken, spreadsheetIdValue, active, stage, dataValues.length);
    stageIds = [];
    const afterSwap = await sheetMetadata(accessToken, spreadsheetIdValue);
    const publishedTabs = sheetMap(afterSwap);
    const [readback, manifestReadback] = await Promise.all([
      readDataTab(accessToken, spreadsheetIdValue, publishedTabs.data.title!, dataValues.length),
      readManifest(accessToken, spreadsheetIdValue, publishedTabs.manifest.title!),
    ]);
    if (hashJobPoolSheetValues(readback) !== contentHash || readback.length !== dataValues.length) {
      throw new Error("google_sheet_published_hash_mismatch");
    }
    if (!manifestMatches(manifestReadback, { publicationId, sourceRevision, rowCount: jobs.length, contentHash, verificationToken: token })) {
      throw new Error("google_sheet_published_manifest_mismatch");
    }
    const driveAfter = await driveMetadata(accessToken, spreadsheetIdValue);
    const snapshot = snapshotForRpc({
      publicationId,
      sourceRevision,
      spreadsheetId: spreadsheetIdValue,
      spreadsheetUrl: driveAfter.url || spreadsheetUrl || fullUrl(spreadsheetIdValue),
      spreadsheetTitle: driveAfter.title || currentSpreadsheetTitle || "Job Hunt Console Job Pool",
      dataSheetId: publishedTabs.data.sheetId!,
      dataSheetTitle: publishedTabs.data.title!,
      manifestSheetId: publishedTabs.manifest.sheetId!,
      manifestSheetTitle: publishedTabs.manifest.title!,
      contentHash,
      rowCount: jobs.length,
      driveFileVersion: driveAfter.version,
      verificationToken: token,
    });
    const finished = await finishLease(supabase, leaseId, snapshot, undefined, options.holdLease === true);
    if (finished.ok !== true) throw new Error(finished.reason === "source_changed" ? "job_pool_changed_during_sync" : "job_pool_sheet_commit_failed");
    return {
      publicationId: String(finished.publication_id || publicationId),
      revision: sourceRevision,
      rowCount: jobs.length,
      verificationToken: token,
      spreadsheetId: spreadsheetIdValue,
      spreadsheetUrl: String(finished.spreadsheet_url || spreadsheetUrl || fullUrl(spreadsheetIdValue)),
      spreadsheetTitle: driveAfter.title || currentSpreadsheetTitle,
      dataSheetId: Number(finished.data_sheet_id || publishedTabs.data.sheetId),
      dataSheetTitle: String(finished.data_sheet_title || publishedTabs.data.title),
      manifestSheetId: Number(finished.manifest_sheet_id || publishedTabs.manifest.sheetId),
      manifestSheetTitle: String(finished.manifest_sheet_title || publishedTabs.manifest.title),
      contentHash,
      driveFileVersion: driveAfter.version,
      status: "ok",
      synced: true,
      leaseId,
    };
  } catch (error) {
    if (accessToken && spreadsheetId(lease.spreadsheet_id)) await cleanStage(accessToken, spreadsheetId(lease.spreadsheet_id), stageIds);
    // Keep an uncommitted managed file. Its private Drive appProperties marker
    // lets the next retry recover it instead of creating a duplicate.
    const message = error instanceof Error ? error.message : "Google Sheet sync failed.";
    try { await finishLease(supabase, leaseId, null, message, false); } catch { /* the lease expires automatically */ }
    throw error;
  }
}

export async function releaseJobPoolSheetLease(supabase: any, leaseId: string | null) {
  if (!leaseId) return;
  const { error } = await supabase.rpc("finish_job_pool_sheet_sync", { p_lease_id: leaseId, p_snapshot: null, p_error: null, p_keep_lease: false });
  if (error) throw error;
}

export async function currentJobPoolSheetSnapshot(supabase: any, userId: string) {
  const state = await readPoolState(supabase, userId);
  if (!state.user_id || state.spreadsheet_id === null || state.current_publication_id === null || Number(state.source_revision) !== Number(state.published_revision)) {
    throw new Error("job_pool_sheet_not_ready");
  }
  const snapshot = publicationFromState(state);
  return {
    ...snapshot,
    dataUrl: `${snapshot.spreadsheetUrl}#gid=${snapshot.dataSheetId}`,
    dataSheetTitle: snapshot.dataSheetTitle,
    manifestUrl: `${snapshot.spreadsheetUrl}#gid=${snapshot.manifestSheetId}`,
    manifestSheetTitle: snapshot.manifestSheetTitle,
  };
}

export async function getJobPoolSheetStatus(supabase: any, userId: string) {
  const state = await readPoolState(supabase, userId);
  const configured = Boolean(state.spreadsheet_id && state.current_publication_id);
  return {
    configured,
    spreadsheetUrl: configured ? String(state.spreadsheet_url || fullUrl(String(state.spreadsheet_id))) : null,
    spreadsheetTitle: configured ? String(state.spreadsheet_title || "Job Hunt Console Job Pool") : null,
    sourceRevision: Number(state.source_revision || 0),
    publishedRevision: state.published_revision == null ? null : Number(state.published_revision),
    rowCount: configured ? Number(state.row_count || 0) : null,
    lastSyncedAt: typeof state.last_synced_at === "string" ? state.last_synced_at : null,
    lastSyncStatus: String(state.last_sync_status || "not_configured"),
    lastSyncError: typeof state.last_sync_error === "string" ? state.last_sync_error : null,
    driveVerifiedAt: typeof state.drive_verified_at === "string" ? state.drive_verified_at : null,
    driveFileVersion: typeof state.drive_file_version === "string" ? state.drive_file_version : null,
    driveVerifiedVersion: typeof state.drive_verified_version === "string" ? state.drive_verified_version : null,
    driveCheckActive: typeof state.drive_check_lease_expires_at === "string" && Date.parse(state.drive_check_lease_expires_at) > Date.now(),
    current: isCurrentJobPoolPublication({
      configured,
      lastSyncStatus: String(state.last_sync_status || "not_configured"),
      sourceRevision: Number(state.source_revision || 0),
      publishedRevision: state.published_revision == null ? null : Number(state.published_revision),
      driveVerifiedAt: typeof state.drive_verified_at === "string" ? state.drive_verified_at : null,
      driveVerifiedVersion: typeof state.drive_verified_version === "string" ? state.drive_verified_version : null,
      driveFileVersion: typeof state.drive_file_version === "string" ? state.drive_file_version : null,
      driveCheckActive: typeof state.drive_check_lease_expires_at === "string" && Date.parse(state.drive_check_lease_expires_at) > Date.now(),
    }),
  };
}

export function buildJobPoolAccessTestInstruction(snapshot: ExpectedJobPoolSnapshot & Record<string, any>) {
  return [
    "Perform a read-only Google Drive connector access test. Do not change the Sheet, any job, or ChatGPT Memory.",
    `Open the manifest tab of this exact Google Sheet: ${snapshot.manifestUrl || `${snapshot.spreadsheetUrl}#gid=${snapshot.manifestSheetId}`}`,
    `Read the tab named ${snapshot.manifestSheetTitle} (gid ${snapshot.manifestSheetId}). The expected publication_id is ${snapshot.publicationId}, revision is ${snapshot.revision}, and row_count is ${snapshot.rowCount}. These identifiers are supplied for comparison; the access_check_token is not supplied and must be read from the manifest cell next to that field.`,
    "Return only one JSON object with exactly these fields: {\"access_test\":\"ok\",\"publication_id\":\"<manifest value>\",\"revision\":0,\"row_count\":0,\"access_check_token\":\"<exact value read from the manifest>\"}. If the file or manifest cannot be opened, return {\"access_test\":\"unavailable\"} and do not guess a token.",
  ].join("\n");
}

export async function recordJobPoolSheetSyncInBackground(supabase: any, userId: string) {
  try {
    const state = await readPoolState(supabase, userId);
    if (!state.spreadsheet_id) return false;
    if (state.current_publication_id && state.last_sync_status === "ok"
      && Number(state.source_revision) === Number(state.published_revision)) return false;
    const sync = syncJobPoolSheetForCurrentUser(supabase, userId);
    if (process.env.NODE_ENV === "development") {
      // Next's local server has no response-lifetime waitUntil; the status read
      // must wait for the publication it caused so local integrations are exact.
      await sync;
      return true;
    }
    try {
      const { ctx } = getCloudflareContext();
      ctx.waitUntil(sync.catch((error) => console.warn("Job-pool Sheet background sync was deferred or failed.", error instanceof Error ? error.message : "unknown error")));
      return true;
    } catch {
      // A missing runtime context also falls back to an awaited local sync.
      await sync;
      return true;
    }
  } catch (error) {
    console.warn("Job-pool Sheet background sync failed.", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

export async function checkJobPoolSheetRevision(supabase: any, userId: string, expectedRevision: number) {
  const { data, error } = await supabase.from("job_pool_sheet_sync").select("source_revision").eq("user_id", userId).single();
  if (error) throw error;
  if (Number(data?.source_revision || 0) !== expectedRevision) throw new Error("job_pool_changed_during_sync");
}

export function currentJobPoolSheetHeaders() {
  return [...JOB_POOL_SHEET_HEADERS];
}

export function jobPoolManifestHeaders() {
  return [...MANIFEST_HEADERS];
}
