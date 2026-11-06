<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## JobHuntAI development and acceptance protocol

- Complete the authorized work package through its acceptance criteria. Treat failures as implementation or environment problems to diagnose, correct, and retest; do not stop at the first failed approach.
- Prefer an isolated, non-production environment with synthetic data for authenticated integration checks. Never use production applicant data, weaken authentication or RLS, or perform a consequential external action without explicit authorization.
- For user-facing workflows, perform visible GUI acceptance against the running app. Use the existing Windows native-input runner when Computer Use is unavailable; source inspection, API checks, and DOM automation are supporting evidence, not proof of desktop interaction.
- When a genuine integration or GUI check needs a user-only action, ask as soon as that dependency is clear, continue independent work, then resume the same acceptance workflow after the user responds.
- For each failed scenario, record the observed failure, diagnose the cause, implement the safest viable correction, and retest the affected scenario. Keep evidence specific to the environment and test method.
- Run focused tests while iterating, then run the appropriate milestone and release qualification checks after substantive integration work stabilizes. Do not repeat already demonstrated tests unless a change affects them.
- Before declaring a milestone complete, review every acceptance criterion and report PASS only when supported by observed evidence. Clearly distinguish authenticated integration, native GUI, browser automation, and unit or source-level results.
