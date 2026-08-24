import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

function memoryResponse(settings: Record<string, any> | null) {
  const usePreviousKnowledge = settings?.use_previous_knowledge !== false;
  const confirmed = Boolean(settings?.memory_enabled_user_confirmed) && usePreviousKnowledge;
  return {
    confirmed,
    status: confirmed ? "user_confirmed" : "unknown",
    usePreviousKnowledge,
    reminderRequired: !confirmed,
    confirmedAt: settings?.memory_confirmed_at || null,
  };
}

async function readSettings(supabase: any, profileId: string) {
  const { data, error } = await supabase
    .from("candidate_chatgpt_memory")
    .select("memory_enabled_user_confirmed,use_previous_knowledge,memory_confirmed_at")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    return NextResponse.json({ ok: true, memory: memoryResponse(await readSettings(supabase, profile.id)) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to read ChatGPT Memory setup." },
      { status: statusCode(error) },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    if (action !== "confirm_enabled" && action !== "reset" && action !== "set_previous_knowledge") {
      throw new Error("Unknown ChatGPT Memory action.");
    }

    const { supabase, profile } = await requireProfile();
    const current = await readSettings(supabase, profile.id);
    const now = new Date().toISOString();
    const values: Record<string, unknown> = {
      profile_id: profile.id,
      memory_enabled_user_confirmed: action === "confirm_enabled"
        ? true
        : action === "reset"
          ? false
          : Boolean(current?.memory_enabled_user_confirmed),
      use_previous_knowledge: action === "set_previous_knowledge"
        ? body.enabled !== false
        : current?.use_previous_knowledge !== false,
      memory_confirmed_at: action === "confirm_enabled"
        ? now
        : action === "reset"
          ? null
          : current?.memory_confirmed_at || null,
      updated_at: now,
    };
    const { error } = await supabase.from("candidate_chatgpt_memory").upsert(values, { onConflict: "profile_id" });
    if (error) throw error;
    return NextResponse.json({ ok: true, memory: memoryResponse(values as Record<string, any>) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to save ChatGPT Memory setup." },
      { status: statusCode(error) },
    );
  }
}
