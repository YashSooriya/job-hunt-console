import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { writeJobSearchControlBoolean } from "@/lib/diagnostics/job-search-control-setting";

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const enabled = await readChatGptTestingMode(supabase, profile.user_id);
    return NextResponse.json({ ok: true, enabled }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to read ChatGPT testing mode." },
      { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      return NextResponse.json({ ok: false, error: "The ChatGPT testing-mode setting must be a boolean." }, { status: 400 });
    }

    const { supabase, profile } = await requireProfile();
    const enabled = await writeJobSearchControlBoolean(supabase, profile.user_id, "testing_mode_enabled", body.enabled);
    return NextResponse.json({ ok: true, enabled }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to update ChatGPT testing mode." },
      { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
