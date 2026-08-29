import { NextResponse } from "next/server";
import { cleanUrlValue } from "@/lib/onboarding/value-format";
import { nullable, requireProfile, statusCode, text } from "@/lib/onboarding/server";

function dateValue(value: unknown) {
  const result = text(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function listValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim().slice(0, 200))
      .slice(0, 40);
  }
  return typeof value === "string"
    ? value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean).slice(0, 40)
    : [];
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { supabase, profile } = await requireProfile();
    const kind = body.kind === "publication" ? "publication" : "project";
    const id = typeof body.id === "string" && body.id ? body.id : null;
    const now = new Date().toISOString();
    const table = kind === "publication" ? "candidate_publications" : "candidate_projects";
    let values: Record<string, unknown>;

    if (kind === "publication") {
      const title = text(body.title, 1000);
      if (!title) throw new Error("Publication title is required.");
      values = {
        profile_id: profile.id,
        title,
        publication_type: text(body.publicationType, 100) || "publication",
        venue: nullable(body.venue, 500),
        published_on: dateValue(body.publishedOn),
        url: cleanUrlValue(body.url),
        citation: nullable(body.citation, 5000),
        verification_status: "verified",
        updated_at: now,
      };
    } else {
      const title = text(body.title, 500);
      if (!title) throw new Error("Project title is required.");
      values = {
        profile_id: profile.id,
        title,
        description: nullable(body.description, 5000),
        technologies: listValue(body.technologies),
        start_date: dateValue(body.startDate),
        end_date: dateValue(body.endDate),
        url: cleanUrlValue(body.url),
        verification_status: "verified",
        updated_at: now,
      };
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
      const fields = kind === "publication"
        ? ["title", "publication_type", "venue", "published_on", "url", "citation"]
        : ["title", "description", "technologies", "start_date", "end_date", "url"];
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
      error: error instanceof Error ? error.message : "Unable to save item.",
    }, { status: statusCode(error) });
  }
}

export async function DELETE(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const kind = params.get("kind") === "publication" ? "publication" : "project";
    if (!id) throw new Error("Record id is required.");
    const { supabase, profile } = await requireProfile();
    const { error } = await supabase
      .from(kind === "publication" ? "candidate_publications" : "candidate_projects")
      .delete()
      .eq("id", id)
      .eq("profile_id", profile.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to delete item.",
    }, { status: statusCode(error) });
  }
}
