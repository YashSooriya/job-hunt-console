import { NextResponse } from "next/server";
import { publishApplicationDocumentItem } from "@/lib/document/google-drive";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(_: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const { itemId } = await params;
    if (!UUID.test(itemId)) return NextResponse.json({ ok: false, error: "Generated document not found." }, { status: 404 });
    const { supabase, user } = await requireProfile();
    const result = await publishApplicationDocumentItem(supabase, user.id, itemId);
    return NextResponse.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to publish documents to Google Drive." }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
