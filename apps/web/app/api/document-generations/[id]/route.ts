import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ ok: false, error: "A valid document-generation request is required." }, { status: 400 });
    const { supabase } = await requireProfile();
    const { data, error } = await supabase.rpc("get_application_document_generation", { p_request_id: id });
    if (error) throw error;
    if (!data || typeof data !== "object" || Array.isArray(data)) return NextResponse.json({ ok: false, error: "Document-generation request not found." }, { status: 404 });
    return NextResponse.json({ ok: true, request: data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to read document-generation progress." }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
