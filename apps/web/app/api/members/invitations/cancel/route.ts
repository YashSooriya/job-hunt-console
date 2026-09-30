import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const invitationId = typeof body?.invitationId === "string" ? body.invitationId : "";
    if (!UUID_PATTERN.test(invitationId)) return NextResponse.json({ ok: false, error: "Choose a valid invitation." }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("cancel_app_invitation", { p_invitation_id: invitationId });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    if (data?.cancelled === false) return NextResponse.json({ ok: false, error: data.reason === "not_found" ? "That invitation no longer exists. Refresh the Members page." : "That invitation is no longer pending." }, { status: data.reason === "not_found" ? 404 : 409 });
    return NextResponse.json({ ok: true, invitation: data }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ ok: false, error: "Invalid cancellation request." }, { status: 400 }); }
}
