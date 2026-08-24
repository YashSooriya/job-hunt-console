import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { helperProfileDir, ensureHelperDirs } from "./helper-config.mjs";

export function chromeCandidates() {
  if (process.platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  if (process.platform === "win32") return [
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
  ];
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export async function chromeReady(cdpUrl="http://127.0.0.1:9222") {
  try { const r=await fetch(`${cdpUrl.replace(/\/$/,"")}/json/version`,{signal:AbortSignal.timeout(1200)}); return r.ok; } catch { return false; }
}

export async function ensureJobHuntChrome({cdpUrl="http://127.0.0.1:9222",profile=helperProfileDir,url="about:blank",chrome}={}) {
  if(await chromeReady(cdpUrl)) return {launched:false,cdpUrl};
  const executable=chrome||chromeCandidates().find((p)=>fs.existsSync(p));
  if(!executable) throw new Error("Google Chrome was not found. Install Chrome or start the Job Hunt profile manually.");
  ensureHelperDirs(); fs.mkdirSync(profile,{recursive:true});
  const port=Number(new URL(cdpUrl).port||9222);
  const child=spawn(executable,[`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check",url],{detached:true,stdio:"ignore"});
  child.unref();
  for(let i=0;i<25;i++){await new Promise(r=>setTimeout(r,200));if(await chromeReady(cdpUrl))return{launched:true,cdpUrl};}
  throw new Error("Job Hunt Chrome launched but its DevTools endpoint did not become ready.");
}
