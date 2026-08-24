import { NextResponse } from "next/server";
import { prepareApplicationContent } from "@/lib/application/content";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await prepareApplicationContent(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare application content.";
    return NextResponse.json({ ok: false, error: message }, { status: /auth/i.test(message) ? 401 : 400 });
  }
}
