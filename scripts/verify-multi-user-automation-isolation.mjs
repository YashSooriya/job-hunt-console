import fs from 'node:fs';
const need=[
  'database/migrations/0037_multi_user_automation_isolation.sql',
  'database/migrations/0038_automation_invoker_boundary.sql',
  'supabase/functions/form-agent-bridge/index.ts',
  'apps/browser-agent/src/bridge.mjs',
  'apps/browser-agent/src/daemon.mjs',
  'apps/browser-agent/src/cli.mjs',
  'apps/web/lib/gmail-sync.ts',
  'docs/MILESTONE_18.md',
];
for(const f of need) if(!fs.existsSync(f)) throw new Error(`Missing M18 file: ${f}`);
const sql=fs.readFileSync(need[0],'utf8'); const invoker=fs.readFileSync(need[1],'utf8');
for(const marker of [
  'private.assert_active_app_membership',
  'browser_agent_service_pair_device',
  'browser_agent_service_authenticate_device',
  'browser_agent_service_member_active',
  'automation.credentials_revoked',
  "token_hash=encode(extensions.digest(extensions.gen_random_bytes(32),'sha256'),'hex')",
]) if(!sql.includes(marker)) throw new Error(`M18 database isolation marker missing: ${marker}`);
for(const unsafe of [
  'private.start_form_agent_session_for_user(uuid,uuid)',
  'private.get_form_agent_session_status_for_user(uuid,uuid)',
  'private.approve_form_agent_final_review_for_user(uuid,uuid)',
  'private.record_form_agent_manual_submission_for_user(uuid,uuid)',
  'private.create_browser_agent_pairing_code_for_user(uuid)',
  'private.get_browser_agent_helper_status_for_user(uuid)',
  'private.revoke_browser_agent_device_for_user(uuid,uuid)',
  'private.start_form_agent_session_for_paired_device(uuid,uuid,uuid)',
  'private.resume_form_agent_session_for_user(uuid,uuid)',
  'private.start_form_agent_acceptance_session_for_paired_device(uuid,uuid,uuid,text)',
  'private.get_ats_acceptance_status_for_user(uuid)',
]) if(!sql.includes(unsafe)) throw new Error(`M18 does not explicitly close private helper: ${unsafe}`);
if(!sql.includes('from public,anon,authenticated;')) throw new Error('M18 must revoke unsafe private helpers from authenticated users.');
for(const fn of ['public.start_form_agent_session','public.approve_form_agent_final_review','public.create_browser_agent_pairing_code','public.start_form_agent_session_for_device','public.resume_form_agent_session']) {
  const pos=sql.indexOf(`function ${fn}`); if(pos<0) throw new Error(`Missing hardened wrapper ${fn}`);
  const chunk=sql.slice(pos,pos+900); if(!chunk.includes('security definer')||!chunk.includes('assert_active_app_membership')) throw new Error(`Wrapper is not active-membership SECURITY DEFINER: ${fn}`);
}
for(const marker of ['start_form_agent_session_current_user','create_browser_agent_pairing_code_current_user','get_v1_launch_status_current_user','security invoker']) if(!invoker.includes(marker)) throw new Error(`M18 invoker-boundary marker missing: ${marker}`);
if(!invoker.includes('grant execute on function private.store_gmail_refresh_token(text), private.get_gmail_refresh_token() to authenticated')) throw new Error('Gmail safe current-user private helpers are not restored for invoker wrappers.');
const edge=fs.readFileSync('supabase/functions/form-agent-bridge/index.ts','utf8');
for(const marker of ['browser_agent_service_pair_device','browser_agent_service_authenticate_device','browser_agent_service_member_active','.eq("user_id", device.user_id)','session.browser_device_id']) if(!edge.includes(marker)) throw new Error(`M18 bridge isolation missing: ${marker}`);
const bridge=fs.readFileSync('apps/browser-agent/src/bridge.mjs','utf8');
if(!bridge.includes('x-browser-device-id')||!bridge.includes('x-browser-device-token')) throw new Error('Paired form sessions are not device-credential bound.');
const daemon=fs.readFileSync('apps/browser-agent/src/daemon.mjs','utf8');
if(!daemon.includes('JOBHUNT_BROWSER_DEVICE_ID')||!daemon.includes('JOBHUNT_BROWSER_DEVICE_TOKEN')) throw new Error('Daemon does not pass its paired device credential into form sessions.');
const gmail=fs.readFileSync('apps/web/lib/gmail-sync.ts','utf8');
if(!gmail.includes('supabase.auth.getUser()')||!gmail.includes('get_gmail_refresh_token')||!gmail.includes('process_application_email')) throw new Error('Per-user Gmail sync contract regressed.');
console.log('Milestone 18 multi-user automation isolation contracts passed.');
console.log('Gmail, paired browser helper, form sessions, Gate 2 and membership revocation are user-bound.');
