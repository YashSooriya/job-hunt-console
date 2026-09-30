import { NextResponse } from "next/server";
import { createApplicationFromJob } from "@/lib/application/create";

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
    if (typeof value.details === "string" && value.details.trim()) return value.details.trim();
  }
  return "Unable to create application.";
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
    const origin = body?.origin === "auto_prepare" ? "auto_prepare" : "manual";
    if (!jobId) return NextResponse.json({ ok: false, error: "jobId is required." }, { status: 400 });

    const result = await createApplicationFromJob(jobId, origin);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = errorMessage(error);
    const status = /auth|membership/i.test(message) ? 401 : /not found/i.test(message) ? 404 : /analysis|ineligible|rejected|snapshot|cv family/i.test(message) ? 409 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
