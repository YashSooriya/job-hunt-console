# Local verification bootstrap

This runbook complements the repository's milestone-specific verification scripts. It records the verified M00 environment on this workstation and keeps local snapshot testing separate from production credentials.

## Toolchain and baseline checks

The repository requires Node.js `>=22` (`package.json`). This workstation has Node.js v24.22.2 and npm 11.19.1 installed user-locally from the official Node.js Windows ZIP. The install is under `%LOCALAPPDATA%\Programs\JobHuntAI\node-v24.22.2-win-x64`; the system PATH was not changed.

For a new PowerShell session on this workstation, add that user-local install to the current process PATH, then run the lockfile-based checks:

```powershell
$nodeRoot = Join-Path $env:LOCALAPPDATA 'Programs\JobHuntAI\node-v24.22.2-win-x64'
$env:PATH = "$nodeRoot;$env:PATH"
node --version
npm --version
npm ci
npm run knowledge:bootstrap
npm run verify
npm run typecheck
npm run build
```

`npm ci` installs exactly the locked workspace dependencies. On the M00 workstation run it added 392 packages and audited 404; npm reported 15 advisories (6 moderate, 7 high, 2 critical) and deprecated-package notices. npm 11 blocked install scripts for three dependencies by default. The requested typecheck and Next.js build passed without approving those scripts. Do not run `npm audit fix` or approve additional scripts as part of routine verification.

The repository verifier reads the ignored `data/knowledge/knowledge-base.generated.json`. `npm run knowledge:bootstrap` creates that file locally from `data/knowledge/seed.json` and `data/knowledge/source-manifest.json`; it does not call a remote service or write to an application database. The generated file contains private profile facts and evidence copied from the seed. Treat both the seed and generated output as private. Do not commit, upload, attach to a review archive, or copy the generated file to an untrusted environment. Re-run the bootstrap after changing the seed or manifest.

The verifier normalizes CRLF to LF while reading `docs/MILESTONE_4.md` so that Windows line endings do not produce a false state-order mismatch. Its exact approval-gate assertion remains active.

## Safe local startup

The app starts through the web workspace's Next.js `dev` script. No local `.env*` files were present in the root or `apps/web` when M00 was checked. Do not copy production credentials into a local environment.

For a local-only smoke check, remove any inherited application credentials from the current PowerShell process, set `JOBHUNT_DATA_MODE=local`, disable Next.js telemetry, and bind the server to loopback:

```powershell
$nodeRoot = Join-Path $env:LOCALAPPDATA 'Programs\JobHuntAI\node-v24.22.2-win-x64'
$env:PATH = "$nodeRoot;$env:PATH"
$env:JOBHUNT_DATA_MODE = 'local'
$env:NEXT_TELEMETRY_DISABLED = '1'
npm --workspace @jobhunt/web run dev -- --hostname 127.0.0.1 --port 4173
```

In M00, this command reached Next.js `Ready` at `http://127.0.0.1:4173`. A GET of `/login` returned 200 and reported Supabase was unconfigured. A GET of `/api/health` returned the expected 503 with local data mode and no Supabase or Google OAuth configuration. These checks did not visit the dashboard or invoke mutation routes.

**Do not use the repository's local snapshots for write-capable testing.** Local mode reads private data from tracked JSON snapshots, and some local mutation helpers write back to those same files. With Supabase unconfigured, the login page offers a link to the local dashboard, so do not follow it on this checkout. Keep local startup bound to loopback. Until a separate synthetic-data workspace or disposable non-production backend is established, local snapshot testing is read-only and limited to non-personal routes such as `/login` and the configuration-only `/api/health` response.

No isolated writable environment or disposable test dataset has been established. Future controlled tests should use a separate worktree or temporary checkout populated only with clearly marked fictional records; cleanup must target only that isolated directory. Do not delete or rewrite the current repository's data to create a test baseline.

## M00 verified results

- `npm ci`: exit 0.
- `npm run knowledge:bootstrap`: exit 0; generated 7 facts, 18 evidence items, and 7 sources from the local seed.
- `npm run verify`: initial exit 1 on a CRLF/LF-only verifier mismatch; after line-ending normalization, exit 0 (`Repository contract verification passed`).
- `npm run typecheck`: initial exit 2 on widened success/failure return types in Memory-fit batch progress; after adding the discriminated result type and narrowing route checks, exit 0.
- `npm run build`: exit 0. Next.js reported the existing deprecated `middleware` convention warning.
- `npm --workspace @jobhunt/web run dev -- --hostname 127.0.0.1 --port 4173`: reached `Ready`; `/login` returned 200; `/api/health` returned the expected local-mode 503; the server was then stopped.

These automated and HTTP startup checks do not replace authenticated Computer Use acceptance. The native Computer Use path did not provide mouse coordinates or screenshot capture in M00, so user-perspective acceptance remains unverified.
