import { spawnSync, execFileSync } from "node:child_process";

const SERVICE = "JobHuntBrowserHelper";

function requireMac() {
  if (process.platform !== "darwin") throw new Error("Browser-helper Keychain storage currently supports macOS only.");
}

export function saveDeviceToken(deviceId, token) {
  requireMac();
  const result=spawnSync("/usr/bin/security", ["add-generic-password", "-a", deviceId, "-s", SERVICE, "-U", "-w"], { input: `${token}\n`, encoding: "utf8", stdio: ["pipe", "ignore", "pipe"] });
  if(result.status!==0) throw new Error(`Could not store browser-helper credential in Keychain: ${String(result.stderr||"").trim()}`);
}

export function readDeviceToken(deviceId) {
  requireMac();
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-a", deviceId, "-s", SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export function deleteDeviceToken(deviceId) {
  requireMac();
  try { execFileSync("/usr/bin/security", ["delete-generic-password", "-a", deviceId, "-s", SERVICE], { stdio: "ignore" }); } catch {}
}
