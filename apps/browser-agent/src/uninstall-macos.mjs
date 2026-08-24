import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { launchAgentLabel,launchAgentPath } from "./launch-agent.mjs";
import { loadHelperConfig } from "./helper-config.mjs";
import { deleteDeviceToken } from "./keychain.mjs";

try{
  if(process.platform!=="darwin")throw new Error("macOS only");
  const domain=`gui/${process.getuid()}`;try{execFileSync("/bin/launchctl",["bootout",domain,launchAgentPath],{stdio:"ignore"});}catch{}
  if(fs.existsSync(launchAgentPath))fs.unlinkSync(launchAgentPath);
  const cfg=loadHelperConfig();if(cfg?.deviceId)deleteDeviceToken(cfg.deviceId);
  console.log(`Removed ${launchAgentLabel}. Revoke the device from Job Hunt Settings if it is still listed there.`);
}catch(e){console.error(`Uninstall failed: ${e.message||e}`);process.exitCode=1;}
