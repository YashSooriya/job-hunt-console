import { NextResponse } from "next/server";
export async function POST() {
  return NextResponse.json({ ok: false, error: "Use the explicit custom-document request on the application page. No legacy cover letter was started." }, { status: 410 });
}
