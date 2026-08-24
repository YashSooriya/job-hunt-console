import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.reasoningId || !["accept", "reject"].includes(body.decision)) throw new Error("reasoningId and a valid decision are required");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("review_browser_reasoning", { p_reasoning_id: body.reasoningId, p_decision: body.decision });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...(data || {}) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
