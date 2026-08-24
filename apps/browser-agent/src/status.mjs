import { loadHelperConfig } from "./helper-config.mjs";
import { readDeviceToken } from "./keychain.mjs";

async function main(){
  const cfg=loadHelperConfig(); if(!cfg){console.log(JSON.stringify({paired:false,running:false},null,2));return;}
  const keychain=Boolean(readDeviceToken(cfg.deviceId)); let health=null;
  try{const r=await fetch(`http://127.0.0.1:${cfg.healthPort||43712}/health`,{signal:AbortSignal.timeout(1200)});if(r.ok)health=await r.json();}catch{}
  console.log(JSON.stringify({paired:keychain,deviceId:cfg.deviceId,displayName:cfg.displayName,running:Boolean(health),health},null,2));
}
main().catch(e=>{console.error(e.message||e);process.exitCode=1;});
