import os from "node:os";
import { saveDeviceToken } from "./keychain.mjs";
import { saveHelperConfig } from "./helper-config.mjs";

function args() {
  const out = {}; const a = process.argv.slice(2);
  for (let i=0;i<a.length;i++) if (a[i].startsWith("--")) out[a[i].slice(2)] = a[i+1] && !a[i+1].startsWith("--") ? a[++i] : true;
  return out;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Milestone 14 pairing is currently commissioned for macOS.");
  const a=args();
  if(!a.code||!a.supabase) throw new Error("Usage: npm run browser:pair -- --code <pairing-code> --supabase <https://project.supabase.co>");
  const url=`${String(a.supabase).replace(/\/$/,"")}/functions/v1/form-agent-bridge`;
  const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({op:"pair_device",pairingCode:String(a.code),displayName:String(a.name||`${os.hostname()} Job Hunt Helper`),platform:"macos",helperVersion:"0.1.0"})});
  const text=await response.text(); let data; try{data=JSON.parse(text)}catch{data={error:text}};
  if(!response.ok) throw new Error(data.error||`Pairing failed (${response.status}).`);
  if(!data.device?.id||!data.device_token) throw new Error("Pairing response did not contain a device credential.");
  saveDeviceToken(data.device.id,data.device_token);
  saveHelperConfig({schemaVersion:"1.0.0",deviceId:data.device.id,displayName:data.device.display_name,supabaseUrl:String(a.supabase).replace(/\/$/,""),pairedAt:new Date().toISOString(),cdpUrl:"http://127.0.0.1:9222",healthPort:43712});
  console.log(`Paired ${data.device.display_name}.`);
  console.log("The device credential was stored in macOS Keychain and was not written to the repository or config file.");
  console.log("Next: npm run browser:install-mac");
}
main().catch((e)=>{console.error(`Pairing failed: ${e.message||e}`);process.exitCode=1;});
