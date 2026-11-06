import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { statusCode } from "@/lib/onboarding/server";
import { advanceMemoryFitBatch } from "@/lib/job-fit-memory-v4/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new Error("AUTH_REQUIRED");
    const body = await request.json().catch(() => ({}));
    const batchId = typeof body?.batchId === "string" ? body.batchId : "";
    if (!UUID.test(batchId)) return NextResponse.json({ ok: false, error: "A valid Memory-only analysis batch is required." }, { status: 400 });
    const reprocessCapturedChunkId = typeof body?.reprocessCapturedChunkId === "string" ? body.reprocessCapturedChunkId : undefined;
    if (reprocessCapturedChunkId && !UUID.test(reprocessCapturedChunkId)) {
      return NextResponse.json({ ok: false, error: "A valid saved response group is required for local reprocessing." }, { status: 400 });
    }
    const result = await advanceMemoryFitBatch(supabase, data.user.id, batchId, { reprocessCapturedChunkId });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to advance Memory-only job analysis.";
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    const status = code === "42P01" || code === "PGRST202" ? 503 : statusCode(error);
    return NextResponse.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
