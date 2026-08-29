import { NextResponse } from "next/server";
import { nullable, requireProfile, statusCode, text } from "@/lib/onboarding/server";

function numberValue(value: unknown) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 80) throw new Error("Years of experience must be between 0 and 80.");
  return parsed;
}

function same(left: unknown, right: unknown) {
  return String(left ?? "") === String(right ?? "");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { supabase, profile } = await requireProfile();
    const name = text(body.name, 200);
    if (!name) throw new Error("Skill or tool name is required.");
    const category = text(body.category, 100) || "skill";
    const proficiency = nullable(body.proficiency, 100);
    const yearsExperience = numberValue(body.yearsExperience);
    const now = new Date().toISOString();
    const id = typeof body.id === "string" && body.id ? body.id : null;
    const values: Record<string, unknown> = {
      profile_id: profile.id,
      name,
      category,
      proficiency,
      years_experience: yearsExperience,
      verification_status: "verified",
      updated_at: now,
    };

    if (id) {
      const { data: existing, error: existingError } = await supabase
        .from("candidate_skills")
        .select("*")
        .eq("id", id)
        .eq("profile_id", profile.id)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) throw new Error("Skill record not found.");
      const unchanged = ["name", "category", "proficiency", "years_experience"]
        .every((field) => same(existing[field], values[field]));
      values.source_id = unchanged ? existing.source_id || null : null;
      const { error } = await supabase.from("candidate_skills").update(values).eq("id", id).eq("profile_id", profile.id);
      if (error) throw error;
    } else {
      values.source_id = null;
      const { error } = await supabase.from("candidate_skills").upsert(values, { onConflict: "profile_id,name" });
      if (error) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to save skill.",
    }, { status: statusCode(error) });
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new Error("Record id is required.");
    const { supabase, profile } = await requireProfile();
    const { error } = await supabase.from("candidate_skills").delete().eq("id", id).eq("profile_id", profile.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to delete skill.",
    }, { status: statusCode(error) });
  }
}
