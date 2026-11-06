import { SignInButton } from "@/components/sign-in-button";
import { isLocalTestAuthEnabled, isSupabaseConfigured } from "@/lib/config";

function safeNextPath(value?: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; intent?: string }> }) {
  const params = await searchParams;
  const configured = isSupabaseConfigured();
  const localTestAuth = isLocalTestAuthEnabled();
  const nextPath = safeNextPath(params.next);
  const connectGoogleSheets = params.intent === "google-sheets";
  const errorText = params.error === "revoked"
    ? "Your JobHuntAI membership has been revoked."
    : params.error === "not-member"
      ? "This Google account does not have an active JobHuntAI invitation or membership."
      : params.error === "google-state-expired"
        ? "Google took too long to return the authorization. Start one fresh connection attempt; any Google grant already saved to JobHuntAI will be reused."
        : params.error === "google-denied"
          ? "Google did not grant the requested access. You can continue using JobHuntAI without Sheets."
          : params.error === "google-connection-failed"
            ? "Google approved access, but JobHuntAI could not save or verify the connection. The issue is shown in Settings; your membership remains active."
            : params.error
              ? "Google sign-in could not be completed. Try again."
              : null;
  return <main className="loginPage"><section className="loginCard"><div className="eyebrow">Invite-only workspace</div><h1 className="title">JobHuntAI</h1><p className="sub">{connectGoogleSheets ? "Connect Google so JobHuntAI can create and keep one spreadsheet up to date." : localTestAuth ? "Local test sign-in is enabled for this loopback development run." : "Sign in with the Google account invited to JobHuntAI."}</p>{errorText ? <div className="errorNotice" role="alert">{errorText}</div> : null}{configured ? <SignInButton nextPath={nextPath} connectGoogleSheets={connectGoogleSheets} localTestAuth={localTestAuth && !connectGoogleSheets} /> : <div className="notice">Supabase is not configured. Authentication is bypassed only for local development.</div>}{!configured ? <a className="textLink" href="/">Open local development dashboard</a> : null}</section></main>;
}
