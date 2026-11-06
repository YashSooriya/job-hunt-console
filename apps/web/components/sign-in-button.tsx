"use client";

import { type FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignInButton({ nextPath = "/", connectGoogleSheets = false, localTestAuth = false }: { nextPath?: string; connectGoogleSheets?: boolean; localTestAuth?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function signInWithLocalTestAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError(authError.message);
      setBusy(false);
      return;
    }
    window.location.assign(nextPath);
  }

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

  if (localTestAuth) {
    return (
      <form onSubmit={signInWithLocalTestAccount}>
        <label className="recordField"><span>Local test email</span><input name="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className="recordField"><span>Local test password</span><input name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="primaryButton" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in to local test account"}</button>
        {error ? <p className="formError" role="alert">{error}</p> : null}
      </form>
    );
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
