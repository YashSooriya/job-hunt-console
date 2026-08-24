import fs from "node:fs";
import path from "node:path";
import { launchAgentPlist } from "../apps/browser-agent/src/launch-agent.mjs";

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),"utf8");
function ok(cond,msg){if(!cond)throw new Error(msg);}

const migration=read("database/migrations/0030_browser_helper_commissioning.sql");
ok(migration.includes("browser_agent_devices"),"device table missing");
ok(migration.includes("browser_agent_pairing_codes"),"pairing table missing");
ok(migration.includes("start_form_agent_session_for_device"),"paired session RPC missing");
ok(migration.includes("resume_form_agent_session"),"resume RPC missing");
ok(migration.includes("token_hash"),"hashed device credentials missing");

const pair=read("apps/browser-agent/src/pair.mjs");
ok(pair.includes("saveDeviceToken"),"pairing does not use Keychain token store");
ok(!pair.includes("device_token:"),"pairing source appears to persist raw token in config");
const config=read("apps/browser-agent/src/helper-config.mjs");
ok(config.includes("helper.json"),"helper config missing");
const keychain=read("apps/browser-agent/src/keychain.mjs");
ok(keychain.includes("/usr/bin/security"),"macOS Keychain integration missing");
ok(keychain.includes("input: `${token}\\n`") || keychain.includes("input: `${token}\n`"),"Keychain token is not fed via stdin");
ok(!keychain.includes('"-w", token'),"Keychain token must not appear in security process arguments");

const daemon=read("apps/browser-agent/src/daemon.mjs");
ok(daemon.includes("device_poll"),"daemon does not poll paired sessions");
ok(daemon.includes("JOBHUNT_FORM_TOKEN"),"daemon does not inject short-lived token via environment");
ok(daemon.includes("JOBHUNT_DAEMON_MODE"),"daemon background mode missing");
ok(daemon.includes("127.0.0.1"),"local-only health endpoint missing");

const edge=read("supabase/functions/form-agent-bridge/index.ts");
ok(edge.includes('op === "pair_device"'),"edge pairing operation missing");
ok(edge.includes('op === "device_poll"'),"edge device polling operation missing");
ok(edge.includes("authenticateDevice"),"device credential authentication missing");
ok(edge.includes("form_token"),"session token handoff missing");

const panel=read("apps/web/components/form-agent-panel.tsx");
ok(panel.includes("Queued for the paired Mac helper"),"paired helper UX missing");
ok(panel.includes("Resume helper"),"background resume UX missing");
const settings=read("apps/web/components/browser-helper-settings.tsx");
ok(settings.includes("Pair this Mac"),"pairing UI missing");
ok(settings.includes("macOS Keychain"),"Keychain disclosure missing");

const plist=launchAgentPlist({nodePath:"/opt/node",daemonPath:"/repo/daemon.mjs",workingDirectory:"/repo",stdoutPath:"/tmp/out.log",stderrPath:"/tmp/err.log"});
ok(plist.includes("com.jobhunt.browser-helper"),"LaunchAgent label missing");
ok(plist.includes("RunAtLoad"),"LaunchAgent does not run at login");
ok(plist.includes("KeepAlive"),"LaunchAgent keep-alive missing");

const pkg=JSON.parse(read("package.json"));
for(const script of ["browser:pair","browser:install-mac","browser:status","browser:uninstall-mac"])ok(pkg.scripts[script],`root script missing: ${script}`);

console.log("Browser helper commissioning verification passed.");
console.log("One-time pairing: yes");
console.log("macOS Keychain credential storage: yes");
console.log("LaunchAgent auto-start: yes");
console.log("Per-application token copy in paired flow: no");
console.log("Background pause/resume through web app: yes");
