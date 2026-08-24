import { AppShell } from "@/components/app-shell";
import { ChatGptMemoryReminder } from "@/components/chatgpt-memory-reminder";
import { CHATGPT_PROJECT_NAME, getConnectionStatus } from "@/lib/chatgpt/mcp";

const recurringInstructions = [
  `Use the ChatGPT Project named "${CHATGPT_PROJECT_NAME}" for this integration and keep all Job Hunt Console conversations there.`,
  "Use relevant previous ChatGPT Memory when it is enabled and available. Treat it as contextual recall, verify it against get_detailed_candidate_profile, and never promote an unverified memory into a factual profile record.",
  "Run my Job Hunt Console recurring review.",
  "1. Call get_automation_settings. Respect the selected email cadence; call get_pending_email_classifications and classify_email for every bounded pending message. Assign ordinary email categories and safe application matches automatically. Leave offers, recruiter follow-ups, uncertain classifications and ambiguous/unmatched matches in Needs you with their category already recorded.",
  "2. If spreadsheet_sync_enabled is true, call sync_application_tracker after email classification. Use create_if_missing only when the user has explicitly enabled the managed tracker in Settings.",
  "3. Call get_pending_job_url_inspections and process up to five URLs. Open each public listing with read-only browsing, never log in, apply or submit. Extract company, role, full description, location, work mode, dates, employment type, ATS, application URL, responsibilities, requirements, skills, benefits and application instructions. Call save_job_url_inspection for each completed URL. If salary is absent, estimate it only when there is a defensible basis, label it chatgpt_estimate, include salary_confidence and salary_basis, and never represent it as advertised. If the page is blocked, login-gated or ambiguous, call fail_job_url_inspection with user_required=true.",
  "4. Call recover_stale_work, then ensure_search_run, then read get_search_context, get_detailed_candidate_profile, get_search_preferences and bounded get_pending_work.",
  "5. Search enabled employer career sites, live ATS pages and quality boards for current vacancies using my posting-age and location preferences.",
  "6. Deduplicate against get_search_context, save frozen discoveries, analyse eligibility/fit/priority and save structured results with idempotency keys. For eligible matches call save_application_package and use get_application_preparation_status to confirm the idempotent Gate 1 handoff.",
  "7. Process only a bounded number of vacancies per run and report ambiguous or missing personal facts as user-required questions. If get_browser_agent_question_context shows a paused helper, you may propose_browser_reasoning using verified context, but never write a field value or resume it.",
  "8. Never approve Gate 1, approve Gate 2, promote evidence, resume a browser helper, or submit an employer form.",
  "9. Mark the search work item complete with jobs_checked, jobs_deduped and jobs_accepted, then summarise what changed.",
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
      <ChatGptMemoryReminder />
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
          <div className="cardHeader"><div><h2>Remote MCP endpoint</h2><p>Use this public HTTPS endpoint inside the ChatGPT Project named “{CHATGPT_PROJECT_NAME}”.</p></div></div>
          <div className="chatgptEndpoint"><code>/api/chatgpt/mcp</code><span>OAuth protected · M21 search worker</span></div>
          <div className="chatgptSteps">
            <div><strong>1. Create the Project</strong><p>In ChatGPT, create a new Project named “{CHATGPT_PROJECT_NAME}”, then keep this app and its conversations in that Project.</p></div>
            <div><strong>2. Turn on Memory</strong><p>In ChatGPT Settings → Personalization, turn on Memory. If it is already on, confirm it in the reminder. Relevant prior knowledge can then be used as context.</p></div>
            <div><strong>3. Add the app</strong><p>Add the MCP endpoint in ChatGPT Settings → Security and login → Developer mode, or through the supported app/plugin setup flow.</p></div>
            <div><strong>4. Sign in and consent</strong><p>Google sign-in is handled by Job Hunt Console. Approve only the profile:read and work:write scopes shown on the ChatGPT consent screen. Google access remains Gmail read-only plus the narrow drive.file permission for the tracker workbook you create or explicitly choose in Settings.</p></div>
            <div><strong>5. Verify harmless access</strong><p>Ask ChatGPT to read your detailed profile, email settings and pending work. Results are written only to your account and are auditable.</p></div>
          </div>
        </div>

        <div className="card chatgptSetupCard">
          <div className="cardHeader"><div><h2>Connection status</h2><p>Token activity is shown without exposing bearer tokens.</p></div></div>
          <div className="chatgptStatusList">
            <div><span>Active tokens</span><strong>{String(status.active_tokens ?? 0)}</strong></div>
            <div><span>Last used</span><strong>{typeof status.last_used_at === "string" ? new Date(status.last_used_at).toLocaleString("en-GB") : "Not used yet"}</strong></div>
            <div><span>Scope</span><strong>{Array.isArray(status.scope) ? status.scope.join(", ") : "profile:read, work:write"}</strong></div>
            <div><span>Recurring path</span><strong>User-created ChatGPT Task</strong></div>
            <div><span>ChatGPT Project</span><strong>{CHATGPT_PROJECT_NAME}</strong></div>
            <div><span>Memory behavior</span><strong>Use prior memory when available</strong></div>
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
