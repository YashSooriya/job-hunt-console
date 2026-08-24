import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceBridgeClient } from "./device-bridge.mjs";
import { loadHelperConfig } from "./helper-config.mjs";
import { readDeviceToken } from "./keychain.mjs";
import { ensureJobHuntChrome, chromeReady } from "./chrome-service.mjs";

const here=path.dirname(fileURLToPath(import.meta.url));
const cliPath=path.join(here,"cli.mjs");
const state={startedAt:new Date().toISOString(),paired:false,bridge:false,chrome:false,currentSession:null,lastHeartbeat:null,lastError:null};

function healthServer(port){
  const server=http.createServer((req,res)=>{if(req.url!=="/health"){res.writeHead(404);return res.end("not found");}res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({ok:true,...state}));});
  server.listen(port,"127.0.0.1"); return server;
}

function runSession({sessionId,token,supabaseUrl,cdpUrl,deviceId,deviceToken,acceptanceMode=false,acceptanceProviderFamily=null}){
  state.currentSession=sessionId;
  return new Promise((resolve)=>{
    const childArgs=[cliPath,"--session",sessionId,"--supabase",supabaseUrl,"--cdp",cdpUrl];
    if(acceptanceMode){childArgs.push("--no-submit");if(acceptanceProviderFamily)childArgs.push("--acceptance-provider",acceptanceProviderFamily);}
    const child=spawn(process.execPath,childArgs,{stdio:"inherit",env:{...process.env,JOBHUNT_FORM_TOKEN:token,JOBHUNT_BROWSER_DEVICE_ID:deviceId,JOBHUNT_BROWSER_DEVICE_TOKEN:deviceToken,JOBHUNT_DAEMON_MODE:"1"}});
    child.on("exit",(code,signal)=>{state.currentSession=null;resolve({code,signal});});
  });
}

async function main(){
  const config=loadHelperConfig();
  if(!config?.deviceId||!config?.supabaseUrl) throw new Error("Browser helper is not paired. Pair it from Job Hunt Settings first.");
  const token=readDeviceToken(config.deviceId); if(!token) throw new Error("Browser helper device credential is missing from macOS Keychain. Re-pair this Mac.");
  state.paired=true;
  healthServer(Number(config.healthPort||43712));
  const bridge=new DeviceBridgeClient({baseUrl:config.supabaseUrl,deviceId:config.deviceId,token});
  await ensureJobHuntChrome({cdpUrl:config.cdpUrl||"http://127.0.0.1:9222"}); state.chrome=true;
  console.log(`Job Hunt browser helper running for ${config.displayName||config.deviceId}.`);

  while(true){
    try{
      state.chrome=await chromeReady(config.cdpUrl||"http://127.0.0.1:9222");
      if(!state.chrome){await ensureJobHuntChrome({cdpUrl:config.cdpUrl||"http://127.0.0.1:9222"});state.chrome=true;}
      const poll=await bridge.call("device_poll",{helperVersion:"0.1.0"});
      state.bridge=true;state.lastHeartbeat=new Date().toISOString();state.lastError=null;
      if(poll.session?.id&&poll.form_token){
        console.log(`Picked up form session ${poll.session.id}.`);
        let heartbeat=setInterval(()=>bridge.call("device_heartbeat",{helperVersion:"0.1.0"}).then(()=>{state.lastHeartbeat=new Date().toISOString();}).catch(()=>{}),10000);
        await runSession({sessionId:poll.session.id,token:poll.form_token,supabaseUrl:config.supabaseUrl,cdpUrl:config.cdpUrl||"http://127.0.0.1:9222",deviceId:config.deviceId,deviceToken:token,acceptanceMode:Boolean(poll.session.acceptance_mode),acceptanceProviderFamily:poll.session.acceptance_provider_family||null});
        clearInterval(heartbeat);
      }
    }catch(e){state.bridge=false;state.lastError=e.message||String(e);console.error(`Helper poll failed: ${state.lastError}`);}
    await new Promise(r=>setTimeout(r,5000));
  }
}
main().catch((e)=>{state.lastError=e.message||String(e);console.error(`Browser helper stopped: ${state.lastError}`);process.exitCode=1;});
