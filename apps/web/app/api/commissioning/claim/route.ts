import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_bootstrap_import");
  const url = new URL("/commissioning", request.url);
  if (error) url.searchParams.set("claim_error", "1");
  return NextResponse.redirect(url, { status: 303 });
}
