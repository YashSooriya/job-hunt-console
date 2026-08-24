import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const deviceId = String(body.deviceId || "");
    const providerFamily = String(body.providerFamily || "").trim().toLowerCase();
    if (!deviceId || !providerFamily) throw new Error("A paired helper and provider family are required.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("start_form_agent_acceptance_session_for_device", {
      p_application_id: id,
      p_device_id: deviceId,
      p_provider_family: providerFamily,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
