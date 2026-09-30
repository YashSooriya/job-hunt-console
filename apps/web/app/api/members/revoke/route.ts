import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const userId = typeof body?.userId === "string" ? body.userId : "";
    if (!UUID_PATTERN.test(userId)) return NextResponse.json({ ok: false, error: "Choose a valid member account." }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("revoke_app_member", { p_user_id: userId });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    if (data?.revoked === false) return NextResponse.json({ ok: false, error: "That member no longer exists. Refresh the Members page." }, { status: 404 });
    return NextResponse.json({ ok: true, membership: data }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ ok: false, error: "Invalid revocation request." }, { status: 400 }); }
}
