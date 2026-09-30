import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { POST as savePreferences } from "@/app/api/onboarding/preferences/route";

// The Jobs form has one additional contract: a successful save also queues
// the plain-language setup task through the generic Website Bridge dispatch.
// Onboarding saves continue to persist preferences without sending a task.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, dispatchSetup: true }),
  });
  return savePreferences(forwarded);
}

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const { data, error } = await supabase
      .from("candidate_preferences")
      .select("preferences")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ ok: true, preferences: data?.preferences || {} }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to load job-search preferences." }, { status: statusCode(error) });
  }
}
