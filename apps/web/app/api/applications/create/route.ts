import { NextResponse } from "next/server";
import { createApplicationFromJob } from "@/lib/application/create";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
    const origin = body?.origin === "auto_prepare" ? "auto_prepare" : "manual";
    if (!jobId) return NextResponse.json({ ok: false, error: "jobId is required." }, { status: 400 });

    const result = await createApplicationFromJob(jobId, origin);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create application.";
    return NextResponse.json({ ok: false, error: message }, { status: /auth/i.test(message) ? 401 : 400 });
  }
}
