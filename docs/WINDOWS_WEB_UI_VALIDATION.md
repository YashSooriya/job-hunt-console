# Windows web UI validation

This repository contains a Next.js web app, not an Electron, Tauri, MSIX, or other packaged Windows application. This runner provides genuine Windows desktop evidence for the local web app hosted by a test-owned Chrome process. It does not claim that the web app is a packaged desktop product.

## Run

Prerequisites are Windows, Python 3.11+, Node.js 22+, installed repository `node_modules`, Google Chrome, and the small Python packages Pillow, psutil, and websocket-client. Install the Python packages if needed:

```powershell
python -m pip install pillow psutil websocket-client
```

From the repository root:

```powershell
python scripts/windows_web_ui_acceptance.py --source-root .
```

The runner prints a run-specific evidence directory under `%TEMP%\JobHuntAI-Windows-UI-Evidence`. Pass `--evidence-dir <folder>` to choose its parent. `--keep-workspace` preserves the isolated workspace and Chrome profile for debugging; ordinary runs delete them after asserting test-owned processes have exited.

## Isolation and safety

- The runner copies tracked `apps/web` and `packages` source into a unique temporary workspace and creates only fictional JSON data from `scripts/fixtures/windows-web-ui/data`.
- It does not copy repository `data`, `.env` files, or browser state. Third-party dependencies are mirrored inside the isolated app with NTFS hard links (and file-copy fallback if hard links are unavailable); local `@jobhunt` workspace packages are copied into the isolated app. This keeps Turbopack dependency resolution inside its workspace without duplicating dependency file contents in the normal case.
- It filters inherited credential-like and JobHunt-specific environment variables, then forces `JOBHUNT_DATA_MODE=local` and disables telemetry.
- It starts Next.js and Chrome as owned child processes. Chrome receives a unique `--user-data-dir`, and its optional CDP endpoint binds only to `127.0.0.1` on an ephemeral port. The runner never attaches to the user's regular Chrome profile.
- If Windows refuses direct foreground activation, the runner grants the test process foreground permission, temporarily attaches the runner thread to the relevant input queues, and can retry with Alt+Tab. That fallback can change which window is foreground; for a strict no-contact boundary with the current foreground app, run in a dedicated Windows desktop, session, or VM. The successful recorded run used direct `SetForegroundWindow` and did not use that fallback.
- UI input is sent with Win32 `SendInput`. CDP is used only to read DOM state, coordinates, and resource origins. No Playwright click, fill, or key press is used.
- Click coordinates are derived from the HWND client-area screen origin/size and the observed CSS viewport size. The runner requests per-monitor-v2 DPI awareness, uses `client_width / innerWidth` as the scale, accounts for Chromium's title-bar overlay, and records `devicePixelRatio` only as a diagnostic. It reads the native cursor position back, checks a DOM hit test, and verifies focus/value after input.
- The workflow searches for a nonmatching string, clears it, opens Applications, returns to Jobs, and refreshes. It does not click job actions, generate documents, change Memory, send employer communications, or submit applications.
- Full primary-desktop PNGs are captured while the test-owned Chrome window is maximized and foregrounded. No crop is used. The run fails if the image dimensions do not match the full primary display.
- Cleanup closes the exact test-owned window and process trees and checks their PIDs exited before removing the isolated workspace. It does not use broad process-name termination.

## Evidence levels and limits

The generated `desktop-ui-run.json` identifies the command, Git baseline, web and Chrome versions, executable path, process PIDs, fixture size, UI milestones, workflow readbacks, screenshot paths, page resource origins, and cleanup. It does not record the ephemeral CDP capability path. `next-dev.log` and the redacted `chrome-launch.txt` are startup diagnostics. The page resource list does not measure Chrome background traffic.

This runner produces **genuine Windows desktop UI** evidence: native input and full-desktop screenshots. It is distinct from unit/component checks and from browser-only Playwright checks. CDP is an observation channel; it is not treated as proof of input. It does not exercise import, geometry selection, meshing, project persistence, or splash behavior because those features are absent from this web application. The first visible Jobs workspace is used instead. No performance claim is made from this small bounded workflow.

The recorded workflow uses the account-free local snapshot. Supabase-dependent search availability and preparation service checks show the expected missing-configuration state because the isolated environment intentionally has no Supabase URL or key; no user account or production credential is loaded.

The runner is opt-in and test-only; it changes no application source or production account data. A tool-policy rejection of the runner invocation is a stop condition: record that result and do not switch to a different launcher to evade the policy.
