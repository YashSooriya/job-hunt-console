import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.sessionId) throw new Error("sessionId is required");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("approve_form_agent_final_review", { p_session_id: body.sessionId });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
