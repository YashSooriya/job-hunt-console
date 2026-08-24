import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_form_agent_session_status", { p_application_id: id });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
