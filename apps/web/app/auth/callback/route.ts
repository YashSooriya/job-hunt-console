import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { refreshGoogleAccessToken } from "@/lib/gmail-api";

function safeNextPath(value: string | null, origin: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin) return "/";
    return target.pathname + target.search + target.hash;
  } catch {
    return "/";
  }
}

function redirectWithGoogleError(origin: string, next: string, code: string) {
  if (next === "/settings" || next.startsWith("/settings?")) {
    const target = new URL(next, origin);
    target.searchParams.set("googleConnectionError", code);
    return NextResponse.redirect(target);
  }
  const login = new URL("/login", origin);
  login.searchParams.set("next", next);
  login.searchParams.set("error", "google-connection-failed");
  if (next.startsWith("/settings")) login.searchParams.set("intent", "google-sheets");
  return NextResponse.redirect(login);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { searchParams, origin } = url;
  const code = searchParams.get("code");
  const intent = searchParams.get("intent");
  const isGoogleSheetsConnection = intent === "google-sheets";
  const next = safeNextPath(searchParams.get("next"), origin);
  const providerError = searchParams.get("error_code") || searchParams.get("error");
  if (providerError || !code) {
    const login = new URL("/login", origin);
    login.searchParams.set("next", next);
    if (isGoogleSheetsConnection) login.searchParams.set("intent", "google-sheets");
    login.searchParams.set("error", providerError === "bad_oauth_state" ? "google-state-expired" : providerError === "access_denied" ? "google-denied" : "auth-code");
    return NextResponse.redirect(login);
  }

  const supabase = await createClient();
  const { data: exchangeData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    const login = new URL("/login", origin);
    login.searchParams.set("next", next);
    if (isGoogleSheetsConnection) login.searchParams.set("intent", "google-sheets");
    login.searchParams.set("error", "google-connection-failed");
    return NextResponse.redirect(login);
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userError ? null : userData.user;
  if (!user?.email) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=unauthorized", origin));
  }

  const { data: acceptance, error: acceptanceError } = await supabase.rpc("accept_app_membership");
  if (acceptanceError || !(acceptance as any)?.allowed) {
    await supabase.auth.signOut();
    const reason = (acceptance as any)?.reason === "membership_revoked" ? "revoked" : "not-member";
    return NextResponse.redirect(new URL("/login?error=" + reason, origin));
  }

  const providerRefreshToken = exchangeData.session?.provider_refresh_token;
  let tokenStoreFailed = false;
  if (providerRefreshToken) {
    const { error: tokenStoreError } = await supabase.rpc("store_gmail_refresh_token", { p_refresh_token: providerRefreshToken });
    if (tokenStoreError) {
      tokenStoreFailed = true;
      console.error("Google provider credential could not be saved for the signed-in user.");
    }
  }

  let googleConnectionError: string | null = null;
  if (isGoogleSheetsConnection) {
    if (tokenStoreFailed) {
      googleConnectionError = "save_failed";
    } else {
      const { data: storedRefreshToken, error: tokenReadError } = await supabase.rpc("get_gmail_refresh_token");
      if (tokenReadError) googleConnectionError = "check_failed";
      else if (!storedRefreshToken) googleConnectionError = "missing_token";
      else {
        try {
          await refreshGoogleAccessToken(String(storedRefreshToken));
        } catch (error) {
          googleConnectionError = error instanceof Error && error.message === "google_reconnect_required" ? "grant_expired" : "temporary_error";
        }
      }
    }
  } else if (tokenStoreFailed) {
    googleConnectionError = "save_failed";
  }

  const displayName = typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
    ? user.user_metadata.full_name.trim() : user.email.split("@")[0];
  const { error: profileUpsertError } = await supabase.from("candidate_profiles").upsert(
    { user_id: user.id, display_name: displayName },
    { onConflict: "user_id", ignoreDuplicates: false },
  );
  if (profileUpsertError) console.error("Candidate profile could not be initialized after sign-in.");
  const { data: profile } = await supabase.from("candidate_profiles").select("id").eq("user_id", user.id).single();
  if (profile?.id) {
    await supabase.from("candidate_preferences").upsert(
      { profile_id: profile.id, preferences: {} },
      { onConflict: "profile_id", ignoreDuplicates: true },
    );
  }

  const { data: claimData, error: claimError } = await supabase.rpc("claim_bootstrap_import");
  if (claimError) console.error("Historical bootstrap import could not be claimed.");
  let destination = next;
  if ((claimData as any)?.claimed === true) destination = "/commissioning";
  else if ((acceptance as any)?.new_member === true) destination = "/onboarding";
  if (googleConnectionError) return redirectWithGoogleError(origin, isGoogleSheetsConnection ? destination : "/settings", googleConnectionError);
  return NextResponse.redirect(new URL(destination, origin));
}
