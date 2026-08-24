# Milestone 19: Authenticated ChatGPT app surface

## Delivered

- Remote MCP Streamable HTTP endpoint at /api/chatgpt/mcp.
- OAuth protected-resource and authorization-server metadata under /.well-known/.
- Authorization-code OAuth flow with human consent, PKCE S256, short-lived access tokens and refresh-token rotation.
- Hashed access/refresh-token persistence in the private Supabase schema.
- Account-scoped MCP read tools for profile, preferences, pending work, application context, verified evidence, reusable answers and browser-helper questions.
- Account-scoped write tools for discovered jobs, analyses, preparation packages, user-required questions, review queueing, reasoning results and work-item completion/failure.
- Idempotent work items and reasoning results with direct client table access denied and audit events for OAuth/tool activity.
- /chatgpt setup/status page and safe recurring ChatGPT Task prompt.

## Safety boundary

The MCP app cannot approve Gate 1 or Gate 2, promote evidence from Amber/Red, or submit an employer form. It can only create preparation work and user-required review items. Browser-helper auth, MFA, CAPTCHA, sensitive fields, final review and final submission remain human-controlled.

## Verification

~~~sh
npm run milestone:19
npm run typecheck
npm run build
~~~

The M19 Supabase migration is database/migrations/0039_chatgpt_mcp_work_queue.sql. Production migration and real two-user ChatGPT OAuth acceptance are recorded separately from source-contract verification.
