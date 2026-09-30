import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body?.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
    }
    if (role !== "admin" && role !== "member") {
      return NextResponse.json({ ok: false, error: "Choose a valid invitation role." }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("invite_app_member", { p_email: email, p_role: role });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    return NextResponse.json({ ok: true, invitation: data }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ ok: false, error: "Invalid invitation request." }, { status: 400 }); }
}
