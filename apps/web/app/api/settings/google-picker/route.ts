import { NextResponse } from "next/server";
import { refreshGoogleAccessToken } from "@/lib/gmail-api";
import { requireProfile } from "@/lib/onboarding/server";

function pickerError(error: unknown) {
  const message = error instanceof Error ? error.message : "Google Picker could not be opened.";
  const status = message === "AUTH_REQUIRED" ? 401
    : message === "PROFILE_REQUIRED" ? 404
      : message === "google_reconnect_required" ? 409
        : message === "google_picker_not_configured" ? 503
          : 400;
  const userMessage = message === "google_reconnect_required"
    ? "Reconnect Google before choosing an existing Sheet."
    : message === "google_picker_not_configured"
      ? "Google Picker is not configured for this deployment."
      : message;
  return NextResponse.json({ ok: false, error: userMessage, code: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  try {
    const { supabase } = await requireProfile();
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY?.trim();
    const appId = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
    if (!apiKey || !appId) throw new Error("google_picker_not_configured");

    const { data: refreshToken, error } = await supabase.rpc("get_gmail_refresh_token");
    if (error || !refreshToken) throw new Error("google_reconnect_required");
    const accessToken = await refreshGoogleAccessToken(String(refreshToken));

    // Only a short-lived access token is returned. The refresh token remains in
    // the server-side vault and is never exposed to the browser or Picker.
    return NextResponse.json({ ok: true, accessToken, apiKey, appId }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return pickerError(error);
  }
}
