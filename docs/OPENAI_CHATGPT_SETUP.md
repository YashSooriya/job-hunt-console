# OpenAI / ChatGPT setup

Job Hunt Console uses a standards-based public MCP app boundary. It does not automate the ChatGPT website and it does not assume that a ChatGPT subscription is an OpenAI API key.

## Local app setup

1. Sign in to Job Hunt Console and open ChatGPT.
2. Create a new ChatGPT Project named **Job Hunt**. Keep the Job Hunt Console app and all related chats in that Project.
3. In ChatGPT Settings → Personalization, turn on **Memory**. If it is already enabled, confirm that in the Job Hunt Console reminder.
4. Add the displayed public HTTPS MCP endpoint in the supported ChatGPT developer-mode/app setup flow.
5. Complete the Google sign-in and explicit consent screen.
6. In Job Hunt Console Settings → Automation, choose the email-monitoring cadence and either create the managed Job Application Tracker Sheet or choose an existing Google Sheet. For an existing workbook, enter the tab Job Hunt should manage (the default creates a dedicated `Job Hunt Applications` tab) and click **Choose existing Google Sheet**.
7. Test with harmless reads of the detailed candidate profile, automation settings and pending work, then save one idempotent reasoning result.
8. Create any recurring ChatGPT Task yourself, schedule it to the cadence selected in Settings, and use the recurring instructions shown by the page.

The endpoint advertises OAuth protected-resource and authorization-server metadata. The authorization server requires OAuth 2.1 authorization code plus PKCE S256. Only profile:read and work:write are supported in M19. The server advertises **Job Hunt** in its MCP instructions and labels detailed-profile audit records with that name.

The MCP server cannot create a ChatGPT UI Project itself: ChatGPT Projects are created and managed in ChatGPT, while the OpenAI API Project endpoint is a separate organization-level resource. The setup page therefore makes the required Project step explicit and instructs every MCP session to use it.

ChatGPT Memory is also controlled in ChatGPT, not through the MCP server. When Memory is enabled, ChatGPT may use relevant knowledge from earlier chats. The MCP initialize instructions and detailed-profile result explicitly tell ChatGPT to use that knowledge as contextual recall while treating the verified Job Hunt profile as authoritative and never promoting an unverified memory into a profile fact.

## Publication readiness

The production endpoint must be public HTTPS, stable, authenticated and reachable without relying on a local browser session. The app's privacy/support/website URLs and developer identity must be completed in the current OpenAI app submission flow before public directory publication. Developer mode may be limited by the ChatGPT account or workspace policy.

## Recurring work

ChatGPT Tasks are user-created scheduled chats. The setup page supplies a safe prompt, but the Worker does not claim that ChatGPT Tasks are a server-side cron service. Work items are persisted in Supabase and remain per-user.

Each run reads bounded Gmail messages already collected by the web app, assigns their categories through `classify_email`, leaves only real human decisions in `Needs You`, and updates the optional managed Google Sheet through `sync_application_tracker`. The web app also updates the recorded workbook/tab after a due dashboard Gmail sync.

## Safety

The app has no MCP tool for Gate 1 approval, Gate 2 approval, evidence promotion or final employer submission. Ambiguous personal facts become user_required work items. Tokens are hashed at rest, refreshes rotate, and every OAuth/tool boundary checks active membership.
