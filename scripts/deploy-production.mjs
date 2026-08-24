import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["scripts/verify-production-env.mjs"]);
run("npm", ["run", "production:verify"]);
run("npm", ["--workspace", "@jobhunt/web", "run", "deploy:cloudflare"]);
