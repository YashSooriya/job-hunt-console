"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignInButton({ nextPath = "/", connectGoogleSheets = false }: { nextPath?: string; connectGoogleSheets?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?intent=${connectGoogleSheets ? "google-sheets" : "sign-in"}&next=${encodeURIComponent(nextPath)}`;
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        // Gmail remains read-only. drive.file limits Sheets access to files the
        // user creates or explicitly opens for this app.
        scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file",
        queryParams: {
          access_type: "offline",
          include_granted_scopes: "true",
          ...(connectGoogleSheets ? { prompt: "consent select_account" } : {}),
        },
      },
    });
    if (authError) {
      setError(authError.message);
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="primaryButton" type="button" onClick={signIn} disabled={busy}>
        {busy ? "Opening Google…" : connectGoogleSheets ? "Connect Google Sheets" : "Continue with Google"}
      </button>
      {error ? <p className="formError">{error}</p> : null}
    </div>
  );
}
