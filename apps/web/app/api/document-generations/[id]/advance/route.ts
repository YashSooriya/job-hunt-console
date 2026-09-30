import { NextResponse } from "next/server";
import { advanceDocumentGeneration, loadDocumentGeneration } from "@/lib/document/service";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ ok: false, error: "A valid document-generation request is required." }, { status: 400 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const dispatchId = typeof body.dispatchId === "string" ? body.dispatchId : "";
    const chunkIndex = Number(body.chunkIndex);
    if (!UUID.test(dispatchId) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      return NextResponse.json({ ok: false, error: "A valid Bridge dispatch and document step are required." }, { status: 400 });
    }
    const { supabase, user } = await requireProfile();
    const generation = await loadDocumentGeneration(supabase, user.id, id);
    if (!generation) return NextResponse.json({ ok: false, error: "Document-generation request not found." }, { status: 404 });
    const result = await advanceDocumentGeneration(supabase, user.id, generation.request, generation.items, chunkIndex, dispatchId);
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to capture or save the document response.";
    return NextResponse.json({ ok: false, error: message }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
