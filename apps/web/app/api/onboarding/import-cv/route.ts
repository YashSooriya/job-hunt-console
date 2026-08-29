import { NextResponse } from "next/server";
import { importCandidateSource } from "@/lib/onboarding/import-source";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

function stringValue(value: FormDataEntryValue | unknown) {
  return typeof value === "string" ? value : null;
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    let file: File | null = null;
    let text: string | null = null;
    let title: string | null = null;
    let sourceType: string | null = null;
    let replaceExisting = false;

    if (contentType.includes("application/json")) {
      const body = await request.json() as Record<string, unknown>;
      text = typeof body.text === "string" ? body.text : null;
      title = typeof body.title === "string" ? body.title : null;
      sourceType = typeof body.sourceType === "string" ? body.sourceType : null;
      replaceExisting = body.replaceExisting === true;
    } else {
      const form = await request.formData();
      const formFile = form.get("file");
      file = formFile instanceof File ? formFile : null;
      text = stringValue(form.get("text"));
      title = stringValue(form.get("title"));
      sourceType = stringValue(form.get("sourceType"));
      replaceExisting = form.get("replaceExisting") === "true";
    }

    const { supabase, user, profile } = await requireProfile();
    const result = await importCandidateSource({ supabase, user, profile, file, text, title, sourceType, replaceExisting });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to import source." },
      { status: statusCode(error) },
    );
  }
}
