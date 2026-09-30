import "server-only";
import { refreshGoogleAccessToken } from "@/lib/gmail-api";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type DriveFile = { id: string; name?: string; webViewLink?: string; mimeType?: string };

function quoteDrive(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function driveJson(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: "Bearer " + accessToken, ...(init.headers || {}) },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) {
    const message = String(payload.error?.message || payload.error || "");
    if (response.status === 401) throw new Error("google_reconnect_required");
    if (response.status === 403 && /scope|insufficient.?auth|insufficient.?permission/i.test(message)) throw new Error("google_permission_required");
    if (response.status >= 500 || response.status === 429) throw new Error("google_drive_temporarily_unavailable");
    throw new Error("google_drive_request_failed");
  }
  return payload;
}

async function findDriveFile(accessToken: string, query: string): Promise<DriveFile | null> {
  const url = DRIVE_API + "/files?" + new URLSearchParams({
    q: query,
    spaces: "drive",
    pageSize: "10",
    orderBy: "createdTime",
    fields: "files(id,name,mimeType,webViewLink,appProperties)",
  });
  const payload = await driveJson(url, accessToken);
  const files = Array.isArray(payload.files) ? payload.files : [];
  return files.find((file: any) => typeof file?.id === "string" && file.id.length > 0) || null;
}

async function createDriveFolder(accessToken: string, userId: string, applicationId: string, title: string) {
  const tagQuery = "appProperties has { key='jobhuntApplicationId' and value='" + quoteDrive(applicationId) + "' }";
  const existing = await findDriveFile(accessToken, tagQuery + " and mimeType='" + FOLDER_MIME + "' and trashed=false");
  if (existing) return existing;
  const payload = await driveJson(DRIVE_API + "/files?fields=id,name,webViewLink,mimeType", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: title,
      mimeType: FOLDER_MIME,
      appProperties: { jobhuntApplicationId: applicationId, jobhuntUserId: userId, jobhuntFileKind: "application-documents-folder" },
    }),
  });
  if (typeof payload.id !== "string") throw new Error("google_drive_folder_create_failed");
  return payload as DriveFile;
}

async function createDriveFile(accessToken: string, input: {
  folderId: string; applicationId: string; userId: string; itemId: string; format: "pdf" | "docx";
  name: string; bytes: Uint8Array; mimeType: string;
}) {
  const tags = {
    jobhuntApplicationId: input.applicationId,
    jobhuntUserId: input.userId,
    jobhuntDocumentItemId: input.itemId,
    jobhuntFormat: input.format,
  };
  const properties = Object.entries(tags).map(([key, value]) =>
    "appProperties has { key='" + quoteDrive(key) + "' and value='" + quoteDrive(value) + "' }").join(" and ");
  const query = "'" + quoteDrive(input.folderId) + "' in parents and trashed=false and " + properties;
  const existing = await findDriveFile(accessToken, query);
  if (existing) return existing;

  const boundary = "jobhuntai_" + crypto.randomUUID().replaceAll("-", "");
  const metadata = JSON.stringify({
    name: input.name,
    mimeType: input.mimeType,
    parents: [input.folderId],
    appProperties: tags,
  });
  const bytes = new Uint8Array(input.bytes);
  const body = new Blob([
    "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata + "\r\n",
    "--" + boundary + "\r\nContent-Type: " + input.mimeType + "\r\n\r\n",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "\r\n--" + boundary + "--",
  ]);
  const payload = await driveJson(DRIVE_UPLOAD + "/files?uploadType=multipart&fields=id,name,webViewLink,mimeType", accessToken, {
    method: "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body,
  });
  if (typeof payload.id !== "string") throw new Error("google_drive_file_upload_failed");
  return payload as DriveFile;
}

function safeName(value: unknown) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Application";
}

async function saveDriveState(supabase: any, itemId: string, state: string, folderId: string | null, pdfId: string | null, docxId: string | null, code: string | null) {
  const { error } = await supabase.rpc("record_application_document_drive_state", {
    p_item_id: itemId, p_state: state, p_folder_id: folderId, p_pdf_id: pdfId, p_docx_id: docxId, p_error_code: code,
  });
  if (error) throw error;
}

export async function publishApplicationDocumentItem(supabase: any, userId: string, itemId: string) {
  let item: Record<string, any> | null = null;
  let folderId: string | null = null;
  let pdfId: string | null = null;
  let docxId: string | null = null;
  try {
    const { data, error } = await supabase.from("document_generation_items").select("*").eq("id", itemId).eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (!data || data.state !== "ready" || !data.pdf_object_key || !data.docx_object_key) throw new Error("application_documents_not_ready");
    const sourceItem = data as Record<string, any>;
    item = sourceItem;
    if (sourceItem.drive_state === "ready" && sourceItem.drive_folder_id && sourceItem.drive_pdf_id && sourceItem.drive_docx_id) {
      return { ok: true, folderId: sourceItem.drive_folder_id, pdfId: sourceItem.drive_pdf_id, docxId: sourceItem.drive_docx_id, idempotent: true };
    }
    folderId = typeof sourceItem.drive_folder_id === "string" ? sourceItem.drive_folder_id : null;
    pdfId = typeof sourceItem.drive_pdf_id === "string" ? sourceItem.drive_pdf_id : null;
    docxId = typeof sourceItem.drive_docx_id === "string" ? sourceItem.drive_docx_id : null;
    await saveDriveState(supabase, itemId, "retrying", folderId, pdfId, docxId, null);

    const { data: application, error: applicationError } = await supabase.from("applications").select("id,job_id").eq("id", sourceItem.application_id).eq("user_id", userId).maybeSingle();
    if (applicationError) throw applicationError;
    if (!application) throw new Error("application_not_found");
    const { data: job, error: jobError } = await supabase.from("jobs").select("title,companies(canonical_name)").eq("id", application.job_id).maybeSingle();
    if (jobError) throw jobError;

    const { data: refreshToken, error: tokenError } = await supabase.rpc("get_gmail_refresh_token");
    if (tokenError) throw new Error("google_credential_store_unavailable");
    if (!refreshToken) {
      await saveDriveState(supabase, itemId, "not_configured", folderId, pdfId, docxId, "google_not_connected");
      return { ok: false, state: "not_configured" };
    }
    const accessToken = await refreshGoogleAccessToken(String(refreshToken));
    const { data: folderRow, error: folderReadError } = await supabase.from("document_application_drive_folders")
      .select("folder_id,folder_url").eq("user_id", userId).eq("application_id", sourceItem.application_id).maybeSingle();
    if (folderReadError) throw folderReadError;
    const companyRelation = Array.isArray(job?.companies) ? job.companies[0] : job?.companies;
    const folder = folderRow
      ? { id: folderRow.folder_id, webViewLink: folderRow.folder_url }
      : await createDriveFolder(accessToken, userId, sourceItem.application_id, safeName(companyRelation?.canonical_name || job?.title) + " - " + safeName(job?.title) + " application");
    folderId = folder.id;
    const folderUrl = folder.webViewLink || "https://drive.google.com/drive/folders/" + folder.id;
    const { error: folderSaveError } = await supabase.rpc("record_application_document_drive_folder", {
      p_application_id: sourceItem.application_id, p_folder_id: folder.id, p_folder_url: folderUrl,
    });
    if (folderSaveError) throw folderSaveError;

    const storage = supabase.storage.from("application-documents");
    const [pdf, docx] = await Promise.all([
      storage.download(sourceItem.pdf_object_key),
      storage.download(sourceItem.docx_object_key),
    ]);
    if (pdf.error) throw new Error("document_pdf_storage_unavailable");
    if (docx.error) throw new Error("document_docx_storage_unavailable");
    const baseName = safeName(companyRelation?.canonical_name || job?.title) + " - " + safeName(job?.title);
    const [pdfFile, docxFile] = await Promise.all([
      createDriveFile(accessToken, {
        folderId: folder.id, applicationId: sourceItem.application_id, userId, itemId, format: "pdf",
        name: baseName + (sourceItem.document_kind === "cv" ? " - CV" : " - Cover Letter") + " v" + (sourceItem.version_number || 1) + ".pdf",
        bytes: new Uint8Array(await pdf.data.arrayBuffer()), mimeType: PDF_MIME,
      }),
      createDriveFile(accessToken, {
        folderId: folder.id, applicationId: sourceItem.application_id, userId, itemId, format: "docx",
        name: baseName + (sourceItem.document_kind === "cv" ? " - CV" : " - Cover Letter") + " v" + (sourceItem.version_number || 1) + ".docx",
        bytes: new Uint8Array(await docx.data.arrayBuffer()), mimeType: DOCX_MIME,
      }),
    ]);
    pdfId = pdfFile.id;
    docxId = docxFile.id;
    await saveDriveState(supabase, itemId, "ready", folder.id, pdfId, docxId, null);
    return { ok: true, folderId: folder.id, folderUrl, pdfId, docxId, idempotent: false };
  } catch (error) {
    const code = error instanceof Error ? error.message : "google_drive_publication_failed";
    const state = code === "google_reconnect_required" || code === "google_permission_required" ? "needs_reconnect"
      : code === "google_not_connected" ? "not_configured" : "failed";
    if (item) {
      try { await saveDriveState(supabase, itemId, state, folderId, pdfId, docxId, code.slice(0, 80)); } catch { /* The ready Supabase copy remains authoritative. */ }
    }
    return { ok: false, state, errorCode: code };
  }
}
