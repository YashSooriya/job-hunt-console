import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function GET() {
  try {
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("get_chatgpt_bridge_status");
    if (error) throw error;
    return NextResponse.json({ ok: true, ...(data || {}) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to read ChatGPT bridge status." }, { status: statusCode(error) });
  }
}
