import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "Unable to read launch status.";
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_v1_launch_status");
    if (error) throw error;
    const url = new URL(request.url);
    const hosted = !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    const productionDataMode = process.env.JOBHUNT_DATA_MODE === "supabase";
    const runtime = { hosted, hostname: url.hostname, production_data_mode: productionDataMode };
    const databaseReady = Boolean(data?.database_launch_ready);
    return NextResponse.json({ ok: true, ...data, runtime, v1_operational: hosted && productionDataMode && databaseReady });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
}
