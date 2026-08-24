import path from "node:path";
import os from "node:os";

export const launchAgentLabel="com.jobhunt.browser-helper";
export const launchAgentPath=path.join(os.homedir(),"Library","LaunchAgents",`${launchAgentLabel}.plist`);

function xml(value){return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
export function launchAgentPlist({nodePath,daemonPath,workingDirectory,stdoutPath,stderrPath}){
return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${launchAgentLabel}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(daemonPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(stdoutPath)}</string>
<key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
</dict></plist>\n`;
}
