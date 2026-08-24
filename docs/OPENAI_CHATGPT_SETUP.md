# OpenAI / ChatGPT setup

Job Hunt Console uses a standards-based public MCP app boundary. It does not automate the ChatGPT website and it does not assume that a ChatGPT subscription is an OpenAI API key.

## Local app setup

1. Sign in to Job Hunt Console and open ChatGPT.
2. Add the displayed public HTTPS MCP endpoint in the supported ChatGPT developer-mode/app setup flow.
3. Complete the Google sign-in and explicit consent screen.
4. Test with a harmless read of pending work, then save one idempotent reasoning result.
5. Create any recurring ChatGPT Task yourself and use the recurring instructions shown by the page.

The endpoint advertises OAuth protected-resource and authorization-server metadata. The authorization server requires OAuth 2.1 authorization code plus PKCE S256. Only profile:read and work:write are supported in M19.

## Publication readiness

The production endpoint must be public HTTPS, stable, authenticated and reachable without relying on a local browser session. The app's privacy/support/website URLs and developer identity must be completed in the current OpenAI app submission flow before public directory publication. Developer mode may be limited by the ChatGPT account or workspace policy.

## Recurring work

ChatGPT Tasks are user-created scheduled chats. The setup page supplies a safe prompt, but the Worker does not claim that ChatGPT Tasks are a server-side cron service. Work items are persisted in Supabase and remain per-user.

## Safety

The app has no MCP tool for Gate 1 approval, Gate 2 approval, evidence promotion or final employer submission. Ambiguous personal facts become user_required work items. Tokens are hashed at rest, refreshes rotate, and every OAuth/tool boundary checks active membership.
