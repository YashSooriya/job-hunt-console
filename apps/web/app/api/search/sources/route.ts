import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sourceKey = typeof body?.sourceKey === "string" ? body.sourceKey.trim().slice(0, 100) : "";
    if (!sourceKey) throw new Error("Search source is required.");
    const { supabase, profile } = await requireProfile();
    const { data, error } = await supabase.from("job_search_sources")
      .update({ enabled: Boolean(body.enabled), health: body.enabled ? "unknown" : "disabled", updated_at: new Date().toISOString() })
      .eq("user_id", profile.user_id)
      .eq("source_key", sourceKey)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Search source not found. Start a search once to initialise sources.");
    return NextResponse.json({ ok: true, source: data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to update search source." }, { status: statusCode(error) });
  }
}
