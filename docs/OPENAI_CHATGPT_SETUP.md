# ChatGPT Website Bridge setup

JobHuntAI Console contacts ChatGPT only through the Website Bridge browser extension. The user-created **Job Hunt Console** ChatGPT app/plugin and its OAuth routes are retired; no OpenAI API key, plugin install, OAuth consent, or ChatGPT Task is required for a bridge dispatch.

## Pair the bridge

1. Sign in to JobHuntAI Console and open **Settings → ChatGPT website dispatch**.
2. In ChatGPT, sign in and create (or keep) a Project named **JobHuntAI**. The extension uses its visible UI to bind separate workflow conversations to this Project.
3. In Settings, create a one-time pairing code and enter it in the unpacked or distributed Website Bridge extension. Pairing codes expire and the device credential is stored in the browser extension, not in page JavaScript.
4. Use the extension’s setup action to create or bind workflow conversations. Keep **Automatic Send** enabled only if you want eligible user-authorized jobs to be sent automatically.
5. For acceptance tests, turn on **Testing mode** in **Diagnostics** first. Its prefix explicitly says the test is not to be added to ChatGPT memory.

## What the bridge does

Each webapp action creates an authenticated, owner-scoped dispatch with its own plain-language instruction. The extension sends that instruction once in the matching inactive ChatGPT conversation, captures the exact corresponding assistant turn, and uploads the response using the v3 completion and provenance contract. The browser keeps the JobHuntAI tab selected while ChatGPT runs in the background.

When a captured response cannot be uploaded, the extension retries that same response; it does not send the original user message again. A new send is available only when the server confirms that the prior request never crossed the Send boundary. The retired plugin's OAuth access tokens are revoked when migration `0108_bridge_bulk_job_url_imports.sql` is applied; bridge device credentials are separate and remain unaffected.

## Job listing imports

Open **Jobs → Add a vacancy → Import from a job listing URL**. Enter a public listing URL in each field; choose **Add another job URL** for more listings (up to ten). **Inspect with ChatGPT** sends every populated listing together in one generic `job.inspect_url` Website Bridge dispatch. Each listing still has its own stable inspection ID, independent result status, strict structured fields, and existing job/snapshot persistence. Only an exact-request result from the verified assistant turn is saved to the job pool. Failed bridge delivery may be retried only before the Send boundary; once a response is captured, persistence recovery uses that same response and never sends the original message again.

The assistant browses public pages read-only. It never signs in, bypasses access controls, applies, contacts an employer, or submits forms. Advertised compensation is distinguished from a clearly evidenced estimate; unknown values remain unavailable. If a listing is blocked or cannot be matched confidently, the UI leaves it for manual entry instead of guessing.

## Validation

Run `npm run chatgpt-bridge:verify`, `npm run supabase:security:verify`, `npm run job-url:verify`, and the web/extension type checks. Live acceptance steps are in [the Website Bridge acceptance runbook](CHATGPT_BRIDGE_ACCEPTANCE.md).
