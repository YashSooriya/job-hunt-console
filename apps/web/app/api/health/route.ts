import { NextResponse } from "next/server";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";

async function checkSupabaseReachability() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return false;
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/health`, {
      headers: { apikey: key },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  const googleOAuthConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const supabaseConfigured = isSupabaseConfigured();
  const supabaseReachable = supabaseConfigured ? await checkSupabaseReachability() : false;
  const productionDataMode = getDataMode() === "supabase";
  const ok = supabaseConfigured && supabaseReachable && productionDataMode;
  return NextResponse.json({
    ok,
    service: "job-hunt-console",
    milestone: "22",
    deploymentTarget: "cloudflare-workers",
    dataMode: getDataMode(),
    supabaseConfigured,
    supabaseReachable,
    inviteOnlyMembership: true,
    googleOAuthConfigured,
    gmailReadOnlyConfigured: googleOAuthConfigured,
    paidOpenAiRequired: false,
    timestamp: new Date().toISOString(),
  }, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
