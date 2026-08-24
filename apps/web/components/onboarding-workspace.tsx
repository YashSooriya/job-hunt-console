"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type State = any;

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options?.headers || {}),
      ...(options?.body instanceof FormData ? {} : { "content-type": "application/json" }),
    },
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function valueText(value: any) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function OnboardingWorkspace() {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cvFile, setCvFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(await api("/api/onboarding/state", { cache: "no-store" }));
  }, []);
  useEffect(() => { load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load activation.")); }, [load]);

  const readiness = data?.readiness || {};
  const pending = useMemo(() => [
    ...(data?.facts || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, kind: "fact" })),
    ...(data?.evidence || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, kind: "evidence" })),
    ...(data?.extractionProposals || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, kind: "proposal" })),
  ], [data]);

  async function run(operation: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try { await operation(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Request failed."); }
    finally { setBusy(false); }
  }

  async function postForm(event: FormEvent<HTMLFormElement>, url: string, transform: (form: FormData) => any) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(() => api(url, { method: "POST", body: JSON.stringify(transform(form)) }));
    event.currentTarget.reset();
  }

  const checkItems = [
    ["Profile verified", Boolean(readiness.history > 0 && readiness.work_authorisation)],
    ["Job preferences complete", Boolean(readiness.preferences_complete)],
    ["CV evidence reviewed", Boolean(readiness.source_document_extracted && readiness.pending_review === 0)],
    ["Gmail connected", Boolean(readiness.gmail_connected)],
    ["ChatGPT connected", Boolean(readiness.chatgpt_connected)],
    ["Browser helper paired", Boolean(readiness.browser_helper_paired)],
    ["Automation ready", Boolean(readiness.ready)],
  ] as const;

  return <div className="onboardingWorkspace">
    {error ? <div className="errorNotice">{error}</div> : null}

    <section className="onboardingProgress card">
      <div className="cardHeader"><div><div className="eyebrow">One-time setup</div><h2>Activation checklist</h2><p>Imported material is amber until you review it. Red or missing personal answers are never guessed.</p></div><strong>{readiness.score ?? 0}%</strong></div>
      <div className="readinessBar"><i style={{ width: `${readiness.score ?? 0}%` }} /></div>
      <div className="readinessChecks">{checkItems.map(([label, done]) => <span className={done ? "done" : ""} key={label}>{label}</span>)}</div>
    </section>

    <section className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 1</div><h2>Your personal details</h2><p>Enter facts that must never be inferred from a CV, including work authorisation and notice period.</p></div></div>
      <form className="onboardingForm two" onSubmit={(event) => postForm(event, "/api/onboarding/profile", (form) => ({ displayName: form.get("displayName"), email: form.get("email"), phone: form.get("phone"), location: form.get("location"), workAuthorisation: form.get("workAuthorisation"), noticePeriod: form.get("noticePeriod") }))}>
        <label><span>Name</span><input name="displayName" required defaultValue={data?.profile?.display_name || ""} /></label>
        <label><span>Email</span><input name="email" type="email" defaultValue={(data?.facts || []).find((item: any) => item.fact_key === "email")?.value_json || ""} /></label>
        <label><span>Phone</span><input name="phone" defaultValue={(data?.facts || []).find((item: any) => item.fact_key === "phone")?.value_json || ""} /></label>
        <label><span>Current location</span><input name="location" defaultValue={(data?.facts || []).find((item: any) => item.fact_key === "location")?.value_json || ""} /></label>
        <label><span>Work authorisation</span><input name="workAuthorisation" required placeholder="Exact factual status" defaultValue={(data?.facts || []).find((item: any) => item.fact_key === "work_authorisation")?.value_json || ""} /></label>
        <label><span>Notice period</span><input name="noticePeriod" defaultValue={(data?.facts || []).find((item: any) => item.fact_key === "notice_period")?.value_json || ""} /></label>
        <div className="formActions"><button className="primaryButton" disabled={busy}>Save personal details</button></div>
      </form>
    </section>

    <section className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 2</div><h2>Upload your CV</h2><p>PDF, DOCX, TXT, Markdown and RTF are parsed on the server. The original is stored in a private per-user bucket; no text pasting is required.</p></div></div>
      <form className="onboardingForm" onSubmit={(event) => { event.preventDefault(); if (!cvFile) { setError("Choose a CV file."); return; } const form = new FormData(); form.set("file", cvFile); void run(() => api("/api/onboarding/import-cv", { method: "POST", body: form })).then(() => setCvFile(null)); }}>
        <label><span>CV file</span><input type="file" accept=".pdf,.docx,.txt,.md,.markdown,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/rtf" onChange={(event) => setCvFile(event.target.files?.[0] || null)} /></label>
        <button className="primaryButton" disabled={busy || !cvFile}>{busy ? "Parsing privately…" : "Upload and extract"}</button>
      </form>
      <div className="compactList">{(data?.sourceDocuments || []).map((item: any) => <div key={item.id}><strong>{item.original_name}</strong><span>{item.extraction_format || "document"} · {String(item.extraction_status).replaceAll("_", " ")}{item.extraction_error ? ` · ${item.extraction_error}` : ""}</span></div>)}</div>
    </section>

    <section className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 3</div><h2>Review extracted profile evidence</h2><p>Every extracted fact is amber. Approve, edit or reject it before it can influence job matching or application writing.</p></div><span className={`badge ${pending.length ? "action" : "review"}`}>{pending.length} pending</span></div>
      <div className="reviewProposalList">{pending.length ? pending.map((item: any) => <ReviewProposal key={`${item.kind}-${item.id}`} item={item} busy={busy} run={run} />) : <div className="emptyState">No extracted material is waiting for review.</div>}</div>
    </section>

    <section className="onboardingSplit"><div className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 4</div><h2>Employment history</h2><p>Add exact history if the CV parser needs help.</p></div></div><form className="onboardingForm" onSubmit={(event) => postForm(event, "/api/onboarding/history", (form) => ({ kind: "employment", employer: form.get("employer"), roleTitle: form.get("roleTitle"), location: form.get("location"), startDate: form.get("startDate"), endDate: form.get("endDate"), current: form.get("current") === "on", details: form.get("details") }))}><label><span>Employer</span><input name="employer" required /></label><label><span>Role title</span><input name="roleTitle" required /></label><div className="formGrid two"><label><span>Start</span><input type="date" name="startDate" /></label><label><span>End</span><input type="date" name="endDate" /></label></div><label className="checkLabel"><input type="checkbox" name="current" /> Current role</label><label><span>Details</span><textarea name="details" rows={3} /></label><button className="primaryButton" disabled={busy}>Add employment</button></form><div className="compactList">{(data?.employment || []).map((item: any) => <div key={item.id}><strong>{item.role_title}</strong><span>{item.employer}</span><button onClick={() => run(() => api(`/api/onboarding/history?id=${item.id}&kind=employment`, { method: "DELETE" }))}>Remove</button></div>)}</div></div>
      <div className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 5</div><h2>Education</h2><p>Add qualifications and study history.</p></div></div><form className="onboardingForm" onSubmit={(event) => postForm(event, "/api/onboarding/history", (form) => ({ kind: "education", institution: form.get("institution"), qualification: form.get("qualification"), fieldOfStudy: form.get("fieldOfStudy"), startDate: form.get("startDate"), endDate: form.get("endDate"), current: form.get("current") === "on", details: form.get("details") }))}><label><span>Institution</span><input name="institution" required /></label><label><span>Qualification</span><input name="qualification" required /></label><label><span>Field of study</span><input name="fieldOfStudy" /></label><div className="formGrid two"><label><span>Start</span><input type="date" name="startDate" /></label><label><span>End</span><input type="date" name="endDate" /></label></div><label className="checkLabel"><input type="checkbox" name="current" /> Current study</label><label><span>Details</span><textarea name="details" rows={3} /></label><button className="primaryButton" disabled={busy}>Add education</button></form><div className="compactList">{(data?.education || []).map((item: any) => <div key={item.id}><strong>{item.qualification}</strong><span>{item.institution}</span><button onClick={() => run(() => api(`/api/onboarding/history?id=${item.id}&kind=education`, { method: "DELETE" }))}>Remove</button></div>)}</div></div></section>

    <section className="onboardingSplit"><div className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 6</div><h2>Skills and tools</h2><p>Only add tools you have actually used.</p></div></div><form className="onboardingForm compactForm" onSubmit={(event) => postForm(event, "/api/onboarding/skills", (form) => ({ name: form.get("name"), category: form.get("category"), proficiency: form.get("proficiency") }))}><label><span>Skill / tool</span><input name="name" required /></label><label><span>Category</span><select name="category"><option value="skill">Skill</option><option value="programming">Programming</option><option value="software">Software / tool</option><option value="domain">Domain knowledge</option></select></label><label><span>Proficiency</span><input name="proficiency" placeholder="Optional" /></label><button className="primaryButton" disabled={busy}>Add skill</button></form><div className="tagList">{(data?.skills || []).map((item: any) => <span key={item.id}>{item.name}<button aria-label={`Remove ${item.name}`} onClick={() => run(() => api(`/api/onboarding/skills?id=${item.id}`, { method: "DELETE" }))}>×</button></span>)}</div></div>
      <div className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 7</div><h2>CV strategy</h2><p>Choose relevant families. Motorsport is always opt-in.</p></div></div><div className="cvFamilyList">{(data?.cvFamilies || []).map((item: any) => <label key={item.id}><input type="checkbox" checked={item.enabled} onChange={(event) => run(() => api("/api/onboarding/cv-families", { method: "POST", body: JSON.stringify({ id: item.id, enabled: event.target.checked, isDefault: item.is_default }) }))} /><span><strong>{item.label}</strong><small>{item.is_default ? "Default family" : item.family_key}</small></span><button className="secondaryButton" disabled={!item.enabled || item.is_default} onClick={(event) => { event.preventDefault(); void run(() => api("/api/onboarding/cv-families", { method: "POST", body: JSON.stringify({ id: item.id, enabled: true, isDefault: true }) })); }}>Make default</button></label>)}</div></div></section>

    <section className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 8</div><h2>Job-search preferences</h2><p>These are direct user choices. They control search and preparation thresholds, not factual eligibility.</p></div></div><form className="onboardingForm" onSubmit={(event) => postForm(event, "/api/onboarding/preferences", (form) => ({ locations: splitCsv(String(form.get("locations") || "")), targetRoles: splitCsv(String(form.get("targetRoles") || "")), roleFamilies: splitCsv(String(form.get("roleFamilies") || "")), targetSeniority: form.get("targetSeniority"), preferredIndustries: splitCsv(String(form.get("preferredIndustries") || "")), excludedIndustries: splitCsv(String(form.get("excludedIndustries") || "")), workModes: form.getAll("workModes"), maxCommuteMinutes: form.get("maxCommuteMinutes"), salaryMinimum: form.get("salaryMinimum"), salaryTarget: form.get("salaryTarget"), sponsorshipRequired: form.get("sponsorshipRequired") === "on", postingAgeDays: form.get("postingAgeDays"), minFitThreshold: form.get("minFitThreshold"), autoPrepareThreshold: form.get("autoPrepareThreshold"), searchCadence: form.get("searchCadence"), applicationAutomationPreference: form.get("applicationAutomationPreference"), notes: form.get("notes") }))}>
        <div className="formGrid two"><label><span>Target roles</span><input name="targetRoles" required defaultValue={(data?.preferences?.target_roles || []).join(", ")} placeholder="Research Engineer, Scientific Software Engineer" /></label><label><span>Role families</span><input name="roleFamilies" required defaultValue={(data?.preferences?.role_families || []).join(", ")} placeholder="Simulation / CAE, Scientific Software" /></label><label><span>Target seniority</span><input name="targetSeniority" required defaultValue={data?.preferences?.target_seniority || ""} placeholder="Graduate, junior, mid-level" /></label><label><span>Locations</span><input name="locations" required defaultValue={(data?.preferences?.locations || []).join(", ")} /></label><label><span>Preferred industries</span><input name="preferredIndustries" defaultValue={(data?.preferences?.preferred_industries || []).join(", ")} /></label><label><span>Excluded industries</span><input name="excludedIndustries" defaultValue={(data?.preferences?.excluded_industries || []).join(", ")} /></label></div>
        <div className="checkRow"><label><input type="checkbox" name="workModes" value="onsite" defaultChecked={(data?.preferences?.work_modes || []).includes("onsite")} /> On-site</label><label><input type="checkbox" name="workModes" value="hybrid" defaultChecked={(data?.preferences?.work_modes || []).includes("hybrid")} /> Hybrid</label><label><input type="checkbox" name="workModes" value="remote" defaultChecked={(data?.preferences?.work_modes || []).includes("remote")} /> Remote</label></div>
        <div className="formGrid two"><label><span>Maximum commute (minutes)</span><input type="number" min="0" name="maxCommuteMinutes" defaultValue={data?.preferences?.max_commute_minutes ?? ""} /></label><label><span>Posting age limit (days)</span><input type="number" min="1" max="90" name="postingAgeDays" defaultValue={data?.preferences?.posting_age_policy?.max_days || 30} /></label><label><span>Salary floor (£)</span><input type="number" min="0" name="salaryMinimum" defaultValue={data?.preferences?.salary?.minimum ?? ""} /></label><label><span>Salary target (£)</span><input type="number" min="0" name="salaryTarget" defaultValue={data?.preferences?.salary?.target ?? ""} /></label><label><span>Minimum fit threshold</span><input type="number" min="0" max="100" name="minFitThreshold" defaultValue={data?.preferences?.min_fit_threshold ?? 60} /></label><label><span>Auto-prepare threshold</span><input type="number" min="0" max="100" name="autoPrepareThreshold" defaultValue={data?.preferences?.auto_prepare_threshold ?? 80} /></label></div>
        <label className="checkLabel"><input type="checkbox" name="sponsorshipRequired" defaultChecked={Boolean(data?.preferences?.sponsorship_required)} /> I require sponsorship</label><div className="formGrid two"><label><span>Search cadence</span><select name="searchCadence" defaultValue={data?.preferences?.search_cadence || "daily"}><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="manual">Manual</option></select></label><label><span>Application automation</span><select name="applicationAutomationPreference" defaultValue={data?.preferences?.application_automation_preference || "prepare_and_fill_after_gate1"}><option value="prepare_and_fill_after_gate1">Prepare and fill after Gate 1</option><option value="prepare_only">Prepare packages only</option><option value="manual">Manual handling</option></select></label></div><label><span>Other preferences</span><textarea name="notes" rows={3} defaultValue={data?.preferences?.notes || ""} /></label><button className="primaryButton" disabled={busy}>Save job-search strategy</button>
      </form></section>

    <section className="onboardingSplit"><div className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 9</div><h2>Connect services</h2><p>These connections are per-user and can be revoked later.</p></div></div><div className="activationConnections"><Connection label="Gmail read-only" ready={readiness.gmail_connected} href="/login?next=/onboarding" action="Connect / reconnect Google" detail="Used only for read-only recruiting and application email monitoring." /><Connection label="ChatGPT reasoning worker" ready={readiness.chatgpt_connected} href="/chatgpt" action="Connect ChatGPT" detail="OAuth-scoped MCP access to this user's work queue; no approval or submission tools." /><Connection label="Browser helper" ready={readiness.browser_helper_paired} href="/settings#browser-helper" action="Pair browser helper" detail="One-time local companion for approved employer forms; it pauses at authentication and final review." /></div></div>
      <div className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Step 10</div><h2>Reusable answers</h2><p>Only exact answers you provide become reusable. Sensitive answers remain marked.</p></div></div><form className="onboardingForm" onSubmit={(event) => postForm(event, "/api/onboarding/answers", (form) => ({ answerKey: form.get("answerKey"), value: form.get("value"), sensitive: form.get("sensitive") === "on" }))}><label><span>Answer label</span><input name="answerKey" placeholder="e.g. notice period" required /></label><label><span>Exact reusable answer</span><textarea name="value" rows={4} required /></label><label className="checkLabel"><input type="checkbox" name="sensitive" /> Sensitive</label><button className="primaryButton" disabled={busy}>Save reusable answer</button></form><div className="compactList">{(data?.answers || []).map((item: any) => <div key={item.id}><strong>{item.answer_key.replaceAll("_", " ")}</strong><span>{item.sensitive ? "Sensitive · " : ""}{item.value_text}</span></div>)}</div></div></section>

    <section className="card onboardingComplete"><div><div className="eyebrow">Final step</div><h2>{readiness.ready ? "Automation-ready" : "Finish the checklist"}</h2><p>{readiness.ready ? "Job Hunt Console can now search, reason and prepare work for this account. Human gates remain in force." : "Complete the missing items above. The database will not mark this account ready while extracted material is unreviewed or required connections are absent."}</p><div className="readinessChecks compactChecks">{checkItems.map(([label, done]) => <span className={done ? "done" : ""} key={`final-${label}`}>{label}</span>)}</div></div><button className="primaryButton" disabled={busy || !readiness.ready} onClick={() => run(() => api("/api/onboarding/complete", { method: "POST", body: "{}" }))}>{readiness.status === "ready" ? "Activation complete" : "Mark activation complete"}</button></section>
  </div>;
}

function Connection({ label, ready, href, action, detail }: { label: string; ready: boolean; href: string; action: string; detail: string }) {
  return <div className="activationConnection"><div><strong>{label}</strong><p>{detail}</p></div><div className="connectionAction"><span className={`badge ${ready ? "review" : "action"}`}>{ready ? "Connected" : "Not connected"}</span>{!ready ? <a className="secondaryButton" href={href}>{action}</a> : <a className="textLink" href={href}>Manage</a>}</div></div>;
}

function ReviewProposal({ item, busy, run }: { item: any; busy: boolean; run: (operation: () => Promise<any>) => Promise<void> }) {
  const proposalClaim = item.kind === "proposal" ? item.proposed_json?.claim : item.kind === "fact" ? valueText(item.value_json) : item.claim;
  const [value, setValue] = useState(proposalClaim || "");
  const label = item.kind === "fact" ? item.fact_key : item.kind === "proposal" ? `CV ${item.proposal_type}` : item.category;
  const source = item.kind === "proposal" ? item.source_locator : item.source_note || item.evidence_sources?.source_key || item.source_locator;
  return <div className="reviewProposal"><div><span>{label}</span><textarea value={value} onChange={(event) => setValue(event.target.value)} rows={2} /><small>{source || "Imported source"}</small></div><div className="buttonRow"><button className="secondaryButton" disabled={busy} onClick={() => run(() => api("/api/onboarding/review", { method: "POST", body: JSON.stringify({ kind: item.kind, id: item.id, status: "rejected" }) }))}>Reject</button><button className="primaryButton" disabled={busy} onClick={() => run(() => api("/api/onboarding/review", { method: "POST", body: JSON.stringify({ kind: item.kind, id: item.id, status: "verified", ...(item.kind === "fact" ? { value } : { claim: value }) }) }))}>Verify</button></div></div>;
}
