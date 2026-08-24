import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { isUuid } from "@/lib/chatgpt/dispatch-registry";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!isUuid(body?.requestId)) return NextResponse.json({ ok: false, error: "A valid dispatch request id is required." }, { status: 400 });
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("cancel_chatgpt_dispatch_request", { p_request_id: body.requestId });
    if (error) throw error;
    return NextResponse.json({ ok: true, dispatch: data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to cancel the ChatGPT dispatch." }, { status: statusCode(error) });
  }
}
