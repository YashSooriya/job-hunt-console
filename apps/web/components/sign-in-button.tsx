"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignInButton({ nextPath = "/" }: { nextPath?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`;
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
        queryParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
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
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
      {error ? <p className="formError">{error}</p> : null}
    </div>
  );
}
