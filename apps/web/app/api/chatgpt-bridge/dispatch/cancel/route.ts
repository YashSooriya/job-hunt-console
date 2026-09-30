import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Stop one user-owned Website Bridge request without changing ChatGPT
 * history. This is intentionally a separate, explicit recovery boundary so
 * a stale queued request can be quarantined before an extension update is
 * re-enabled.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const requestId = body.requestId;
    if (!isUuid(requestId)) throw new Error("A valid dispatch request id is required.");
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("cancel_chatgpt_dispatch_request", { p_request_id: requestId });
    if (error) throw error;
    return NextResponse.json({ ok: true, dispatch: data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to cancel the ChatGPT dispatch." }, { status: statusCode(error) });
  }
}
