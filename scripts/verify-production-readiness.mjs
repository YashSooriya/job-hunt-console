import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const required = [
  "apps/web/wrangler.jsonc",
  "apps/web/open-next.config.ts",
  "apps/web/middleware.ts",
  "apps/web/app/api/health/route.ts",
  "apps/browser-agent/src/launch-chrome.mjs",
  "apps/browser-agent/src/cli.mjs",
  "supabase/functions/form-agent-bridge/index.ts",
  "docs/MILESTONE_11.md",
  "docs/MILESTONE_12.md",
  "scripts/verify-production-env.mjs",
  "scripts/deploy-production.mjs",
  "docs/PRODUCTION_RUNBOOK.md",
  "docs/ATS_ACCEPTANCE.md",
  "deploy-first-time-mac.sh",
  "deploy/production-public.env",
];
const missing = required.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) throw new Error(`Missing production files: ${missing.join(", ")}`);

const wrangler = fs.readFileSync(path.join(root, "apps/web/wrangler.jsonc"), "utf8");
if (!wrangler.includes('"nodejs_compat"')) throw new Error("Cloudflare config must enable nodejs_compat.");
if (!wrangler.includes('"compatibility_date": "2026-08-23"')) throw new Error("Cloudflare compatibility date is not frozen for this milestone.");

if (fs.existsSync(path.join(root, "apps/web/proxy.ts"))) throw new Error("proxy.ts is incompatible with the current Cloudflare OpenNext path; use Edge middleware.ts.");
const middleware = fs.readFileSync(path.join(root, "apps/web/middleware.ts"), "utf8");
if (!middleware.includes("updateSession")) throw new Error("Production middleware must refresh/enforce the Supabase session.");

const agent = fs.readFileSync(path.join(root, "apps/browser-agent/src/cli.mjs"), "utf8");
if (!agent.includes("noSubmit")) throw new Error("Browser acceptance mode must prohibit submission.");
if (!agent.includes("Submission was not clicked")) throw new Error("Acceptance mode stop must be explicit.");

const env = fs.readFileSync(path.join(root, ".env.example"), "utf8");
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
  if (!env.includes(`${key}=`)) throw new Error(`Missing production env contract: ${key}`);
}

const health = fs.readFileSync(path.join(root, "apps/web/app/api/health/route.ts"), "utf8");
if (!health.includes("supabaseReachable")) throw new Error("Hosted health check must verify Supabase reachability.");
if (!health.includes('deploymentTarget: "cloudflare-workers"')) throw new Error("Hosted health check must identify the Cloudflare deployment target.");

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (rootPackage.scripts?.["production:deploy"] !== "node scripts/deploy-production.mjs") throw new Error("Canonical production deploy command missing.");
if (rootPackage.scripts?.["production:env:verify"] !== "node scripts/verify-production-env.mjs") throw new Error("Production environment verifier command missing.");

const webPackage = JSON.parse(fs.readFileSync(path.join(root, "apps/web/package.json"), "utf8"));
if (!webPackage.scripts?.["deploy:cloudflare"]?.includes("--keep-vars")) throw new Error("Subsequent Cloudflare deployments must preserve runtime variables/secrets.");

const firstDeploy = fs.readFileSync(path.join(root, "deploy-first-time-mac.sh"), "utf8");
for (const marker of ["npm install --no-audit --no-fund", "wrangler login", "--secrets-file", "/api/health", "opennextjs-cloudflare build"]) {
  if (!firstDeploy.includes(marker)) throw new Error(`First-deployment script missing required step: ${marker}`);
}
if (firstDeploy.includes('GOOGLE_CLIENT_SECRET="') || firstDeploy.includes('CLOUDFLARE_API_TOKEN=')) throw new Error("First-deployment script must not embed external account secrets.");

console.log("Production readiness contracts passed.");
console.log("Cloudflare/OpenNext config present, Edge middleware compatible, no-submit browser acceptance enforced, deployment guard present.");
