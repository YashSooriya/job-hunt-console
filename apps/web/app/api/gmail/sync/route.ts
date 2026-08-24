import { NextResponse } from "next/server";
import { syncGmail } from "@/lib/gmail-sync";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await syncGmail({ force: body?.force === true }));
  }
  catch (error: any) { return NextResponse.json({ status: "error", error: error?.message || "Gmail sync failed" }, { status: 500 }); }
}
