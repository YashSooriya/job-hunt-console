import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/config";

export async function POST(request: Request) {
  if (isSupabaseConfigured()) {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
