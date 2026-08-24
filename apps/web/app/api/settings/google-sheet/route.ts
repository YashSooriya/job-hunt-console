import { NextResponse } from "next/server";
import { statusCode } from "@/lib/onboarding/server";
import { connectTrackerSpreadsheetForCurrentUser, createTrackerSpreadsheetForCurrentUser, syncTrackerSpreadsheetForCurrentUser } from "@/lib/google-sheets";

function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Google Sheet operation failed.";
  const status = message === "google_reconnect_required" || message === "google_sheet_tab_missing" || message === "live_tracker_required" ? 409
    : message === "google_sheet_not_accessible" ? 403
      : statusCode(error);
  const userMessages: Record<string, string> = {
    google_reconnect_required: "Reconnect Google to grant the narrow drive.file permission needed for the tracker Sheet.",
    google_sheet_not_accessible: "The selected Sheet is not accessible with this Google account. Choose a Sheet you can edit, then try again.",
    google_sheet_tab_missing: "The managed tab no longer exists. Choose the Sheet again and select a tab name to recreate it.",
    google_sheet_tab_invalid: "Choose a tab name without slashes, brackets, colons, question marks or asterisks.",
    live_tracker_required: "A live Supabase tracker is required before it can be written to the managed Google Sheet.",
  };
  const userMessage = userMessages[message] || message;
  return NextResponse.json({ ok: false, error: userMessage, code: message }, { status });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === "create") return NextResponse.json({ ok: true, sheet: await createTrackerSpreadsheetForCurrentUser() });
    if (body?.action === "connect") {
      return NextResponse.json({
        ok: true,
        sheet: await connectTrackerSpreadsheetForCurrentUser(body?.spreadsheetId, body?.tab),
      });
    }
    if (body?.action === "sync") return NextResponse.json({ ok: true, result: await syncTrackerSpreadsheetForCurrentUser() });
    return NextResponse.json({ ok: false, error: "Unknown Google Sheet action." }, { status: 400 });
  } catch (error) {
    return responseError(error);
  }
}
