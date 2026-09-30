import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { getJobPoolSheetStatus, syncJobPoolSheetForCurrentUser } from "@/lib/google-job-pool-sheet";
import { syncTrackerIntoManagedWorkbook } from "@/lib/google-sheets";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === "connect") {
      return NextResponse.json({ ok: false, error: "Separate tracker sheets are no longer connected. Open Google Sheets settings to use the single managed workbook." }, { status: 410 });
    }
    if (body?.action !== "create" && body?.action !== "sync") {
      return NextResponse.json({ ok: false, error: "Unknown Google Sheets action." }, { status: 400 });
    }
    const { supabase, user, profile } = await requireProfile();
    const publication = await syncJobPoolSheetForCurrentUser(supabase, user.id, { createIfMissing: body.action === "create" });
    if (!publication.spreadsheetId) throw new Error("google_sheet_create_missing_id");
    const applications = await syncTrackerIntoManagedWorkbook(supabase, profile.id, {
      spreadsheetId: publication.spreadsheetId,
      spreadsheetUrl: publication.spreadsheetUrl,
      spreadsheetTitle: publication.spreadsheetTitle,
    });
    return NextResponse.json({
      ok: true,
      sheet: {
        spreadsheetId: publication.spreadsheetId,
        spreadsheetUrl: publication.spreadsheetUrl,
        title: publication.spreadsheetTitle || "JobHuntAI",
        tab: "Applications",
        rows: applications.rowCount,
      },
      pool: await getJobPoolSheetStatus(supabase, user.id),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Google Sheets setup failed." }, { status: statusCode(error) });
  }
}
