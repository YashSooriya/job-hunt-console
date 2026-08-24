import { createClient } from "@/lib/supabase/server";
export async function requireProfile() {
  const supabase=await createClient();
  const {data:userData,error:userError}=await supabase.auth.getUser();
  if(userError||!userData.user) throw new Error('AUTH_REQUIRED');
  const {data:profile,error}=await supabase.from('candidate_profiles').select('id,user_id,display_name').eq('user_id',userData.user.id).single();
  if(error||!profile) throw new Error('PROFILE_REQUIRED');
  return {supabase,user:userData.user,profile};
}
export function text(value:unknown,max=5000){return typeof value==='string'?value.trim().slice(0,max):''}
export function nullable(value:unknown,max=5000){const v=text(value,max);return v||null}
export function statusCode(error:unknown){const m=error instanceof Error?error.message:String(error);return m==='AUTH_REQUIRED'?401:m==='PROFILE_REQUIRED'?404:400}
