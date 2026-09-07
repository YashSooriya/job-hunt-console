import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

function memoryResponse(settings: Record<string, any> | null) {
  const usePreviousKnowledge = settings?.use_previous_knowledge !== false;
  const confirmed = Boolean(settings?.memory_enabled_user_confirmed) && usePreviousKnowledge;
  const decision = settings?.consent_status || (confirmed ? "allowed" : "undecided");
  return {
    confirmed,
    decision,
    status: confirmed ? "user_confirmed" : decision === "declined" ? "user_declined" : "unknown",
    usePreviousKnowledge,
    memorySyncEnabled: Boolean(settings?.memory_sync_enabled) && confirmed,
    reminderRequired: !confirmed,
    confirmedAt: settings?.memory_confirmed_at || null,
    importStatus: settings?.memory_import_status || "not_requested",
    importDispatchId: settings?.memory_import_dispatch_id || null,
    importError: settings?.memory_import_error || null,
  };
}

async function readSettings(supabase: any, profileId: string) {
  const { data, error } = await supabase
    .from("candidate_chatgpt_memory")
    .select("memory_enabled_user_confirmed,use_previous_knowledge,memory_confirmed_at,consent_status,memory_sync_enabled,memory_import_status,memory_import_dispatch_id,memory_import_error")
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
      consent_status: action === "confirm_enabled"
        ? "allowed"
        : action === "reset"
          ? "undecided"
          : current?.consent_status || "undecided",
      use_previous_knowledge: action === "set_previous_knowledge"
        ? body.enabled !== false
        : current?.use_previous_knowledge !== false,
      // Confirming that ChatGPT Memory is enabled is not, by itself, consent
      // for JobHuntAI to send profile data back to ChatGPT. The onboarding
      // Memory card records that separate, explicit permission.
      memory_sync_enabled: action === "reset"
        ? false
        : Boolean(current?.memory_sync_enabled),
      memory_import_status: action === "reset" ? "not_requested" : current?.memory_import_status || "not_requested",
      memory_import_dispatch_id: action === "reset" ? null : current?.memory_import_dispatch_id || null,
      memory_import_error: action === "reset" ? null : current?.memory_import_error || null,
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
