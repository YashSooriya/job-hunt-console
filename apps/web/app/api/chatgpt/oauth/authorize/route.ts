import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requiredAuthorizationParams } from "@/lib/chatgpt/oauth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = requiredAuthorizationParams(url);
  if ("error" in params) return NextResponse.json({ error: params.error }, { status: 400 });

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    const next = url.pathname + url.search;
    return NextResponse.redirect(new URL("/login?next=" + encodeURIComponent(next), url));
  }
  const { data: membership, error } = await supabase.rpc("get_my_membership");
  if (error || !(membership as { active?: boolean } | null)?.active) {
    return NextResponse.json({ error: "An active JobHuntAI Console membership is required." }, { status: 403 });
  }
  const consentUrl = new URL("/chatgpt/authorize", url);
  consentUrl.search = url.search;
  return NextResponse.redirect(consentUrl);
}
