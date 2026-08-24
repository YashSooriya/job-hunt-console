import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAllowedRedirectUri } from "@/lib/chatgpt/oauth";

function readString(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const form = await request.formData();
  const clientId = readString(form, "client_id");
  const redirectUri = readString(form, "redirect_uri");
  const codeChallenge = readString(form, "code_challenge");
  const codeChallengeMethod = readString(form, "code_challenge_method");
  const scope = readString(form, "scope") || "profile:read work:write";
  const state = readString(form, "state");
  if (!clientId || !isAllowedRedirectUri(redirectUri) || !codeChallenge || codeChallengeMethod !== "S256") {
    return NextResponse.json({ error: "Invalid OAuth authorization request." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.redirect(new URL("/login", request.url), 303);
  const { data: membership, error: membershipError } = await supabase.rpc("get_my_membership");
  if (membershipError || !(membership as { active?: boolean } | null)?.active) {
    return NextResponse.json({ error: "An active Job Hunt Console membership is required." }, { status: 403 });
  }

  const { data, error } = await supabase.rpc("chatgpt_issue_authorization_code", {
    p_client_id: clientId,
    p_redirect_uri: redirectUri,
    p_code_challenge: codeChallenge,
    p_code_challenge_method: codeChallengeMethod,
    p_scope: scope,
  });
  if (error || !data || typeof data !== "object" || !("code" in data)) {
    return NextResponse.json({ error: error?.message || "Unable to issue OAuth authorization code." }, { status: 400 });
  }
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", String((data as { code: unknown }).code));
  if (state) redirect.searchParams.set("state", state);
  // Consent is submitted with POST; use 303 so the OAuth callback receives the
  // authorization code via the required follow-up GET instead of replaying POST.
  return NextResponse.redirect(redirect, 303);
}
