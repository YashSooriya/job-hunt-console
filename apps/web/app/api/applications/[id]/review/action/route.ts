import { NextResponse } from "next/server";
import { reviewApplication } from "@/lib/application/review";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const result = await reviewApplication(id, body);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update application review.";
    return NextResponse.json({ ok: false, error: message }, { status: /auth/i.test(message) ? 401 : 400 });
  }
}
