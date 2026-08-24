import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export async function GET() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_access_roster");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
  return NextResponse.json({ ok: true, roster: data }, { headers: { "Cache-Control": "no-store" } });
}
