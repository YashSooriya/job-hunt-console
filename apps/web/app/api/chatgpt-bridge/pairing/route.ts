import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function POST() {
  try {
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("create_chatgpt_bridge_pairing_code");
    if (error) throw error;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    return NextResponse.json({ ok: true, ...data, bridge_url: supabaseUrl ? `${supabaseUrl}/functions/v1/chatgpt-bridge` : null }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to create a pairing code." }, { status: statusCode(error) });
  }
}
