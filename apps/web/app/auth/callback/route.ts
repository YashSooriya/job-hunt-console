import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  let next = searchParams.get("next") ?? "/";
  if (!next.startsWith("/")) next = "/";
  if (!code) return NextResponse.redirect(`${origin}/login?error=auth-code`);

  const supabase = await createClient();
  const { data: exchangeData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) return NextResponse.redirect(`${origin}/login?error=auth-code`);

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userError ? null : userData.user;
  if (!user?.email) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=unauthorized`);
  }

  // Membership must be accepted before any applicant data, Gmail credential,
  // or historical bootstrap can be attached to the authenticated identity.
  const { data: acceptance, error: acceptanceError } = await supabase.rpc("accept_app_membership");
  if (acceptanceError || !(acceptance as any)?.allowed) {
    await supabase.auth.signOut();
    const reason = (acceptance as any)?.reason === "membership_revoked" ? "revoked" : "not-member";
    return NextResponse.redirect(`${origin}/login?error=${reason}`);
  }

  const providerRefreshToken = exchangeData.session?.provider_refresh_token;
  if (providerRefreshToken) {
    const { error: tokenStoreError } = await supabase.rpc("store_gmail_refresh_token", { p_refresh_token: providerRefreshToken });
    if (tokenStoreError) console.error("Gmail refresh token could not be stored", tokenStoreError);
  }

  const displayName = typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
    ? user.user_metadata.full_name.trim() : user.email.split("@")[0];
  await supabase.from("candidate_profiles").upsert(
    { user_id: user.id, display_name: displayName },
    { onConflict: "user_id", ignoreDuplicates: false }
  );
  const { data: profile } = await supabase.from("candidate_profiles").select("id").eq("user_id", user.id).single();
  if (profile?.id) {
    await supabase.from("candidate_preferences").upsert(
      { profile_id: profile.id, preferences: {} },
      { onConflict: "profile_id", ignoreDuplicates: true }
    );
  }

  // Only a member whose authenticated email matches the staged intended email
  // can claim a historical bootstrap. New invited members simply receive no batch.
  const { data: claimData, error: claimError } = await supabase.rpc("claim_bootstrap_import");
  if (claimError) console.error("Historical bootstrap import could not be claimed", claimError);
  if ((claimData as any)?.claimed === true) next = "/commissioning";
  else if ((acceptance as any)?.new_member === true) next = "/onboarding";

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (process.env.NODE_ENV !== "development" && forwardedHost) return NextResponse.redirect(`https://${forwardedHost}${next}`);
  return NextResponse.redirect(`${origin}${next}`);
}
