import { NextResponse } from "next/server";
import { getChatGptOperationActivity, setChatGptActionLockDisabled } from "@/lib/chatgpt-bridge/operation";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const { supabase } = await requireProfile();
    const activity = await getChatGptOperationActivity(supabase);
    return NextResponse.json({ ok: true, enabled: activity.lock_disabled, busy: activity.busy }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to read the ChatGPT action-lock setting.",
    }, { status: statusCode(error), headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      return NextResponse.json({ ok: false, error: "The ChatGPT action-lock setting must be a boolean." }, { status: 400, headers: NO_STORE });
    }

    const { supabase } = await requireProfile();
    const result = await setChatGptActionLockDisabled(supabase, body.enabled);
    const enabled = result.lock_disabled === true;
    if (result.ok !== true) {
      return NextResponse.json({
        ok: false,
        enabled,
        busy: result.busy === true,
        error: typeof result.error === "string" ? result.error : "The ChatGPT action-lock setting could not be changed.",
      }, { status: result.busy === true ? 409 : 400, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, enabled, busy: result.busy === true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to update the ChatGPT action-lock setting.",
    }, { status: statusCode(error), headers: NO_STORE });
  }
}
