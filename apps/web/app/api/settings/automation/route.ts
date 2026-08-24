import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const CADENCES = new Set(["manual", "hourly", "every_4_hours", "daily", "weekdays"]);

export async function GET() {
  try {
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("get_automation_settings");
    if (error) throw error;
    return NextResponse.json({ ok: true, settings: data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to load automation settings." }, { status: statusCode(error) });
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireProfile();
    const body = await request.json().catch(() => ({}));
    const cadence = typeof body?.emailMonitoringCadence === "string" ? body.emailMonitoringCadence : "daily";
    if (!CADENCES.has(cadence)) return NextResponse.json({ ok: false, error: "Choose a valid email monitoring cadence." }, { status: 400 });
    const { data, error } = await supabase.rpc("save_automation_settings", {
      p_email_monitoring_enabled: body?.emailMonitoringEnabled !== false,
      p_email_monitoring_cadence: cadence,
      p_spreadsheet_sync_enabled: body?.spreadsheetSyncEnabled === true,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, settings: data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to save automation settings." }, { status: statusCode(error) });
  }
}

