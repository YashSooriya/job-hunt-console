import { classifyRecruitingEmail, matchEmailToApplication, emailRequiresUser } from "@jobhunt/email-intelligence";
import { createClient } from "@/lib/supabase/server";
import { GMAIL_SYNC_MAX_MESSAGES, listGmailMessages, refreshGoogleAccessToken } from "@/lib/gmail-api";
import { syncTrackerSpreadsheetForCurrentUser } from "@/lib/google-sheets";
import { syncJobPoolSheetForCurrentUser } from "@/lib/google-job-pool-sheet";

export async function syncGmail({ force = false }: { force?: boolean } = {}) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Authentication required");
  let automationSettings: Record<string, any> = {};
  try {
    const { data } = await supabase.rpc("get_automation_settings");
    automationSettings = (data || {}) as Record<string, any>;
  } catch {
    // The cadence migration is applied in production; local snapshots remain
    // usable before the live database is migrated.
  }
  const nextRun = typeof automationSettings.next_email_review_at === "string" ? Date.parse(automationSettings.next_email_review_at) : NaN;
  if (!force && automationSettings.email_monitoring_enabled === false) {
    return { status: "disabled", scanned: 0, relevant: 0, needsUser: 0, autoUpdated: 0, nextReviewAt: null };
  }
  if (!force && Number.isFinite(nextRun) && nextRun > Date.now()) {
    return { status: "not_due", scanned: 0, relevant: 0, needsUser: 0, autoUpdated: 0, nextReviewAt: automationSettings.next_email_review_at };
  }
  const { data: sessionData } = await supabase.auth.getSession();
  let providerToken = sessionData.session?.provider_token || null;

  async function refreshProviderToken() {
    const { data: refreshToken, error: refreshError } = await supabase.rpc("get_gmail_refresh_token");
    if (refreshError || !refreshToken) throw new Error("gmail_reconnect_required");
    return refreshGoogleAccessToken(String(refreshToken));
  }

  if (!providerToken) {
    try { providerToken = await refreshProviderToken(); }
    catch (error: any) {
      const reconnect = error?.message === "gmail_reconnect_required";
      await supabase.from("gmail_sync_state").upsert({
        user_id: userData.user.id,
        status: reconnect ? "needs_reconnect" : "error",
        last_error: reconnect ? "Reconnect Google with Gmail read-only access." : (error?.message || "Google access token refresh failed"),
        updated_at: new Date().toISOString(),
      });
      return { status: reconnect ? "needs_reconnect" : "error", scanned: 0, relevant: 0, needsUser: 0, autoUpdated: 0 };
    }
  }

  await supabase.from("gmail_sync_state").upsert({ user_id: userData.user.id, status: "syncing", last_error: null, updated_at: new Date().toISOString() });
  const { data: applications, error: appError } = await supabase.from("applications").select(`id,state,applied_at,jobs(title,external_job_id,companies(canonical_name))`).order("applied_at", { ascending: false });
  if (appError) throw appError;
  const candidates = (applications || []).map((row: any) => {
    const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
    const companyRelation = job?.companies;
    const company = Array.isArray(companyRelation) ? companyRelation[0] : companyRelation;
    return { id: row.id, state: row.state, appliedAt: row.applied_at, role: job?.title || "", company: company?.canonical_name || "", externalJobId: job?.external_job_id || null };
  });

  const query = process.env.JOBHUNT_GMAIL_SYNC_QUERY || 'newer_than:60d -in:spam -in:trash (application OR assessment OR interview OR offer OR candidate OR recruitment)';
  let messages;
  try {
    messages = await listGmailMessages(providerToken, query, GMAIL_SYNC_MAX_MESSAGES);
  } catch (error: any) {
    if (error?.message === "gmail_reconnect_required") {
      try {
        providerToken = await refreshProviderToken();
        messages = await listGmailMessages(providerToken, query, GMAIL_SYNC_MAX_MESSAGES);
      } catch (refreshError: any) {
        const reconnect = refreshError?.message === "gmail_reconnect_required";
        await supabase.from("gmail_sync_state").upsert({ user_id: userData.user.id, status: reconnect ? "needs_reconnect" : "error", last_error: refreshError?.message || "Gmail token refresh failed", updated_at: new Date().toISOString() });
        return { status: reconnect ? "needs_reconnect" : "error", scanned: 0, relevant: 0, needsUser: 0, autoUpdated: 0 };
      }
    } else {
      await supabase.from("gmail_sync_state").upsert({ user_id: userData.user.id, status: "error", last_error: error?.message || "Gmail sync failed", updated_at: new Date().toISOString() });
      throw error;
    }
  }

  let relevant = 0, needsUser = 0, autoUpdated = 0;
  let latestMessageAt: string | null = null;
  for (const message of messages) {
    if (message.receivedAt && (!latestMessageAt || message.receivedAt > latestMessageAt)) latestMessageAt = message.receivedAt;
    const classification = classifyRecruitingEmail(message);
    const match = matchEmailToApplication(message, classification, candidates);
    const requiresUser = emailRequiresUser(classification, match);
    if (classification.classification !== "other") relevant++;
    if (requiresUser) needsUser++;
    const { data, error } = await supabase.rpc("process_application_email", {
      p_provider_message_id: message.id,
      p_provider_thread_id: message.threadId,
      p_sender: message.sender,
      p_subject: message.subject,
      p_received_at: message.receivedAt,
      p_snippet: message.snippet,
      p_body_text: message.body,
      p_classification: classification.classification,
      p_classification_confidence: classification.confidence,
      p_classification_reason: classification.reason,
      p_application_id: match.applicationId,
      p_match_confidence: match.confidence,
      p_match_method: match.method,
      p_match_reason: match.reason,
      p_metadata: { ...classification.extracted, alternatives: match.alternatives },
    });
    if (error) throw error;
    if (data?.auto_state) autoUpdated++;
  }
  const now = new Date().toISOString();
  await supabase.from("gmail_sync_state").upsert({
    user_id: userData.user.id, status: "ok", last_synced_at: now, last_message_at: latestMessageAt,
    last_error: null, messages_scanned: messages.length, messages_relevant: relevant, initial_backfill_completed: true, updated_at: now,
  });
  try {
    await supabase.rpc("record_email_review_run", { p_status: "ok", p_scanned: messages.length, p_relevant: relevant, p_needs_user: needsUser, p_error: null });
  } catch {
    // Keep Gmail ingestion usable while older deployments are being migrated.
  }

  let sheetSync: Record<string, any> = { status: "not_configured", rows: 0 };
  if (automationSettings.spreadsheet_sync_enabled) {
    try {
      // The tracker adopts its previous workbook into the canonical Job Pool
      // record before any write. Both datasets then use one managed spreadsheet.
      await syncJobPoolSheetForCurrentUser(supabase, userData.user.id, { createIfMissing: false });
      const written = await syncTrackerSpreadsheetForCurrentUser();
      sheetSync = "rowCount" in written
        ? { status: "ok", rows: written.rowCount, spreadsheetUrl: written.spreadsheetUrl }
        : { status: "not_configured", rows: 0 };
    } catch (error: any) {
      if (error?.message === "job_pool_sheet_not_configured") {
        sheetSync = { status: "not_configured", rows: 0 };
      } else {
      sheetSync = { status: "error", rows: 0, error: error?.message || "Google Sheet sync failed." };
      try { await supabase.rpc("record_tracker_sheet_sync", { p_status: "error", p_rows: 0, p_error: sheetSync.error }); } catch { /* migration may be pending */ }
      }
    }
  }
  return { status: "ok", scanned: messages.length, relevant, needsUser, autoUpdated, sheetSync };
}
