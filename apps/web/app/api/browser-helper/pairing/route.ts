import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_browser_agent_pairing_code");
    if (error) throw error;
    return NextResponse.json({ ok: true, ...data, supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
