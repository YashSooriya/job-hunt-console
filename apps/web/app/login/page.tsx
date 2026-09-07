import { SignInButton } from "@/components/sign-in-button";
import { isSupabaseConfigured } from "@/lib/config";
export default async function LoginPage({searchParams}:{searchParams:Promise<{next?:string;error?:string}>}) {
  const params=await searchParams; const configured=isSupabaseConfigured(); const nextPath=params.next?.startsWith('/')?params.next:'/';
  const errorText=params.error==='revoked'?'Your JobHuntAI Console membership has been revoked.':params.error==='not-member'?'This Google account does not have an active JobHuntAI Console invitation or membership.':params.error?'Google sign-in could not be completed.':null;
  return <main className="loginPage"><section className="loginCard"><div className="eyebrow">Invite-only workspace</div><h1 className="title">JobHuntAI</h1><p className="sub">Sign in with the exact Google account that was invited to JobHuntAI Console.</p>{errorText?<div className="errorNotice">{errorText}</div>:null}{configured?<SignInButton nextPath={nextPath}/>:<div className="notice">Supabase is not configured. Authentication is bypassed only for local development.</div>}{!configured?<a className="textLink" href="/">Open local development dashboard</a>:null}</section></main>;
}
