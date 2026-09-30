import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const userId = typeof body?.userId === "string" ? body.userId : "";
    const action = body?.action;
    const role = body?.role;

    if (!UUID_PATTERN.test(userId)) {
      return NextResponse.json({ ok: false, error: "Choose a valid member account." }, { status: 400 });
    }
    if (action !== "restore" && action !== "set_role") {
      return NextResponse.json({ ok: false, error: "Choose a supported member action." }, { status: 400 });
    }
    if (action === "set_role" && role !== "member" && role !== "admin") {
      return NextResponse.json({ ok: false, error: "Choose a valid member role." }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("manage_app_member", {
      p_action: action,
      p_user_id: userId,
      p_role: action === "set_role" ? role : null,
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    if (data?.ok === false) return NextResponse.json({ ok: false, error: "That member could not be found." }, { status: 404 });
    return NextResponse.json({ ok: true, result: data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid member-management request." }, { status: 400 });
  }
}
