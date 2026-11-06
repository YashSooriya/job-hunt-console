import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import {
  buildJobPoolAccessTestInstruction,
  currentJobPoolSheetSnapshot,
  getJobPoolSheetStatus,
  releaseJobPoolSheetLease,
  syncJobPoolSheetForCurrentUser,
} from "@/lib/google-job-pool-sheet";
import { parseJobPoolAccessTestResponse } from "@/lib/job-pool-sheet-contract";
import { syncTrackerIntoManagedWorkbook } from "@/lib/google-sheets";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function responseError(error: unknown) {
  const rawCode = error instanceof Error ? error.message : "job_pool_sheet_failed";
  const code = /google_sheet_api_400:.*range.*exceeds grid limits/i.test(rawCode) ? "google_sheet_grid_limit" : rawCode;
  const status = code === "job_pool_sheet_failed" ? 500
    : code === "google_sheet_grid_limit" || code === "google_sheet_external_edit_detected" ? 409
    : code === "google_reconnect_required" || code === "job_pool_sheet_not_configured" || code === "job_pool_sheet_not_ready"
    || code === "job_pool_sheet_search_active" || code === "job_pool_sheet_sync_busy" || code === "job_pool_sheet_drive_check_active" || code === "job_pool_changed_during_sync" ? 409
    : code === "google_sheet_not_accessible" || code === "google_permission_required" ? 403
      : code === "google_access_token_rejected" ? 503
      : code.includes("safe 25,000-job Sheet limit") ? 413
        : statusCode(error);
  const messages: Record<string, string> = {
    google_reconnect_required: "Google access has expired or is missing the required permission. Reconnect Google once, then retry the sync.",
    google_permission_required: "Google has not granted JobHuntAI the permission needed to use this spreadsheet. Reconnect Google once from Settings, then retry.",
    google_access_token_rejected: "Google rejected the temporary access token. Your saved grant is unchanged; retry the sync once.",
    google_credential_store_unavailable: "Google approved access, but JobHuntAI could not read the saved connection. Try again; your Google grant has not been removed.",
    google_sheet_not_accessible: "This spreadsheet is not available to the connected Google account. Check the selected account and retry.",
    google_sheet_setup_duplicate_files: "More than one JobHuntAI spreadsheet was found for this account. No file was changed; contact support to resolve the duplicate setup.",
    google_sheet_tab_conflict: "A tab named Job Pool or Applications already contains different data. Nothing in that tab was overwritten.",
    google_sheet_applications_hash_mismatch: "The Applications tab could not be verified after saving. Retry sync; the database records remain safe.",
    google_sheet_external_edit_detected: "The managed spreadsheet was changed outside JobHuntAI. Nothing was overwritten; restore the affected Job Pool or Applications tab and its manifest before syncing again.",
    google_sheet_existing_data_unverified: "An Applications tab already contains data that JobHuntAI cannot verify. It was left untouched; rename it to preserve it, then retry setup.",
    google_sheet_applications_source_changed: "Application records changed during sync. The database remains authoritative; retry sync to publish the latest version.",
    job_pool_sheet_not_configured: "Connect Google Sheets to create your JobHuntAI spreadsheet.",
    job_pool_sheet_not_ready: "The Sheet is not current yet. Sync it before starting a search.",
    job_pool_sheet_search_active: "A job search is already using this Sheet. Wait for it to finish, then retry the sync.",
    job_pool_sheet_failed: "The spreadsheet could not be confirmed. Your database records remain safe; retry the sync in a moment.",
    google_sheet_grid_limit: "The Job Pool tab needs more rows before it can be verified. Retry the sync; your database jobs are safe.",
    job_pool_sheet_sync_busy: "Another Sheet sync is in progress. Wait a moment and retry.",
    job_pool_sheet_drive_check_active: "A scheduled search is verifying the Job Pool Sheet. Wait briefly, then retry the sync.",
    job_pool_changed_during_sync: "The job pool changed during sync. Nothing was dispatched; retry the sync.",
    google_sheet_tabs_missing: "The managed Job Pool or Job Pool Manifest tab is missing. Restore the tab names or contact support.",
    gmail_oauth_server_config_missing: "Google connection is not configured on the server.",
  };
  return NextResponse.json({ ok: false, code, error: messages[code] || code }, { status });
}

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const [{ data: refreshToken, error: credentialError }, sheet, { data: automationSettings, error: automationError }] = await Promise.all([
      supabase.rpc("get_gmail_refresh_token"),
      getJobPoolSheetStatus(supabase, profile.user_id),
      supabase.rpc("get_automation_settings"),
    ]);
    if (automationError) throw automationError;
    return NextResponse.json({
      ok: true,
      sheet: {
        ...sheet,
        applicationRows: Number(automationSettings?.last_sheet_sync_rows || 0),
        applicationSyncedAt: automationSettings?.last_sheet_sync_at || null,
        applicationSyncError: automationSettings?.last_sheet_sync_error || null,
      },
      googleConnection: credentialError ? "unavailable" : refreshToken ? "connected" : "not_connected",
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  let releaseClient: any = null;
  let releaseLeaseId: string | null = null;
  try {
    const body = record(await request.json().catch(() => ({})));
    const { supabase, profile } = await requireProfile();
    releaseClient = supabase;

    if (body.action === "create" || body.action === "sync") {
      const result = await syncJobPoolSheetForCurrentUser(supabase, profile.user_id, {
        createIfMissing: body.action === "create",
      });
      if (!result.spreadsheetId) throw new Error("google_sheet_create_missing_id");
      const tracker = await syncTrackerIntoManagedWorkbook(supabase, profile.id, {
        spreadsheetId: result.spreadsheetId,
        spreadsheetUrl: result.spreadsheetUrl,
        spreadsheetTitle: result.spreadsheetTitle,
      });
      return NextResponse.json({ ok: true, sheet: { ...await getJobPoolSheetStatus(supabase, profile.user_id), applicationRows: tracker.rowCount }, synced: result.synced }, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    if (body.action === "prepare-access-test") {
      const publication = await syncJobPoolSheetForCurrentUser(supabase, profile.user_id, { holdLease: true });
      releaseLeaseId = publication.leaseId;
      const snapshot = await currentJobPoolSheetSnapshot(supabase, profile.user_id);
      if (snapshot.publicationId !== publication.publicationId) throw new Error("job_pool_changed_during_sync");
      const prepared = {
        ok: true,
        leaseId: publication.leaseId,
        publicationId: snapshot.publicationId,
        websiteInstruction: buildJobPoolAccessTestInstruction(snapshot),
        sheet: await getJobPoolSheetStatus(supabase, profile.user_id),
      };
      // Keep the lease alive while the Website Bridge reads the Sheet.
      releaseLeaseId = null;
      return NextResponse.json({
        ...prepared,
      }, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (body.action === "release-access-test") {
      const leaseId = typeof body.leaseId === "string" && UUID_RE.test(body.leaseId) ? body.leaseId : "";
      if (!leaseId) return NextResponse.json({ ok: false, error: "A valid access-test lease is required." }, { status: 400 });
      await releaseJobPoolSheetLease(supabase, leaseId);
      return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (body.action === "verify-access") {
      const leaseId = typeof body.leaseId === "string" && UUID_RE.test(body.leaseId) ? body.leaseId : "";
      const publicationId = typeof body.publicationId === "string" && UUID_RE.test(body.publicationId) ? body.publicationId : "";
      const dispatchId = typeof body.dispatchId === "string" && UUID_RE.test(body.dispatchId) ? body.dispatchId : "";
      if (!leaseId || !publicationId || !dispatchId) {
        return NextResponse.json({ ok: false, error: "The access test is missing its publication, lease or dispatch reference." }, { status: 400 });
      }
      releaseLeaseId = leaseId;

      const [{ data: publication, error: publicationError }, { data: dispatchResult, error: dispatchError }] = await Promise.all([
        supabase.from("job_pool_sheet_publications")
          .select("id,source_revision,row_count,verification_token")
          .eq("id", publicationId).eq("user_id", profile.user_id).maybeSingle(),
        supabase.rpc("get_chatgpt_dispatch_request", { p_request_id: dispatchId }),
      ]);
      if (publicationError) throw publicationError;
      if (dispatchError) throw dispatchError;
      if (!publication) return NextResponse.json({ ok: false, error: "The access-test Sheet publication was not found." }, { status: 404 });
      const dispatch = record(dispatchResult);
      const outputRefs = record(dispatch.output_refs);
      if (dispatch.action_type !== "bridge.diagnostic" || dispatch.state !== "completed"
        || outputRefs.response_provenance_recorded !== true || typeof dispatch.bridge_response !== "string") {
        return NextResponse.json({ ok: false, error: "The test did not complete with a verified exact-turn Website Bridge response." }, { status: 409 });
      }
      parseJobPoolAccessTestResponse(dispatch.bridge_response, {
        publicationId: publication.id,
        revision: Number(publication.source_revision),
        rowCount: Number(publication.row_count),
        verificationToken: String(publication.verification_token),
      });
      return NextResponse.json({ ok: true, verified: true, publicationId, sheet: await getJobPoolSheetStatus(supabase, profile.user_id) }, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    return NextResponse.json({ ok: false, error: "Unknown Job Pool Sheet action." }, { status: 400 });
  } catch (error) {
    return responseError(error);
  } finally {
    if (releaseClient && releaseLeaseId) {
      try { await releaseJobPoolSheetLease(releaseClient, releaseLeaseId); } catch { /* lease expires after ten minutes if release fails */ }
    }
  }
}
