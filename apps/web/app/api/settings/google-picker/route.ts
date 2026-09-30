import { NextResponse } from "next/server";

/**
 * Existing-workbook selection was retired when JobHuntAI moved to one
 * owner-scoped managed workbook. Keep this compatibility response so stale
 * clients receive a clear result without receiving a Google access token.
 */
export async function GET() {
  return NextResponse.json({
    ok: false,
    error: "Google Picker is no longer used. Open Settings → Google Sheets to create or open your managed workbook.",
    code: "google_picker_retired",
  }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
