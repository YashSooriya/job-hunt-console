import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("revoke_app_member", { p_user_id: body?.userId });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    return NextResponse.json({ ok: true, membership: data });
  } catch { return NextResponse.json({ ok: false, error: "Invalid revocation request." }, { status: 400 }); }
}
