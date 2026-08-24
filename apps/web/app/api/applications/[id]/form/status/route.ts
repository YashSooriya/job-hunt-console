import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_form_agent_session_status", { p_application_id: id });
    if (error) throw error;
    let reasoning: unknown[] = [];
    if (data?.session?.id) {
      const result = await supabase.from("browser_agent_reasoning").select("id,status,source,proposal_json,created_at,updated_at").eq("session_id", data.session.id).order("created_at", { ascending: false }).limit(8);
      if (result.error) throw result.error;
      reasoning = result.data || [];
    }
    return NextResponse.json({ ok: true, ...data, reasoning });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
