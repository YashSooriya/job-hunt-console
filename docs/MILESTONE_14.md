# Milestone 14: Local Browser Helper Commissioning

Milestone 14 removes the per-application command-line handoff from the adaptive browser-agent workflow.

## Final local architecture

The hosted Job Hunt web application remains the control plane and Supabase remains the source of truth. A single paired Mac helper runs locally because employer authentication sessions and the browser itself must remain on the user's machine.

Commissioning is one-time:

1. Open **Settings → Browser helper** in Job Hunt.
2. Generate a ten-minute pairing code.
3. Run `npm run browser:pair -- --code <code> --supabase <project-url>` once on the Mac.
4. The returned device credential is written to macOS Keychain. It is not written to `helper.json`, `.env`, logs, or the repository.
5. Run `npm run browser:install-mac` once.
6. A per-user `launchd` LaunchAgent starts the helper automatically at login.
7. The helper keeps the dedicated `~/.job-hunt/chrome-profile` Chrome profile available and polls for approved form sessions.

After pairing, pressing **Prepare employer form** queues a form session directly to the paired device. The short-lived form-session token is rotated and delivered device-to-device through the scoped Edge bridge. It is injected into the child agent process through an environment variable rather than a process-list command argument.

## User intervention

A background LaunchAgent has no interactive terminal. If the form agent encounters login, MFA, CAPTCHA, a Red/sensitive question, or an unknown required field, it moves the session to `needs_user`. The user resolves the issue in Job Hunt Chrome and presses **Resume helper** in the hosted web app. The daemon then continues and re-observes the page.

Gate 2 is unchanged: the helper stops at the actual employer final-review page and cannot submit without explicit approval.

## Local status

The daemon exposes a loopback-only health endpoint at `127.0.0.1:43712`. `npm run browser:status` reads this endpoint and reports pairing, Chrome and current-session health.

## macOS implementation note

The current commissioning package uses a per-user LaunchAgent because the helper is repository-based Node tooling. If it is later packaged as a signed native `.app`, migrate auto-start registration to Apple's `SMAppService` APIs.
