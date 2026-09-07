#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WEB="$ROOT/apps/web"
PUBLIC_ENV="$ROOT/deploy/production-public.env"
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/jobhunt-cloudflare-deploy.XXXXXX")"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/jobhunt-cloudflare-secrets.XXXXXX")"
DRY_LOG="$(mktemp "${TMPDIR:-/tmp}/jobhunt-cloudflare-dryrun.XXXXXX")"
cleanup() {
  rm -f "$DEPLOY_LOG" "$SECRETS_FILE" "$DRY_LOG"
}
trap cleanup EXIT

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$PUBLIC_ENV" ] || fail "Missing $PUBLIC_ENV"

# Load only the known public deployment values without using shell eval/source.
read_env() {
  local key="$1"
  node - "$PUBLIC_ENV" "$key" <<'NODE'
const fs = require("fs");
const [path, wanted] = process.argv.slice(2);
for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const index = line.indexOf("=");
  const key = line.slice(0, index).trim();
  if (key !== wanted) continue;
  let value = line.slice(index + 1).trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  process.stdout.write(value);
  break;
}
NODE
}

export NEXT_PUBLIC_APP_NAME="$(read_env NEXT_PUBLIC_APP_NAME)"
export NEXT_PUBLIC_SUPABASE_URL="$(read_env NEXT_PUBLIC_SUPABASE_URL)"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$(read_env NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"
export JOBHUNT_DATA_MODE="$(read_env JOBHUNT_DATA_MODE)"
export NEXT_PUBLIC_GOOGLE_PICKER_API_KEY="$(read_env NEXT_PUBLIC_GOOGLE_PICKER_API_KEY)"
export NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER="$(read_env NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER)"

say "Checking prerequisites"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 22 LTS or newer, then rerun this script."
command -v npm >/dev/null 2>&1 || fail "npm is not installed. Install Node.js 22 LTS or newer, then rerun this script."
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required. Current version: $(node -v)"
printf 'Node: %s\nnpm:  %s\n' "$(node -v)" "$(npm -v)"

say "Installing application dependencies"
cd "$ROOT"
npm install --no-audit --no-fund

say "Running production preflight checks"
node scripts/verify-production-env.mjs
npm run production:verify

say "Building the Cloudflare/OpenNext production bundle"
cd "$WEB"
npx --no-install opennextjs-cloudflare build

say "Checking the generated Worker bundle"
# This does not deploy anything. It gives us Wrangler's compressed upload-size report.
set +e
npx --no-install wrangler deploy --dry-run --outdir .wrangler-dry-run 2>&1 | tee "$DRY_LOG"
DRY_STATUS=${PIPESTATUS[0]}
set -e
[ "$DRY_STATUS" -eq 0 ] || fail "The Cloudflare dry-run failed. Send the Terminal output to ChatGPT before attempting a real deployment."

# Workers Free currently permits a 3 MiB compressed Worker. Abort before login if
# Wrangler reports a larger gzip size so we can reduce the bundle without asking
# you to choose a paid plan.
node - "$DRY_LOG" <<'NODE'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const match = text.match(/gzip:\s*([0-9.]+)\s*(B|KiB|MiB|KB|MB)/i);
if (!match) process.exit(0);
const value = Number(match[1]);
const unit = match[2].toLowerCase();
const factors = { b: 1, kib: 1024, mib: 1024 ** 2, kb: 1000, mb: 1000 ** 2 };
const bytes = value * factors[unit];
console.log(`Compressed Worker size reported by Wrangler: ${match[1]} ${match[2]}`);
if (bytes > 3 * 1024 ** 2) {
  console.error("The generated Worker exceeds the 3 MiB Cloudflare Workers Free limit. Do not upgrade. Send this output to ChatGPT so the bundle can be reduced or split.");
  process.exit(2);
}
NODE

# Runtime environment values. They are sent as Worker secrets on first deploy so
# no personal account value is written to source control or Wrangler config.
cat > "$SECRETS_FILE" <<EOF_SECRETS
NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
JOBHUNT_DATA_MODE=$JOBHUNT_DATA_MODE
NEXT_PUBLIC_GOOGLE_PICKER_API_KEY=$NEXT_PUBLIC_GOOGLE_PICKER_API_KEY
NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER=$NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER
EOF_SECRETS

# The service-role key is required by the server-side ChatGPT Sheet broker and
# must never be placed in the public deployment env file or client bundle.
if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "$SUPABASE_SERVICE_ROLE_KEY" >> "$SECRETS_FILE"
fi

# If Google OAuth has already been configured locally, carry it into the Worker.
if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; then
  printf 'GOOGLE_CLIENT_ID=%s\n' "$GOOGLE_CLIENT_ID" >> "$SECRETS_FILE"
  printf 'GOOGLE_CLIENT_SECRET=%s\n' "$GOOGLE_CLIENT_SECRET" >> "$SECRETS_FILE"
fi

say "Checking Cloudflare authentication"
if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
  printf '\nCloudflare authentication is required. A browser window will open.\n'
  printf 'Sign in to the Cloudflare account you want to use and approve Wrangler access.\n\n'
  npx --no-install wrangler login
fi
npx --no-install wrangler whoami

say "Deploying JobHuntAI Console to Cloudflare Workers"
# OpenNext forwards arguments after -- to Wrangler. --secrets-file also works on
# the first deployment, so the Worker can be created with its runtime values in
# one operation rather than requiring dashboard configuration first.
set +e
npx --no-install opennextjs-cloudflare deploy -- --secrets-file "$SECRETS_FILE" 2>&1 | tee "$DEPLOY_LOG"
DEPLOY_STATUS=${PIPESTATUS[0]}
set -e
[ "$DEPLOY_STATUS" -eq 0 ] || fail "Cloudflare deployment failed. Keep the Terminal output and send it to ChatGPT so the deployment can be fixed."

WORKER_URL="$(grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev' "$DEPLOY_LOG" | tail -n 1 || true)"
if [ -z "$WORKER_URL" ]; then
  printf '\nDeployment succeeded, but the workers.dev URL could not be parsed automatically.\n'
  printf 'Copy the URL printed by Wrangler above.\n'
  exit 0
fi

say "Verifying the hosted health endpoint"
printf 'Hosted URL: %s\n' "$WORKER_URL"
HEALTH_URL="${WORKER_URL%/}/api/health"
if command -v curl >/dev/null 2>&1; then
  HEALTH="$(curl -fsS --max-time 15 "$HEALTH_URL")" || fail "The Worker deployed but $HEALTH_URL did not return a successful response. Send the deployment output to ChatGPT."
  printf '%s\n' "$HEALTH" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{process.stdout.write(s)}})' 
else
  printf 'Open this health URL manually: %s\n' "$HEALTH_URL"
fi

printf '\nSUCCESS\n'
printf 'JobHuntAI Console is hosted at:\n  %s\n' "$WORKER_URL"
printf '\nThe next commissioning step is Google OAuth. Until that is configured, protected pages will correctly show the Google login screen rather than the application dashboard.\n'
