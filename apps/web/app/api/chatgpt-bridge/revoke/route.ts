import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { isUuid } from "@/lib/chatgpt/dispatch-registry";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!isUuid(body?.deviceId)) return NextResponse.json({ ok: false, error: "A valid bridge device id is required." }, { status: 400 });
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("revoke_chatgpt_bridge_device", { p_device_id: body.deviceId });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to revoke the ChatGPT bridge device." }, { status: statusCode(error) });
  }
}
