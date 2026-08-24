import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("cancel_app_invitation", { p_invitation_id: body?.invitationId });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    return NextResponse.json({ ok: true, invitation: data });
  } catch { return NextResponse.json({ ok: false, error: "Invalid cancellation request." }, { status: 400 }); }
}
