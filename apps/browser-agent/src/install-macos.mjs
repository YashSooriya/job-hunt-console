import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadHelperConfig, ensureHelperDirs, helperLogsDir } from "./helper-config.mjs";
import { readDeviceToken } from "./keychain.mjs";
import { launchAgentLabel, launchAgentPath, launchAgentPlist } from "./launch-agent.mjs";

function run(args){return execFileSync("/bin/launchctl",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]});}
function main(){
  if(process.platform!=="darwin")throw new Error("Auto-start installation currently supports macOS only.");
  const cfg=loadHelperConfig();if(!cfg?.deviceId)throw new Error("Pair this Mac before installing auto-start.");if(!readDeviceToken(cfg.deviceId))throw new Error("The paired device credential is missing from Keychain.");
  ensureHelperDirs();fs.mkdirSync(path.dirname(launchAgentPath),{recursive:true});
  const here=path.dirname(fileURLToPath(import.meta.url));const daemonPath=path.join(here,"daemon.mjs");const workingDirectory=path.resolve(here,"../../..");
  const plist=launchAgentPlist({nodePath:process.execPath,daemonPath,workingDirectory,stdoutPath:path.join(helperLogsDir,"helper.log"),stderrPath:path.join(helperLogsDir,"helper.err.log")});
  fs.writeFileSync(launchAgentPath,plist,{mode:0o600});
  const domain=`gui/${process.getuid()}`;try{run(["bootout",domain,launchAgentPath]);}catch{}
  run(["bootstrap",domain,launchAgentPath]); run(["kickstart","-k",`${domain}/${launchAgentLabel}`]);
  console.log(`Installed JobHuntAI Browser Helper LaunchAgent: ${launchAgentPath}`);
  console.log("It will start automatically for this macOS user at login.");
  console.log("Check it with: npm run browser:status");
}
try{main();}catch(e){console.error(`Install failed: ${e.message||e}`);process.exitCode=1;}
