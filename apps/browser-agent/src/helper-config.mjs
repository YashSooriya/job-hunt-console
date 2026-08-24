import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const helperHome = path.join(os.homedir(), ".job-hunt");
export const helperConfigPath = path.join(helperHome, "helper.json");
export const helperLogsDir = path.join(helperHome, "logs");
export const helperProfileDir = path.join(helperHome, "chrome-profile");

export function ensureHelperDirs() {
  fs.mkdirSync(helperHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(helperLogsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(helperProfileDir, { recursive: true, mode: 0o700 });
}

export function loadHelperConfig() {
  if (!fs.existsSync(helperConfigPath)) return null;
  return JSON.parse(fs.readFileSync(helperConfigPath, "utf8"));
}

export function saveHelperConfig(config) {
  ensureHelperDirs();
  fs.writeFileSync(helperConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(helperConfigPath, 0o600);
}
