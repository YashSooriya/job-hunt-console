import { AppShell } from "@/components/app-shell";
import { createClient } from "@/lib/supabase/server";

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <div className="factRow"><strong>{children}</strong><span className={`badge ${ok ? "review" : "action"}`}>{ok ? "Ready" : "Needs action"}</span></div>;
}

export default async function CommissioningPage() {
  const supabase = await createClient();
  const { data: status, error } = await supabase.rpc("get_live_cutover_status");
  const s = (status || {}) as any;
  const expectedHistory = Number(s.applications || 0) >= 26;
  const expectedKnowledge = Number(s.facts || 0) >= 7 && Number(s.evidence || 0) >= 18;
  return <AppShell>
    <div className="pageHeader"><div><div className="eyebrow">Milestone 13</div><h1 className="title">Live data commissioning</h1><p className="sub">This screen proves that Google sign-in, the staged historical import and Gmail read-only credentials are attached to the live Supabase account.</p></div></div>
    {error ? <div className="errorNotice">Commissioning status could not be read: {error.message}</div> : null}
    <section className="metrics">
      <div className="metric"><span>Applications</span><strong>{s.applications ?? 0}</strong></div>
      <div className="metric"><span>Facts</span><strong>{s.facts ?? 0}</strong></div>
      <div className="metric"><span>Evidence</span><strong>{s.evidence ?? 0}</strong></div>
      <div className="metric"><span>Assessments</span><strong>{s.assessments ?? 0}</strong></div>
    </section>
    <section className="card">
      <div className="cardHeader"><div><h2>Cutover checklist</h2><p>No item is inferred from local snapshot data.</p></div></div>
      <div className="factsList">
        <Check ok={Boolean(s.profile_exists)}>Live candidate profile exists</Check>
        <Check ok={Number(s.pending_bootstrap_batches || 0) === 0 && Number(s.claimed_bootstrap_batches || 0) > 0}>Historical bootstrap claimed</Check>
        <Check ok={expectedKnowledge}>Knowledge base loaded (at least 7 facts / 18 evidence)</Check>
        <Check ok={expectedHistory}>Historical application history loaded (at least 26)</Check>
        <Check ok={Boolean(s.gmail_refresh_credential)}>Encrypted Gmail read-only refresh credential captured</Check>
      </div>
    </section>
    {!s.cutover_complete ? <form action="/api/commissioning/claim" method="post"><button className="primaryButton" type="submit">Retry historical import</button></form> : null}
    {s.cutover_complete && s.gmail_refresh_credential ? <div className="notice">Core live-data cutover is complete. Gmail can now be tested from the dashboard.</div> : <div className="notice">The first production Google sign-in should bring every item above to Ready. Gmail requires Google to return an offline refresh token during consent.</div>}
  </AppShell>;
}
