import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body?.role === "admin" ? "admin" : "member";
    if (!email) return NextResponse.json({ ok: false, error: "Email is required." }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("invite_app_member", { p_email: email, p_role: role });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    return NextResponse.json({ ok: true, invitation: data });
  } catch { return NextResponse.json({ ok: false, error: "Invalid invitation request." }, { status: 400 }); }
}
