import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function ChatGptAuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login?next=/chatgpt");
  const clientId = one(params, "client_id");
  const redirectUri = one(params, "redirect_uri");
  const codeChallenge = one(params, "code_challenge");
  const codeChallengeMethod = one(params, "code_challenge_method");
  const responseType = one(params, "response_type");
  const scope = one(params, "scope") || "profile:read work:write";
  const state = one(params, "state");

  return (
    <main className="loginPage">
      <section className="loginCard chatgptConsentCard">
        <div className="eyebrow">Job Hunt Console</div>
        <h1 className="title">Connect ChatGPT</h1>
        <p className="sub">ChatGPT is requesting a private connection to your Job Hunt Console account.</p>
        <div className="consentScope"><strong>Requested access</strong><span>Read your profile and search context</span><span>Save work and reasoning results to your account</span><span>Ask you questions when facts are ambiguous</span></div>
        <div className="notice">This connection cannot approve Gate 1, approve Gate 2, promote evidence, or submit an employer application.</div>
        <form action="/api/chatgpt/oauth/authorize/consent" method="post" className="chatgptConsentForm">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
          <input type="hidden" name="response_type" value={responseType} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="state" value={state} />
          <button className="primaryButton" type="submit">Allow ChatGPT access</button>
        </form>
        <a className="textLink" href="/chatgpt">Cancel</a>
      </section>
    </main>
  );
}
