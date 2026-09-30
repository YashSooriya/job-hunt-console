import { NextResponse } from "next/server";
import { DEFAULT_DOCUMENT_TEMPLATE, isDocumentTemplateId } from "@/lib/document/templates";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

export async function GET() {
  try {
    const { supabase, user } = await requireProfile();
    const { data, error } = await supabase.from("document_preferences").select("default_template_id").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    return NextResponse.json({ ok: true, defaultTemplateId: isDocumentTemplateId(data?.default_template_id) ? data.default_template_id : DEFAULT_DOCUMENT_TEMPLATE }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to read document preferences." }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (!isDocumentTemplateId(body.defaultTemplateId)) return NextResponse.json({ ok: false, error: "Choose one of the available document themes." }, { status: 400 });
    const { supabase, user } = await requireProfile();
    const { error } = await supabase.from("document_preferences").upsert({ user_id: user.id, default_template_id: body.defaultTemplateId, updated_at: new Date().toISOString() });
    if (error) throw error;
    return NextResponse.json({ ok: true, defaultTemplateId: body.defaultTemplateId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to save document preferences." }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
