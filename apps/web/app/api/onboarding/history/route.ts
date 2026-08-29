import { NextResponse } from "next/server";
import { nullable, requireProfile, statusCode, text } from "@/lib/onboarding/server";

function dateValue(value: unknown) {
  const result = text(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function booleanValue(value: unknown) {
  return value === true || value === "true" || value === "on" || value === 1;
}

function same(left: unknown, right: unknown) {
  return String(left ?? "") === String(right ?? "");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { supabase, profile } = await requireProfile();
    const kind = body.kind === "employment" ? "employment" : "education";
    const current = booleanValue(body.current);
    const now = new Date().toISOString();
    const table = kind === "employment" ? "candidate_employment" : "candidate_education";
    const id = typeof body.id === "string" && body.id ? body.id : null;

    let values: Record<string, unknown>;
    if (kind === "employment") {
      values = {
        profile_id: profile.id,
        employer: text(body.employer, 300),
        role_title: text(body.roleTitle, 300),
        location: nullable(body.location, 300),
        start_date: dateValue(body.startDate),
        end_date: current ? null : dateValue(body.endDate),
        current,
        details: nullable(body.details, 5000),
        verification_status: "verified",
        updated_at: now,
      };
      if (!values.employer || !values.role_title) throw new Error("Employer and role title are required.");
    } else {
      values = {
        profile_id: profile.id,
        institution: text(body.institution, 300),
        qualification: text(body.qualification, 300),
        field_of_study: nullable(body.fieldOfStudy, 300),
        location: nullable(body.location, 300),
        start_date: dateValue(body.startDate),
        end_date: current ? null : dateValue(body.endDate),
        current,
        details: nullable(body.details, 5000),
        verification_status: "verified",
        updated_at: now,
      };
      if (!values.institution || !values.qualification) throw new Error("Institution and qualification are required.");
    }

    if (id) {
      const { data: existing, error: existingError } = await supabase
        .from(table)
        .select("*")
        .eq("id", id)
        .eq("profile_id", profile.id)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) throw new Error("Profile record not found.");

      const fields = kind === "employment"
        ? ["employer", "role_title", "location", "start_date", "end_date", "current", "details"]
        : ["institution", "qualification", "field_of_study", "location", "start_date", "end_date", "current", "details"];
      const unchanged = fields.every((field) => same(existing[field], values[field]));
      values.source_id = unchanged ? existing.source_id || null : null;
      const { error } = await supabase.from(table).update(values).eq("id", id).eq("profile_id", profile.id);
      if (error) throw error;
    } else {
      values.source_id = null;
      const { error } = await supabase.from(table).insert(values);
      if (error) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to save history.",
    }, { status: statusCode(error) });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const kind = searchParams.get("kind") === "employment" ? "employment" : "education";
    if (!id) throw new Error("Record id is required.");
    const { supabase, profile } = await requireProfile();
    const { error } = await supabase
      .from(kind === "employment" ? "candidate_employment" : "candidate_education")
      .delete()
      .eq("id", id)
      .eq("profile_id", profile.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to delete history.",
    }, { status: statusCode(error) });
  }
}
