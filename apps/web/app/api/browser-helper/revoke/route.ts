import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const { deviceId } = await request.json();
    if (!deviceId) throw new Error("deviceId is required");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("revoke_browser_agent_device", { p_device_id: deviceId });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...(data || {}) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
