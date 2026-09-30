import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { writeJobSearchControlBoolean } from "@/lib/diagnostics/job-search-control-setting";

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const { data, error } = await supabase
      .from("job_search_controls")
      .select("manual_search_cooldown_disabled")
      .eq("user_id", profile.user_id)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json(
      { ok: true, disabled: data?.manual_search_cooldown_disabled === true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to read diagnostic settings." },
      { status: statusCode(error) },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.disabled !== "boolean") {
      return NextResponse.json({ ok: false, error: "The diagnostic cooldown setting must be a boolean." }, { status: 400 });
    }
    const { supabase, profile } = await requireProfile();
    const disabled = await writeJobSearchControlBoolean(supabase, profile.user_id, "manual_search_cooldown_disabled", body.disabled);
    return NextResponse.json({ ok: true, disabled }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to update diagnostic settings." },
      { status: statusCode(error) },
    );
  }
}
