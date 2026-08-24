// Chrome is launched by chrome-service.mjs with --user-data-dir=~/.job-hunt/chrome-profile.
import { helperProfileDir } from "./helper-config.mjs";
import { ensureJobHuntChrome } from "./chrome-service.mjs";

function parseArgs(){const out={};const a=process.argv.slice(2);for(let i=0;i<a.length;i++)if(a[i].startsWith("--"))out[a[i].slice(2)]=a[i+1]&&!a[i+1].startsWith("--")?a[++i]:true;return out;}
const a=parseArgs();
ensureJobHuntChrome({cdpUrl:`http://127.0.0.1:${Number(a.port||9222)}`,profile:String(a.profile||helperProfileDir),url:String(a.url||"about:blank"),chrome:a.chrome?String(a.chrome):undefined})
  .then(({launched,cdpUrl})=>{console.log(`${launched?"Launched":"Found"} Job Hunt Chrome.`);console.log(`DevTools endpoint: ${cdpUrl}`);console.log(`Persistent profile: ${a.profile||helperProfileDir}`);})
  .catch((e)=>{console.error(e.message||e);process.exitCode=1;});
