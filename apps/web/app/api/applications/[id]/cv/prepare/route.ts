import { NextResponse } from "next/server";
import { prepareCvForApplication } from "@/lib/document/cv";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await prepareCvForApplication(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare CV.";
    return NextResponse.json({ ok: false, error: message }, { status: /auth/i.test(message) ? 401 : 400 });
  }
}
