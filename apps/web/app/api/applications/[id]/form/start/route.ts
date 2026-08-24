import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const supabase = await createClient();
    if (body.deviceId) {
      const { data, error } = await supabase.rpc("start_form_agent_session_for_device", { p_application_id: id, p_device_id: body.deviceId });
      if (error) throw error;
      return NextResponse.json({ ok: true, ...data, queued_for_helper: true });
    }
    const { data, error } = await supabase.rpc("start_form_agent_session", { p_application_id: id });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...data, supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL, manual_fallback: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
