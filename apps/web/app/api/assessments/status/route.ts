import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.assessmentId || !["pending", "in_progress", "completed", "expired", "cancelled"].includes(body?.status)) {
      return NextResponse.json({ error: "assessmentId and a valid status are required" }, { status: 400 });
    }
    if (getDataMode() === "local" || !isSupabaseConfigured()) {
      return NextResponse.json({ ok: true, local: true });
    }
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("set_assessment_status", { p_assessment_id: body.assessmentId, p_status: body.status });
    if (error) throw error;
    return NextResponse.json({ ok: true, result: data });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Status update failed" }, { status: 500 });
  }
}
