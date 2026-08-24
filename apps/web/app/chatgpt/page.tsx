import { AppShell } from "@/components/app-shell";
import { getConnectionStatus } from "@/lib/chatgpt/mcp";

const recurringInstructions = [
  "Run my Job Hunt Console recurring review.",
  "1. Call ensure_search_run, then read get_search_context, get_candidate_profile, get_search_preferences and get_pending_work.",
  "2. Search enabled employer career sites, live ATS pages and quality boards for current vacancies using my posting-age and location preferences.",
  "3. Deduplicate against get_search_context, save frozen discoveries, analyse eligibility/fit/priority and save structured results with idempotency keys. For eligible matches call save_application_package and use get_application_preparation_status to confirm the idempotent Gate 1 handoff.",
  "4. Process only a bounded number of vacancies per run and report ambiguous or missing personal facts as user-required questions. If get_browser_agent_question_context shows a paused helper, you may propose_browser_reasoning using verified context, but never write a field value or resume it.",
  "5. Never approve Gate 1, approve Gate 2, promote evidence, resume a browser helper, or submit an employer form.",
  "6. Mark the search work item complete with jobs_checked, jobs_deduped and jobs_accepted, then summarise what changed.",
].join("\n");

export default async function ChatGptConnectionPage() {
  let status: Record<string, unknown> = { connected: false, active_tokens: 0 };
  try {
    status = (await getConnectionStatus() || {}) as Record<string, unknown>;
  } catch {
    // The page remains useful before the production migration is applied.
  }

  return (
    <AppShell>
      <div className="pageHeader">
        <div>
          <div className="eyebrow">ChatGPT background worker</div>
          <h1 className="title">ChatGPT connection</h1>
          <p className="sub">Connect the authenticated ChatGPT app to this private workspace using OAuth 2.1 with PKCE. The connection is scoped to your account and cannot approve or submit applications.</p>
        </div>
        <span className={"sourceBadge " + (status.connected ? "live" : "")}>{status.connected ? "Connected" : "Not connected"}</span>
      </div>

      <section className="chatgptSetupGrid">
        <div className="card chatgptSetupCard">
          <div className="cardHeader"><div><h2>Remote MCP endpoint</h2><p>Use this public HTTPS endpoint when adding the Job Hunt app in ChatGPT developer mode.</p></div></div>
          <div className="chatgptEndpoint"><code>/api/chatgpt/mcp</code><span>OAuth protected · M21 search worker</span></div>
          <div className="chatgptSteps">
            <div><strong>1. Add the app</strong><p>Add the MCP endpoint in ChatGPT Settings → Security and login → Developer mode, or through the supported app/plugin setup flow.</p></div>
            <div><strong>2. Sign in and consent</strong><p>Google sign-in is handled by Job Hunt Console. Approve only the profile:read and work:write scopes shown on the consent screen.</p></div>
            <div><strong>3. Verify harmless access</strong><p>Ask ChatGPT to read your pending work and save a test reasoning result. Results are written only to your account and are auditable.</p></div>
          </div>
        </div>

        <div className="card chatgptSetupCard">
          <div className="cardHeader"><div><h2>Connection status</h2><p>Token activity is shown without exposing bearer tokens.</p></div></div>
          <div className="chatgptStatusList">
            <div><span>Active tokens</span><strong>{String(status.active_tokens ?? 0)}</strong></div>
            <div><span>Last used</span><strong>{typeof status.last_used_at === "string" ? new Date(status.last_used_at).toLocaleString("en-GB") : "Not used yet"}</strong></div>
            <div><span>Scope</span><strong>{Array.isArray(status.scope) ? status.scope.join(", ") : "profile:read, work:write"}</strong></div>
            <div><span>Recurring path</span><strong>User-created ChatGPT Task</strong></div>
          </div>
        </div>
      </section>

      <section className="card chatgptTaskCard">
        <div className="cardHeader"><div><h2>Recurring ChatGPT Task instructions</h2><p>ChatGPT Tasks are created and scheduled by the user in ChatGPT. This page provides the safe prompt and MCP endpoint; it is not a hidden server cron.</p></div></div>
        <pre>{recurringInstructions}</pre>
      </section>

      <div className="notice">Human Gate 1 and Gate 2 remain explicit user decisions. OAuth tokens are short-lived, refreshable and stored only as hashes; the browser helper still pauses for authentication, MFA, CAPTCHA, sensitive questions and final review.</div>
    </AppShell>
  );
}
