import { NextResponse } from "next/server";
import { getChatGptOperationActivity } from "@/lib/chatgpt-bridge/operation";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function GET() {
  try {
    const { supabase } = await requireProfile();
    const activity = await getChatGptOperationActivity(supabase);
    return NextResponse.json({ ok: true, activity }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to check ChatGPT activity." }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
