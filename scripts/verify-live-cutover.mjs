import fs from "node:fs";
const required = [
  "database/migrations/0028_live_cutover_status.sql",
  "database/migrations/0029_live_cutover_status_privilege_fix.sql",
  "apps/web/app/commissioning/page.tsx",
  "apps/web/app/api/commissioning/claim/route.ts",
];
for (const file of required) if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
const migration = fs.readFileSync(required[0], "utf8");
const page = fs.readFileSync(required[2], "utf8");
const callback = fs.readFileSync("apps/web/app/auth/callback/route.ts", "utf8");
if (!migration.includes("get_live_cutover_status") || !migration.includes("gmail_refresh_credential")) throw new Error("Cutover RPC contract missing");
if (!page.includes("Historical application history loaded") || !page.includes("Encrypted Gmail read-only refresh credential")) throw new Error("Commissioning checklist incomplete");
if (!callback.includes('next = "/commissioning"')) throw new Error("First claimed login must redirect to commissioning");
console.log("Live cutover verification passed.");
