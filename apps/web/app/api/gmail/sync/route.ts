import { NextResponse } from "next/server";
import { syncGmail } from "@/lib/gmail-sync";

export async function POST() {
  try { return NextResponse.json(await syncGmail()); }
  catch (error: any) { return NextResponse.json({ status: "error", error: error?.message || "Gmail sync failed" }, { status: 500 }); }
}
