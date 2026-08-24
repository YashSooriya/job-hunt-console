import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { getDocumentVersionById } from "@/lib/data/repository";
import { repoPath } from "@/lib/repo-path";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const record = await getDocumentVersionById(versionId);
  if (!record || !record.version.renderedObjectKey) return NextResponse.json({ error: "Rendered PDF not found." }, { status: 404 });
  let bytes: Uint8Array;
  if (record.source === "supabase") {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const result = await supabase.storage.from("application-documents").download(record.version.renderedObjectKey);
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 404 });
    bytes = new Uint8Array(await result.data.arrayBuffer());
  } else {
    const file = repoPath(...record.version.renderedObjectKey.split("/"));
    bytes = new Uint8Array(await fs.readFile(file));
  }
  // Next.js 16's server DOM types do not accept Uint8Array<ArrayBufferLike>
  // directly as BodyInit. Copy into an owned ArrayBuffer so the response body
  // has the exact web-platform type expected by Response.
  const body = bytes.slice().buffer as ArrayBuffer;
  return new Response(body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Yashwanth_Sooriyakanthan_${record.document.kind === "cover_letter" ? "Cover_Letter" : "CV"}_v${record.version.versionNumber}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
