# Continue JobHuntAI on another computer

## Start here

The development branch is `codex/m08-application-review`. Its implementation checkpoint is `e1d66d8d7fdb24169b027c412866a0a409436750`, followed by this transfer material. Fetch the current remote tip before working. The production baseline branch `master` is separate. The next package is M08 completion and independent review on the new computer, after the user assigns it there.

Git carries the source, migrations, dependency lockfile, fixtures, runners, requirements and project decisions. Recreate the local services from Git. The two bootstrap prompts below replace the old chat context. Local logs and screenshots, installed tools, browser profiles, pairings and credentials are machine or account state. The acceptance summary carries forward the relevant results. Keep hosted credentials, private applicant material, production database copies, tokens, cookies and raw desktop captures out of the transfer. The repository already contains historical snapshot material under `data/`. Keep the clone within authorized access and use synthetic fixtures for write-capable tests. Sign in to Codex and GitHub on the new computer. If the user later authorizes a live Bridge test, pair the approved browser profile on the new machine through the documented setup flow.

Read the [product handover](PRODUCT_HANDOVER_JOBHUNTAI.md) for behavior and the [README](../README.md) for milestone order. The old October handoff and numbered milestone docs explain earlier implementations. Use current Git, this checkpoint and current user decisions for status.

## Two Codex chats

1. **Orchestrator.** Inspect the actual branch, code, migrations and test evidence. Review worker results, decide acceptance or correction, and give the user the next copy-paste work package. Maintain project status in Git. Implementation belongs to the worker unless the user explicitly assigns it to the orchestrator.
2. **Implementer.** Start with setup and a readiness report. Begin the approved work package after the user relays it. Implement, diagnose, run focused tests and the changed visible user journey, then commit and push to the designated development branch under the established authorization. Report the exact SHA, Git status, commands and results, visible actions and readbacks, and remaining gaps.

Use separate checkout folders or worktrees. For a quick start on the new machine:

```powershell
git clone --branch codex/m08-application-review https://github.com/YashSooriya/job-hunt-console.git job-hunt-console-worker
git clone --branch codex/m08-application-review https://github.com/YashSooriya/job-hunt-console.git job-hunt-console-orchestrator
```

Open each folder as a local Codex project and start its matching chat. Check `git status --short --branch` and `git log -3 --oneline`. The orchestrator can `git pull --ff-only` in its clean checkout after the worker pushes. Sign in to GitHub locally with the access needed for each role. [Codex setup guidance](https://learn.chatgpt.com/docs/quickstart)

## Recreate the development and test environment

For parity with the desktop runners, use an interactive Windows desktop with Chrome, Git, PowerShell, Node, npm and Python on PATH. The previous workstation used Node 24.22.2 with npm 11.19.1 and Python 3.11.5. The repository requires Node 22 or newer. A different OS can run the source and focused checks. The tracked Win32 runners require Windows. An equivalent real desktop input method with the same readbacks is also acceptable. Microsoft Word is needed only to repeat the M06 Word pagination measurement.

From the worker checkout:

```powershell
node --version
npm --version
python --version
npm ci
python -m pip install pillow psutil websocket-client
npm run review:verify
npm run typecheck
```

The orchestrator only needs Git for initial review. Install npm dependencies in its checkout if it will independently run Node suites. For the legacy repository-wide verifier, `npm run knowledge:bootstrap` builds an ignored local artifact from tracked snapshots. See [M00 local verification](M00_LOCAL_VERIFICATION.md). Keep synthetic integration on loopback Supabase. If Next's default build rejects an external dependency symlink, use a normal checkout with `npm ci` there or the verified fallback `npm --workspace @jobhunt/web run build -- --webpack`.

### Disposable authenticated Supabase and desktop smoke

The previous stack used WSL2 `Ubuntu-24.04`, rootful Podman 4.9.3, Supabase CLI 2.122.1 at `/usr/local/bin/supabase`, and PostgreSQL 17. Install the distro with `wsl --install -d Ubuntu-24.04` if needed. Enable systemd in the distro and install `podman` and `python3` in Ubuntu. Install the official Linux CLI binary for that version and host architecture at the path above. The runner calls `wsl.exe -d Ubuntu-24.04 -u root` and expects `supabase_db_jobhuntai-m02-local-20261106`. Use the project ID configured by the helper. [Supabase CLI setup](https://supabase.com/docs/guides/local-development/cli/getting-started)

From PowerShell, enter the root Ubuntu shell with `wsl.exe -d Ubuntu-24.04 -u root`. In that shell, substitute the clean worker checkout's actual `/mnt/c/...` path. Choose a fresh destination with an existing parent. Use a C-drive Windows temporary directory for the current runner.

```bash
systemctl enable --now podman.socket
export DOCKER_HOST=unix:///run/podman/podman.sock
repo='/mnt/c/Users/YOUR_USER/path/to/job-hunt-console-worker'
workdir='/root/jobhuntai-local'
bash "$repo/scripts/prepare-local-supabase-handoff.sh" "$repo" "$workdir"
/usr/local/bin/supabase start --workdir "$workdir" > /tmp/jobhuntai-supabase-start.log 2>&1
/usr/local/bin/supabase migration list --local --workdir "$workdir"
podman ps --filter label=com.supabase.cli.project=jobhuntai-m02-local-20261106 --format '{{.Names}}'
```

The helper stages the checkout's SQL migrations with LF line endings, stages the Edge source into a new workdir, configures the expected project and ports, and disables seed imports. The test runner creates synthetic accounts. Keep API/Postgres on ports 56321/56322 and verify Windows can reach WSL over loopback. Keep startup output local because Supabase can print disposable local keys. If the CLI cannot find the runtime, inspect `systemctl status podman.socket` and the startup log. The reference socket is `/run/podman/podman.sock`. Verify the migration history before running acceptance. Diagnose a clean-bootstrap failure using the exact migration and error on the disposable stack. Keep the hosted database and its migration history out of local setup.

At the transfer checkpoint, a fresh parallel WSL stack applied all 158 migrations through `20261108010917` and returned HTTP 200 from Auth inside WSL. The existing reference stack also returned HTTP 200 from Windows on 56321. The fresh parallel stack used alternate ports to avoid interfering with the reference stack. Verify Windows-to-WSL forwarding on the destination before launching the desktop runner. If Auth succeeds inside WSL but Windows loopback fails, diagnose the WSL localhost relay and any port conflict before changing app configuration.

From PowerShell, check Windows can reach local Auth. Run acceptance once the implementation package is assigned, using the same WSL workdir:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:56321/auth/v1/health'
.\scripts\run-m08-application-review-local-supabase.ps1 -SupabaseWorkdir '/root/jobhuntai-local'
```

The runner stages the current M07/M08 forward migrations and temporarily overlays the checkout's Bridge code. It uses local Supabase, isolated Chrome, controlled Bridge responses and a loopback Drive fixture. Evidence defaults to the Windows temp directory. Use an unlocked desktop and leave focus with the test window. Diagnose the smallest failing step before one final visible smoke. Run one desktop suite at a time.

## Checkpoint on 8 November 2026

| Milestone | State at transfer |
| --- | --- |
| M00–M03 | Accepted for progression. M01 had historical live harmless diagnostics. M02 and M03 have authenticated local coverage. Real Memory activation/correction, real Google Sheet ownership/readback and live scheduled search remain external gaps. |
| M04 | Accepted for progression at `f0b1a8c`. One-dispatch, partial result, recovery and identity checks passed locally with controlled responses. Live M04 ChatGPT delivery remains pending. |
| M05 | Accepted at `2e50242`. Explicit apply and legacy adoption passed authenticated local checks. Follow-ups protected the choice timestamp and vacancy binding and restored the raw form helper boundary. Hosted verification remains pending. |
| M06 | Accepted for progression at `0e80fba`. Eight paired themes, render tests and visible desktop smoke passed. Word 16 measured two-page CVs and one-page letters, with an expired-license prompt and forced shutdown of the test-owned process after measurement. |
| M07 | Base `fbd8ec5` passed local cover-letter Storage/Drive recovery and preview, download and Copy text. Closeout `be7f68a` added transient renderer retry and authenticated local CV-only and paired cases. The local runner also exercises an overlapping Drive publish while the first publish holds the application lease and checks one folder and one file per version and format. Live ChatGPT and real Drive remain pending. |
| M08 | Implemented at `e1d66d8`, awaiting acceptance. The worker reports local migration application, typecheck, Review Centre verification and the CV-only handoff passed. The paired run reached generation and the CV-only handoff, then timed out before the paired Review Centre and Memory factual-review controls. Gate 1 authorization checks and the final build remain outstanding. The worker stopped at the user's request. |
| M09–M12 | Future qualification. Existing code includes the ATS helper and Gate 2, Gmail tracking and later-stage prep. Follow the roadmap after M08 acceptance. |

Raw evidence and stopped-run directories remain on the source computer. The latest available M08 report used the pre-commit M08 working tree and stopped on `Timed out waiting for assembled paired M08 review and Memory factual-review warning.` It recorded successful cover-letter recovery, CV-only and paired generation, Drive identity checks, and the CV-only review handoff before that point. This is local evidence with controlled Bridge responses and loopback Drive. The pushed runner includes a diagnostic snapshot for that timeout. Reproduce the remaining check from the pushed code and synthetic fixtures.

### Next work package for the orchestrator to issue

Resume **M08 completion** on `codex/m08-application-review` from the pushed handoff. Preserve the existing M08 code and M07 closeout. Inspect the paired Review Centre path and the diagnostics near the M08 section of `scripts/windows_m07_document_generation_acceptance.py`. Compare the application and review-package state, selected CV and letter IDs, and Memory review flags with authenticated UI readback. Identify whether assembly, server readback or the runner's readiness condition caused the timeout. Fix the demonstrated cause and retest the affected step.

Prove blocked approval until the exact saved versions, Memory factual review, required screening answer and salary are confirmed. Verify normal Gate 1 approval, refresh persistence, revision invalidation, two-user isolation and denial of direct authenticated bypass through application state, package approval metadata, and approved version content or assets. Verify approval alone creates no form session or submission. Run one short visible paired review walkthrough, affected review checks, typecheck and a final production build. Use the existing fixtures. Keep failure injection and access-control probes at the API or SQL layer. Report the branch, SHA, observations and remaining gaps. The orchestrator reviews the diff and evidence before issuing M09.

## Operating limits and evidence

- Preserve Next.js, Supabase/RLS, Cloudflare, the generic Website Bridge, the managed Sheet mirror, and the separate employer helper. Supabase is authoritative.
- Ordinary search, fit and document writing use ChatGPT Memory for candidate context. Transmitting reviewed professional background is confined to authorized onboarding or maintenance. Memory drafts require factual review.
- Choose to apply and document generation are separate explicit actions. Gate 1 approves exact content. Gate 2 covers the exact final employer form. Acceptance is no-submit.
- Keep live ChatGPT activity on hold until the user explicitly resumes it. Real Google/Drive tests, hosted changes and production deployment need their own authorization. Keep Gmail read-only and avoid paid resources or new external test accounts unless authorized.
- Run focused checks while developing. Verify real local side effects for persistence and authorization. Exercise changed user interactions on a visible desktop. Run broad or external checks for affected shared contracts or release gates. Label controlled responses, local persistence and external verification separately.
- Use logical development commits and a concise handoff. Review source and evidence through Git and the worker report. Review ZIPs are retired.

## Bootstrap prompts for the new Codex chats

### Orchestrator

```text
You are the JobHuntAI orchestrator and independent reviewer. In this local checkout, verify the remote tip of codex/m08-application-review and read docs/CODEX_CONTINUATION.md, README.md and docs/PRODUCT_HANDOVER_JOBHUNTAI.md. Reconcile the checkpoint with Git. M08 is implemented and awaiting acceptance. Prepare the documented M08 completion package for me to pass to the separate implementer when I say to start.

Stay in the orchestrator role. Review source and evidence, decide acceptance, maintain the roadmap and issue focused work packages. Application changes belong to the implementer unless I explicitly assign them to you. Use the operating limits in the runbook and preserve the hold on live ChatGPT, real Google and production work.
```

### Implementer

```text
You are the JobHuntAI implementer on this computer. Verify the remote tip of codex/m08-application-review and read docs/CODEX_CONTINUATION.md, docs/PRODUCT_HANDOVER_JOBHUNTAI.md and the applicable AGENTS.md. Follow the runbook to prepare dependencies and a disposable local environment. Report the branch and SHA, local migration and Auth readiness, visible desktop test capability, and anything I need to do.

This first turn is setup only. Wait for me to pass you the orchestrator's M08 completion package before changing application code or running milestone acceptance. Use synthetic local data. Keep live ChatGPT, real Google, employer activity and production on hold. When I assign a package, implement and verify it with focused local tests and a short visible desktop check, then commit and push to the designated development branch under the applicable authorization. Hand off by SHA and concise evidence.
```
