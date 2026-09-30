import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMATS = {
  pdf: { key: "pdf_object_key", type: "application/pdf", extension: "pdf" },
  docx: { key: "docx_object_key", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" },
} as const;

export async function GET(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const { itemId } = await params;
    if (!UUID.test(itemId)) return NextResponse.json({ error: "Generated document not found." }, { status: 404 });
    const format = new URL(request.url).searchParams.get("format") || "pdf";
    if (format !== "pdf" && format !== "docx") return NextResponse.json({ error: "Choose PDF or Word format." }, { status: 400 });
    const selectedFormat = FORMATS[format];
    const { supabase, user } = await requireProfile();
    const { data: item, error } = await supabase.from("document_generation_items")
      .select("id,user_id,document_kind,state,version_number,pdf_object_key,docx_object_key")
      .eq("id", itemId).eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!item || item.state !== "ready" || !item[selectedFormat.key]) return NextResponse.json({ error: "Generated document not found." }, { status: 404 });
    const { data, error: downloadError } = await supabase.storage.from("application-documents").download(item[selectedFormat.key]);
    if (downloadError) return NextResponse.json({ error: "The saved document is temporarily unavailable." }, { status: 503 });
    const body = await data.arrayBuffer();
    const label = item.document_kind === "cv" ? "CV" : "Cover_Letter";
    return new Response(body, {
      headers: {
        "Content-Type": selectedFormat.type,
        "Content-Length": String(body.byteLength),
        "Content-Disposition": (format === "pdf" ? "inline" : "attachment") + '; filename="JobHuntAI_' + label + "_v" + (item.version_number || 1) + "." + selectedFormat.extension + '"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to download the generated document." }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
