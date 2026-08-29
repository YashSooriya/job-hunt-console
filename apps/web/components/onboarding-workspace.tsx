"use client";

import { FormEvent, SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatGptMemorySetup } from "@/components/chatgpt-memory-setup";
import { notifyBridgeHints } from "@/lib/chatgpt-bridge/notify";
import { sortReverseChronological } from "@/lib/onboarding/record-order";
import { formatProfileValue } from "@/lib/onboarding/value-format";

type State = any;
type SourceFileRow = { id: number; file: File | null };
type Run = (operation: () => Promise<any>) => Promise<boolean>;

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

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function factRecord(data: State | null, key: string) {
  const aliases = key === "linkedin_url" ? ["linkedin_url", "linkedin"] : key === "portfolio_links" ? ["portfolio_links", "portfolio"] : [key];
  return (data?.facts || []).find((item: any) => aliases.includes(item.fact_key));
}

function factValue(data: State | null, key: string) {
  return factRecord(data, key)?.value_json || "";
}

function factInputValue(data: State | null, key: string) {
  return formatProfileValue(factValue(data, key), key);
}

function fieldClass(value: unknown) {
  return hasValue(value) ? "profileField" : "profileField needsUserInput";
}

function recordFieldClass(value: unknown) {
  return hasValue(value) ? "recordField" : "recordField needsUserInput";
}

function useAutoOpenOnImportedRecords(recordCount: number) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(recordCount > 0);
  }, [recordCount]);
  return {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open),
  };
}

function preferenceValue(data: State | null, key: string) {
  const preferences = data?.preferences || {};
  if (key === "salary_minimum") return preferences.salary?.minimum ?? preferences.salary_minimum ?? "";
  if (key === "salary_target") return preferences.salary?.target ?? preferences.salary_target ?? "";
  if (key === "salary_currency") return preferences.salary?.currency ?? preferences.salary_currency ?? "";
  if (key === "posting_age_days") return preferences.posting_age_policy?.max_days ?? preferences.posting_age_days ?? "";
  if (key === "min_fit_score_10") return preferences.min_fit_score_10 ?? (preferences.min_fit_threshold ? Number(preferences.min_fit_threshold) / 10 : "");
  return preferences[key] ?? "";
}

function preferenceFieldClass(data: State | null, key: string) {
  return fieldClass(preferenceValue(data, key));
}

const PERSONAL_FACT_KEYS = [
  "first_name", "surname", "date_of_birth", "email", "phone", "location", "citizenship",
  "work_authorisation", "right_to_work_countries", "visa_status", "visa_expiry",
  "sponsorship_requirement", "notice_period", "current_salary", "salary_currency",
  "salary_expectation", "availability_date", "languages", "portfolio_links", "linkedin_url",
  "certifications",
];

function personalFormKey(data: State | null) {
  if (!data) return "profile-loading";
  const facts = (data.facts || [])
    .filter((item: any) => PERSONAL_FACT_KEYS.includes(item.fact_key))
    .map((item: any) => `${item.fact_key}:${item.updated_at || ""}:${JSON.stringify(item.value_json)}`)
    .join("|");
  return `profile-loaded:${data.profile?.updated_at || ""}:${facts}`;
}

async function submitForm(
  event: FormEvent<HTMLFormElement>,
  url: string,
  transform: (form: FormData) => Record<string, unknown>,
  run: Run,
) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  if (await run(() => api(url, { method: "POST", body: JSON.stringify(transform(form)) }))) {
    formElement.reset();
    return true;
  }
  return false;
}

export function OnboardingWorkspace() {
  const [data, setData] = useState<State | null>(null);
  const [memory, setMemory] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sourceFileRows, setSourceFileRows] = useState<SourceFileRow[]>([{ id: 1, file: null }]);
  const [profileText, setProfileText] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [searchMode, setSearchMode] = useState("keywords_and_profile");
  const [backgroundMessage, setBackgroundMessage] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [memoryUpdateMessage, setMemoryUpdateMessage] = useState<string | null>(null);
  const [activationMessage, setActivationMessage] = useState<string | null>(null);
  const [resetStage, setResetStage] = useState<"closed" | "warning" | "confirm">("closed");
  const [resetPhrase, setResetPhrase] = useState("");
  const [memorySetupKey, setMemorySetupKey] = useState(0);
  const sourceFiles = useMemo(() => sourceFileRows.flatMap((row) => row.file ? [row.file] : []), [sourceFileRows]);
  const savedLinkedinUrl = factInputValue(data, "linkedin_url");
  const savedSourceDocuments = data?.sourceDocuments || [];
  const hasUnsavedSourceChanges = sourceFiles.length > 0
    || Boolean(profileText.trim())
    || linkedinUrl.trim() !== String(savedLinkedinUrl || "").trim();

  const load = useCallback(async () => {
    setError(null);
    setData(await api("/api/onboarding/state", { cache: "no-store" }));
  }, []);

  useEffect(() => {
    load().catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load onboarding."));
  }, [load]);

  useEffect(() => {
    const value = factValue(data, "linkedin_url");
    setLinkedinUrl(hasValue(value) ? formatProfileValue(value, "linkedin_url") : "");
    setSearchMode(typeof data?.preferences?.search_mode === "string" ? data.preferences.search_mode : "keywords_and_profile");
  }, [data]);

  const readiness = data?.readiness || {};

  async function run(operation: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function completeActivation() {
    setActivationMessage("Checking your profile and queueing the verified information for ChatGPT…");
    const completed = await run(async () => {
      const result = await api("/api/onboarding/complete", { method: "POST", body: "{}" });
      notifyBridgeHints(result.bridge_hints || result.bridge_hint);
      const dispatchId = typeof result.dispatch?.id === "string" ? result.dispatch.id : null;
      const dispatchCount = Array.isArray(result.dispatches) ? result.dispatches.length : (dispatchId ? 1 : 0);
      setActivationMessage(dispatchId
        ? `Activation is complete. ${dispatchCount} ordered verified-profile Memory message${dispatchCount === 1 ? "" : "s"} ${dispatchCount === 1 ? "is" : "are"} queued for ChatGPT through the Website Bridge (${dispatchId}).`
        : "Activation is complete. The verified profile was recorded, but no Website Bridge request was returned.");
    });
    if (!completed) setActivationMessage(null);
  }

  async function savePersonalDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(() => api("/api/onboarding/profile", {
      method: "POST",
      body: JSON.stringify({
        displayName: form.get("displayName"),
        firstName: form.get("firstName"),
        surname: form.get("surname"),
        dateOfBirth: form.get("dateOfBirth"),
        email: form.get("email"),
        phone: form.get("phone"),
        location: form.get("location"),
        citizenship: form.get("citizenship"),
        workAuthorisation: form.get("workAuthorisation"),
        rightToWorkCountries: form.get("rightToWorkCountries"),
        visaStatus: form.get("visaStatus"),
        visaExpiry: form.get("visaExpiry"),
        sponsorshipRequirement: form.get("sponsorshipRequirement"),
        noticePeriod: form.get("noticePeriod"),
        currentSalary: form.get("currentSalary"),
        salaryCurrency: form.get("salaryCurrency"),
        salaryExpectation: form.get("salaryExpectation"),
        availabilityDate: form.get("availabilityDate"),
        languages: form.get("languages"),
        portfolioLinks: form.get("portfolioLinks"),
        linkedinUrl: form.get("linkedinUrl"),
        certifications: form.get("certifications"),
      }),
    }));
  }

  async function sendProfessionalBackground(sourceDocumentIds: string[] = [], refreshOnly = false) {
    const result = await api("/api/onboarding/professional-background", {
      method: "POST",
      body: JSON.stringify({ linkedinUrl, sourceDocumentIds, refreshOnly }),
    });
    notifyBridgeHints(result.bridge_hints || result.bridge_hint);
    const dispatchCount = Array.isArray(result.dispatches) ? result.dispatches.length : 1;
    const sourceCount = Number(result.sourceCount || 0);
    setBackgroundMessage(result.profileImportQueued
      ? `${sourceCount} source${sourceCount === 1 ? "" : "s"} saved. Website Bridge message${dispatchCount === 1 ? "" : "s"} will give ChatGPT the CV${sourceCount === 1 ? "" : "s"}, LinkedIn and additional information, update its Memory, then create the JSON used to fill this page (${dispatchCount} queued).`
      : sourceCount > 0
        ? `${sourceCount} source${sourceCount === 1 ? "" : "s"} saved. Continue to the Memory choice below to send the complete source bundle to ChatGPT and create the structured profile. No ChatGPT message was sent yet.`
        : "No sources were queued. Add a CV, LinkedIn URL or additional information, then allow ChatGPT Memory before building the profile.");
  }

  async function submitBackgroundSources(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceFiles.length && !profileText.trim() && !linkedinUrl.trim()) {
      setError("Choose at least one source file, enter a description, or add your LinkedIn profile URL.");
      return;
    }
    await run(async () => {
      const sourceDocumentIds: string[] = [];
      for (const file of sourceFiles) {
        const form = new FormData();
        form.set("file", file);
        form.set("sourceType", "cv_upload");
        form.set("title", file.name);
        const result = await api("/api/onboarding/import-cv", { method: "POST", body: form });
        if (typeof result.documentId === "string") sourceDocumentIds.push(result.documentId);
      }
      if (profileText.trim()) {
        const form = new FormData();
        form.set("text", profileText);
        form.set("sourceType", "user_description");
        form.set("title", "Additional background");
        const result = await api("/api/onboarding/import-cv", { method: "POST", body: form });
        if (typeof result.documentId === "string") sourceDocumentIds.push(result.documentId);
      }
      await sendProfessionalBackground(sourceDocumentIds);
      setSourceFileRows([{ id: Date.now(), file: null }]);
      setProfileText("");
    });
  }

  async function resetOnboardingData() {
    await run(async () => {
      await api("/api/onboarding/reset", { method: "POST", body: JSON.stringify({ confirmation: "RESET ONBOARDING DATA" }) });
      setResetStage("closed");
      setResetPhrase("");
      setSourceFileRows([{ id: Date.now(), file: null }]);
      setProfileText("");
      setBackgroundMessage(null);
      setImportMessage("Onboarding data was cleared. Your account, jobs, applications, ChatGPT Project and bridge pairing were kept.");
      setMemoryUpdateMessage(null);
      setMemorySetupKey((current) => current + 1);
    });
  }

  function updateSourceFile(index: number, file: File | null) {
    setSourceFileRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, file } : row));
  }

  function addSourceFileRow() {
    setSourceFileRows((rows) => [...rows, { id: Date.now() + rows.length, file: null }]);
  }

  function removeSourceFileRow(index: number) {
    setSourceFileRows((rows) => rows.length === 1
      ? rows.map((row, rowIndex) => rowIndex === index ? { ...row, file: null } : row)
      : rows.filter((_, rowIndex) => rowIndex !== index));
  }

  async function removeStoredSource(documentId: string, title: string) {
    if (typeof window !== "undefined" && !window.confirm(`Remove “${title}” from this onboarding profile? Its private stored file and any imported records derived from it will be deleted.`)) return;
    await run(async () => {
      const result = await api(`/api/onboarding/import-cv?id=${encodeURIComponent(documentId)}`, { method: "DELETE" });
      setBackgroundMessage(`${result.title || title} was removed from the saved source bundle. It will no longer be staged for ChatGPT.`);
    });
  }

  const checkItems = [
    ["Profile has core details", Boolean(readiness.profile_complete)],
    ["Job preferences complete", Boolean(readiness.preferences_complete)],
    ["Imported information reviewed", Number(readiness.pending_review || 0) === 0],
    ["Ready to activate", Boolean(readiness.ready)],
  ] as const;

  return <div className="onboardingWorkspace">
    <section className="onboardingFlowOverview" aria-label="Profile setup order">
      <div className="onboardingFlowIntro"><div className="eyebrow">Setup order</div><h2>Add your sources first</h2><p>Start by adding all of your CVs, LinkedIn and extra information. After you choose whether to use ChatGPT Memory, one Website Bridge request gives ChatGPT the complete source bundle, asks it to update Memory, and then creates one <code>professional-profile.json</code> file containing the onboarding fields for your review.</p></div>
      <ol className="onboardingFlowSteps">
        <li><span>1</span><div><strong>Add your sources</strong><small>Upload CVs, LinkedIn and extra information.</small></div></li>
        <li><span>2</span><div><strong>Choose Memory</strong><small>Allow ChatGPT to use remembered background.</small></div></li>
        <li><span>3</span><div><strong>Update Memory and create JSON</strong><small>ChatGPT does both in one request.</small></div></li>
        <li><span>4</span><div><strong>Confirm additions</strong><small>Send only your new or corrected details back to Memory.</small></div></li>
      </ol>
    </section>
    {error ? <div className="errorNotice">{error}</div> : null}

    <section id="profile-sources" className="card onboardingCard">
      <div className="cardHeader"><div><div className="eyebrow">Step 1 · Your source information</div><h2>CVs and other information</h2><p>Add all of your CVs, LinkedIn and anything else that will help build your profile. These sources are saved together first. After you choose to use ChatGPT Memory below, one Website Bridge request sends the complete bundle to ChatGPT, updates its Memory, and creates the structured JSON used to fill the fields.</p></div></div>
      <form className="onboardingForm" onSubmit={(event) => void submitBackgroundSources(event)}>
        <div className="sourceFileList">{sourceFileRows.map((row, index) => <div className="sourceFileRow" key={row.id}>
          <label><span>{index === 0 ? "CV or document" : "Another CV or document"}</span><input type="file" accept=".pdf,.docx,.txt,.md,.markdown,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/rtf" onChange={(event) => updateSourceFile(index, event.target.files?.[0] || null)} /></label>
          {(sourceFileRows.length > 1 || row.file) ? <button type="button" className="textButton" onClick={() => removeSourceFileRow(index)}>{row.file ? "Clear" : "Remove"}</button> : null}
        </div>)}</div>
        <button type="button" className="secondaryButton addSourceButton" onClick={addSourceFileRow}>+ Add another document</button>
        <label className={fieldClass(linkedinUrl)}><span>LinkedIn profile URL</span><input type="url" value={linkedinUrl} onChange={(event) => setLinkedinUrl(event.target.value)} placeholder="https://www.linkedin.com/in/your-name" /></label>
        <label><span>Additional information</span><textarea value={profileText} onChange={(event) => setProfileText(event.target.value)} rows={7} placeholder="Add experience, achievements, projects, skills, constraints or anything your documents do not capture." /></label>
        <div className="buttonRow"><button className="primaryButton" disabled={busy || (!sourceFiles.length && !profileText.trim() && !linkedinUrl.trim())}>{busy ? "Saving…" : memory?.confirmed ? "Save sources and build profile" : "Save sources and continue"}</button><span className="muted">{sourceFiles.length ? `${sourceFiles.length} document${sourceFiles.length === 1 ? "" : "s"} selected` : "No documents selected"}</span></div>
        {backgroundMessage ? <div className="notice">{backgroundMessage}</div> : null}
      </form>
      <div className="compactList">{savedSourceDocuments.map((item: any) => <div key={item.id}><strong>{item.original_name}</strong><span>{item.source_type ? `${String(item.source_type).replaceAll("_", " ")} · ` : ""}{item.extraction_format || "document"} · {String(item.extraction_status).replaceAll("_", " ")}{item.extraction_error ? ` · ${item.extraction_error}` : ""}</span><button type="button" className="textButton" disabled={busy} onClick={() => void removeStoredSource(String(item.id), String(item.original_name || "this source"))}>Remove</button></div>)}</div>
      <div className="sourceBundleNote"><strong>Saved sources are staged, not sent yet.</strong><span>These saved documents and the saved LinkedIn URL are the exact bundle that will be sent when you choose ChatGPT Memory below. Nothing is sent to ChatGPT until that choice is made.</span></div>
    </section>

    <ChatGptMemorySetup key={memorySetupKey} sourceDocuments={savedSourceDocuments} savedLinkedinUrl={savedLinkedinUrl} linkedinUrl={linkedinUrl} additionalInformation={profileText} hasUnsavedSourceChanges={hasUnsavedSourceChanges} onProfileChanged={load} onMemoryChanged={setMemory} />

    <ImportedProfileStatus data={data} busy={busy} run={run} message={importMessage} onMessage={setImportMessage} />

    <section className="card onboardingProgress">
      <div className="cardHeader"><div><div className="eyebrow">Progress overview</div><h2>Profile status</h2><p>The editable fields below are the source of truth. Check imported values there and complete the empty fields highlighted for your attention.</p></div><strong>{readiness.score ?? 0}%</strong></div>
      <div className="readinessBar"><i style={{ width: `${readiness.score ?? 0}%` }} /></div>
      <div className="readinessChecks">{checkItems.map(([label, done]) => <span className={done ? "done" : ""} key={label}>{label}</span>)}</div>
    </section>

    <div className="onboardingSectionHeading"><span>4</span><div><strong>Review and complete your profile</strong><small>Check the imported values, open the record sections when needed, and fill the highlighted gaps.</small></div></div>

    <section id="onboarding-details" className="card onboardingCard">
      <div className="cardHeader"><div><div className="eyebrow">Step 4 · Personal details</div><h2>Your details</h2><p>These are common application fields. Check what ChatGPT imported, correct anything inaccurate, and fill the remaining highlighted fields.</p></div></div>
      <div className="profileFieldLegend"><span className="legendItem needsUserInput">Empty · add or confirm</span></div>
      <form key={personalFormKey(data)} className="onboardingForm two" onSubmit={(event) => void savePersonalDetails(event)}>
        <label className={fieldClass(data?.profile?.display_name)}><span>Display name</span><input name="displayName" required defaultValue={data?.profile?.display_name || ""} /></label>
        <label className={fieldClass(factValue(data, "first_name"))}><span>First name</span><input name="firstName" defaultValue={factInputValue(data, "first_name")} /></label>
        <label className={fieldClass(factValue(data, "surname"))}><span>Surname</span><input name="surname" defaultValue={factInputValue(data, "surname")} /></label>
        <label className={fieldClass(factValue(data, "date_of_birth"))}><span>Date of birth</span><input name="dateOfBirth" type="date" defaultValue={factInputValue(data, "date_of_birth")} /></label>
        <label className={fieldClass(factValue(data, "email"))}><span>Email</span><input name="email" type="email" defaultValue={factInputValue(data, "email")} /></label>
        <label className={fieldClass(factValue(data, "phone"))}><span>Phone</span><input name="phone" defaultValue={factInputValue(data, "phone")} /></label>
        <label className={fieldClass(factValue(data, "location"))}><span>Current location</span><input name="location" defaultValue={factInputValue(data, "location")} /></label>
        <label className={fieldClass(factValue(data, "citizenship"))}><span>Citizenship</span><input name="citizenship" placeholder="e.g. British" defaultValue={factInputValue(data, "citizenship")} /></label>
        <label className={fieldClass(factValue(data, "work_authorisation"))}><span>Legal right to work</span><input name="workAuthorisation" required placeholder="e.g. British citizen, settled status, visa" defaultValue={factInputValue(data, "work_authorisation")} /><small className="formHelp">Your legal permission to work; it is separate from citizenship.</small></label>
        <label className={fieldClass(factValue(data, "right_to_work_countries"))}><span>Countries where you can work</span><input name="rightToWorkCountries" placeholder="e.g. UK, Ireland" defaultValue={factInputValue(data, "right_to_work_countries")} /></label>
        <label className={fieldClass(factValue(data, "visa_status"))}><span>Visa or immigration status</span><input name="visaStatus" placeholder="e.g. Settled status, Skilled Worker visa, not applicable" defaultValue={factInputValue(data, "visa_status")} /></label>
        <label className={fieldClass(factValue(data, "visa_expiry"))}><span>Visa expiry</span><input name="visaExpiry" type="date" defaultValue={factInputValue(data, "visa_expiry")} /></label>
        <label className={fieldClass(factValue(data, "sponsorship_requirement"))}><span>Sponsorship requirement</span><select name="sponsorshipRequirement" defaultValue={factInputValue(data, "sponsorship_requirement")}><option value="">Select an answer</option><option value="no">I do not need sponsorship</option><option value="yes">I need sponsorship</option><option value="unsure">Not sure</option></select></label>
        <label className={fieldClass(factValue(data, "notice_period"))}><span>Notice period</span><input name="noticePeriod" placeholder="e.g. 1 month" defaultValue={factInputValue(data, "notice_period")} /></label>
        <label className={fieldClass(factValue(data, "current_salary"))}><span>Current salary</span><input name="currentSalary" inputMode="decimal" placeholder="Amount or not applicable" defaultValue={factInputValue(data, "current_salary")} /></label>
        <label className={fieldClass(factValue(data, "salary_currency"))}><span>Current salary currency</span><input name="salaryCurrency" placeholder="e.g. GBP" defaultValue={factInputValue(data, "salary_currency")} /></label>
        <label className={fieldClass(factValue(data, "salary_expectation"))}><span>Salary expectation</span><input name="salaryExpectation" placeholder="Amount or range" defaultValue={factInputValue(data, "salary_expectation")} /></label>
        <label className={fieldClass(factValue(data, "availability_date"))}><span>Earliest availability</span><input name="availabilityDate" placeholder="e.g. 1 September 2026" defaultValue={factInputValue(data, "availability_date")} /></label>
        <label className={fieldClass(factValue(data, "languages"))}><span>Languages</span><input name="languages" placeholder="e.g. English, French" defaultValue={factInputValue(data, "languages")} /></label>
        <label className={fieldClass(factValue(data, "portfolio_links"))}><span>Portfolio links</span><input name="portfolioLinks" placeholder="Separate links with commas" defaultValue={factInputValue(data, "portfolio_links")} /></label>
        <label className={fieldClass(factValue(data, "linkedin_url"))}><span>LinkedIn profile URL</span><input name="linkedinUrl" type="url" placeholder="https://www.linkedin.com/in/your-name" defaultValue={factInputValue(data, "linkedin_url")} /></label>
        <label className={fieldClass(factValue(data, "certifications"))}><span>Certifications and professional credentials</span><input name="certifications" placeholder="e.g. AWS Certified..., PRINCE2..." defaultValue={factInputValue(data, "certifications")} /></label>
        <div className="formActions"><button className="primaryButton" disabled={busy}>Save personal details</button></div>
      </form>
    </section>

    <HistorySection data={data} busy={busy} run={run} />
    <SkillsSection data={data} busy={busy} run={run} />
    <ProjectsSection data={data} busy={busy} run={run} />

    <MemoryUpdateCard memory={memory} busy={busy} run={run} message={memoryUpdateMessage} onMessage={setMemoryUpdateMessage} />

    <JobSearchPreferences key={`preferences:${JSON.stringify(data?.preferences || {})}`} data={data} searchMode={searchMode} setSearchMode={setSearchMode} busy={busy} onSave={(event) => void submitForm(event, "/api/onboarding/preferences", (form) => ({
      searchMode: form.get("searchMode"),
      locations: splitCsv(String(form.get("locations") || "")),
      targetRoles: splitCsv(String(form.get("targetRoles") || "")),
      roleFamilies: splitCsv(String(form.get("roleFamilies") || "")),
      targetSeniority: form.get("targetSeniority"),
      preferredIndustries: splitCsv(String(form.get("preferredIndustries") || "")),
      excludedIndustries: splitCsv(String(form.get("excludedIndustries") || "")),
      workModes: form.getAll("workModes"),
      maxCommuteMinutes: form.get("maxCommuteMinutes"),
      salaryMinimum: form.get("salaryMinimum"),
      salaryTarget: form.get("salaryTarget"),
      salaryCurrency: form.get("salaryCurrency"),
      sponsorshipRequired: form.get("sponsorshipRequired") === "on",
      postingAgeDays: form.get("postingAgeDays"),
      minFitScore10: form.get("minFitScore10"),
      autoPrepareThreshold: form.get("autoPrepareThreshold"),
      searchCadence: form.get("searchCadence"),
      applicationAutomationPreference: form.get("applicationAutomationPreference"),
      notes: form.get("notes"),
    }), run)} />

    <section className="card onboardingCard onboardingResetCard"><div className="cardHeader"><div><h2>Reset onboarding</h2><p>Start again with an empty profile. This removes information entered or imported on this page, including uploaded CVs, history, skills, preferences and Memory consent. Your account, jobs, applications, ChatGPT Project and bridge pairing remain.</p></div></div>{resetStage === "closed" ? <div className="onboardingResetBody"><button className="secondaryButton dangerButton" type="button" disabled={busy} onClick={() => setResetStage("warning")}>Reset all onboarding data</button></div> : resetStage === "warning" ? <div className="onboardingResetBody"><div className="resetWarning"><strong>This cannot be undone.</strong><p>Your onboarding profile, imported files and profile records will be deleted. Your wider account and ChatGPT connection will remain.</p></div><div className="buttonRow"><button className="secondaryButton" type="button" disabled={busy} onClick={() => setResetStage("closed")}>Cancel</button><button className="primaryButton" type="button" disabled={busy} onClick={() => setResetStage("confirm")}>Yes, continue</button></div></div> : <div className="onboardingResetBody"><div className="resetWarning"><strong>Final confirmation</strong><p>To delete the onboarding data, type <code>RESET ONBOARDING DATA</code> exactly below.</p></div><input aria-label="Reset confirmation" value={resetPhrase} onChange={(event) => setResetPhrase(event.target.value)} placeholder="RESET ONBOARDING DATA" autoComplete="off" /><div className="buttonRow"><button className="secondaryButton" type="button" disabled={busy} onClick={() => { setResetStage("closed"); setResetPhrase(""); }}>Cancel</button><button className="dangerButton" type="button" disabled={busy || resetPhrase !== "RESET ONBOARDING DATA"} onClick={() => void resetOnboardingData()}>{busy ? "Clearing…" : "Delete onboarding data"}</button></div></div>}</section>

    <section className="card onboardingComplete"><div><h2>{readiness.ready ? "Ready for automation" : "Complete your profile"}</h2><p>{readiness.ready ? "Your profile is ready for job searching and preparation. Human review remains required before applications are submitted." : "Complete the editable profile, review imported information and choose your job-search preferences. External connections are optional and do not block activation."}</p><div className="readinessChecks compactChecks">{checkItems.map(([label, done]) => <span className={done ? "done" : ""} key={`final-${label}`}>{label}</span>)}</div>{activationMessage ? <div className="notice" aria-live="polite">{activationMessage}</div> : null}</div><button className="primaryButton" disabled={busy || !readiness.ready || readiness.status === "ready"} onClick={() => void completeActivation()}>{busy ? "Activating…" : readiness.status === "ready" ? "Activation complete" : "Mark activation complete"}</button></section>
  </div>;
}

function ImportedProfileStatus({ data, busy, run, message, onMessage }: { data: State | null; busy: boolean; run: Run; message: string | null; onMessage: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const chatGptSource = (data?.sourceDocuments || []).find((item: any) => item.source_type === "chatgpt_memory");
  const structuredCount = (data?.employment?.length || 0) + (data?.education?.length || 0) + (data?.skills?.length || 0) + (data?.projects?.length || 0) + (data?.publications?.length || 0);
  const factCount = (data?.facts || []).filter((item: any) => String(item.source_note || "").startsWith("chatgpt_memory:")).length;

  async function reimportJson(event: FormEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await run(async () => {
      const form = new FormData();
      form.set("file", file);
      form.set("sourceType", "chatgpt_memory");
      form.set("title", file.name);
      form.set("replaceExisting", "true");
      const result = await api("/api/onboarding/import-cv", { method: "POST", body: form });
      onMessage(`Imported ${file.name} directly into the onboarding fields: ${Number(result.facts || 0)} personal value${Number(result.facts || 0) === 1 ? "" : "s"} and ${Number(result.structured || 0)} structured record${Number(result.structured || 0) === 1 ? "" : "s"}. No ChatGPT message was sent.`);
    });
  }

  return <section id="imported-profile" className="card onboardingCard importedProfileCard">
    <div className="cardHeader"><div><div className="eyebrow">Step 3 · Profile JSON</div><h2>Review imported information</h2><p>ChatGPT JSON is imported directly into the editable fields below. Review those fields and edit anything that is incomplete or inaccurate.</p></div><span className={`badge ${chatGptSource ? "review" : "muted"}`}>{chatGptSource ? "Imported" : "Not imported"}</span></div>
    <div className="importedProfileSummary"><span>{chatGptSource ? `${factCount} personal value${factCount === 1 ? "" : "s"} imported` : "No ChatGPT profile JSON has been imported yet."}</span><span>{chatGptSource ? `${structuredCount} profile record${structuredCount === 1 ? "" : "s"} available below` : "Use the Memory button above or reimport a JSON file here."}</span></div>
    <div className="buttonRow"><button className="secondaryButton" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>Reimport ChatGPT JSON</button><input ref={inputRef} className="visuallyHidden" type="file" accept=".json,application/json" onChange={(event) => void reimportJson(event)} /><a className="textLink" href="#onboarding-details">Review editable fields ↓</a></div>
    {message && message.includes("Imported ") ? <div className="notice" aria-live="polite">{message}</div> : null}
  </section>;
}

function HistorySection({ data, busy, run }: { data: State | null; busy: boolean; run: Run }) {
  const section = useAutoOpenOnImportedRecords((data?.employment || []).length + (data?.education || []).length);
  const [addingEmployment, setAddingEmployment] = useState(false);
  const [addingEducation, setAddingEducation] = useState(false);
  const employment = sortReverseChronological(data?.employment || [], "history");
  const education = sortReverseChronological(data?.education || [], "history");

  async function addEmployment(event: FormEvent<HTMLFormElement>) {
    if (await submitForm(event, "/api/onboarding/history", (form) => ({ kind: "employment", employer: form.get("employer"), roleTitle: form.get("roleTitle"), location: form.get("location"), startDate: form.get("startDate"), endDate: form.get("endDate"), current: form.get("current") === "on", details: form.get("details") }), run)) {
      setAddingEmployment(false);
    }
  }

  async function addEducation(event: FormEvent<HTMLFormElement>) {
    if (await submitForm(event, "/api/onboarding/history", (form) => ({ kind: "education", institution: form.get("institution"), qualification: form.get("qualification"), fieldOfStudy: form.get("fieldOfStudy"), location: form.get("location"), startDate: form.get("startDate"), endDate: form.get("endDate"), current: form.get("current") === "on", details: form.get("details") }), run)) {
      setAddingEducation(false);
    }
  }

  return <details className="onboardingDetails" open={section.open} onToggle={section.onToggle}><summary>Employment history and education <span>Open to review or edit</span></summary><section className="onboardingSplit">
    <div className="card onboardingCard"><div className="cardHeader"><div><h2>Employment history</h2><p>Check each imported role. Add responsibilities, achievements and key points where needed.</p></div></div>
      {employment.length ? <div className="buttonRow recordAddActions"><button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingEmployment((current) => !current)}>{addingEmployment ? "Cancel" : "+ Add employment"}</button></div> : null}
      {!employment.length || addingEmployment ? <form className="onboardingForm newRecordForm" onSubmit={(event) => void addEmployment(event)}><label><span>Employer</span><input name="employer" required /></label><label><span>Role title</span><input name="roleTitle" required /></label><div className="formGrid two"><label><span>Start</span><input type="date" name="startDate" /></label><label><span>End</span><input type="date" name="endDate" /></label></div><label className="checkLabel"><input type="checkbox" name="current" /> Current role</label><label><span>Responsibilities, achievements and key points</span><textarea name="details" rows={4} /></label><div className="buttonRow"><button className="primaryButton" disabled={busy}>Add employment</button>{employment.length ? <button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingEmployment(false)}>Cancel</button> : null}</div></form> : null}
      <div className="recordList">{employment.length ? employment.map((item: any) => <HistoryEditor key={`employment-${item.id}-${item.updated_at || ""}`} kind="employment" item={item} busy={busy} run={run} />) : <div className="emptyState">No employment records yet.</div>}</div>
    </div>
    <div className="card onboardingCard"><div className="cardHeader"><div><h2>Education</h2><p>Check qualifications, subjects, dates and supporting details.</p></div></div>
      {education.length ? <div className="buttonRow recordAddActions"><button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingEducation((current) => !current)}>{addingEducation ? "Cancel" : "+ Add education"}</button></div> : null}
      {!education.length || addingEducation ? <form className="onboardingForm newRecordForm" onSubmit={(event) => void addEducation(event)}><label><span>Institution</span><input name="institution" required /></label><label><span>Qualification</span><input name="qualification" required /></label><label><span>Field of study</span><input name="fieldOfStudy" /></label><label><span>Location</span><input name="location" /></label><div className="formGrid two"><label><span>Start</span><input type="date" name="startDate" /></label><label><span>End</span><input type="date" name="endDate" /></label></div><label className="checkLabel"><input type="checkbox" name="current" /> Current study</label><label><span>Details</span><textarea name="details" rows={4} /></label><div className="buttonRow"><button className="primaryButton" disabled={busy}>Add education</button>{education.length ? <button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingEducation(false)}>Cancel</button> : null}</div></form> : null}
      <div className="recordList">{education.length ? education.map((item: any) => <HistoryEditor key={`education-${item.id}-${item.updated_at || ""}`} kind="education" item={item} busy={busy} run={run} />) : <div className="emptyState">No education records yet.</div>}</div>
    </div>
  </section></details>;
}

function HistoryEditor({ kind, item, busy, run }: { kind: "employment" | "education"; item: any; busy: boolean; run: Run }) {
  const [fields, setFields] = useState({
    employer: item.employer || "", roleTitle: item.role_title || "", institution: item.institution || "", qualification: item.qualification || "", fieldOfStudy: item.field_of_study || "", location: item.location || "", startDate: item.start_date || "", endDate: item.end_date || "", current: Boolean(item.current), details: item.details || "",
  });
  const setField = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run(() => api("/api/onboarding/history", { method: "POST", body: JSON.stringify({ id: item.id, kind, ...fields }) }));
  };
  return <form className="recordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{kind === "employment" ? fields.roleTitle || "Employment record" : fields.qualification || "Education record"}</strong><small>{item.source_id ? "Imported from ChatGPT · check the fields" : "Saved in your profile"}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/history?id=${item.id}&kind=${kind}`, { method: "DELETE" }))}>Remove</button></div>
    {kind === "employment" ? <div className="formGrid two"><label className={recordFieldClass(fields.employer)}><span>Employer</span><input value={fields.employer} onChange={(event) => setField("employer", event.target.value)} required /></label><label className={recordFieldClass(fields.roleTitle)}><span>Role title</span><input value={fields.roleTitle} onChange={(event) => setField("roleTitle", event.target.value)} required /></label><label className={recordFieldClass(fields.location)}><span>Location</span><input value={fields.location} onChange={(event) => setField("location", event.target.value)} /></label><label className={recordFieldClass(fields.startDate)}><span>Start date</span><input type="date" value={fields.startDate} onChange={(event) => setField("startDate", event.target.value)} /></label><label className={recordFieldClass(fields.current ? "current" : fields.endDate)}><span>End date</span><input type="date" value={fields.endDate} disabled={fields.current} onChange={(event) => setField("endDate", event.target.value)} /></label><label className="checkLabel"><input type="checkbox" checked={fields.current} onChange={(event) => setField("current", event.target.checked)} /> Current role</label><label className={`fullWidth ${recordFieldClass(fields.details)}`}><span>Responsibilities, achievements and key points</span><textarea value={fields.details} rows={4} onChange={(event) => setField("details", event.target.value)} /></label></div> : <div className="formGrid two"><label className={recordFieldClass(fields.institution)}><span>Institution</span><input value={fields.institution} onChange={(event) => setField("institution", event.target.value)} required /></label><label className={recordFieldClass(fields.qualification)}><span>Qualification</span><input value={fields.qualification} onChange={(event) => setField("qualification", event.target.value)} required /></label><label className={recordFieldClass(fields.fieldOfStudy)}><span>Field of study</span><input value={fields.fieldOfStudy} onChange={(event) => setField("fieldOfStudy", event.target.value)} /></label><label className={recordFieldClass(fields.location)}><span>Location</span><input value={fields.location} onChange={(event) => setField("location", event.target.value)} /></label><label className={recordFieldClass(fields.startDate)}><span>Start date</span><input type="date" value={fields.startDate} onChange={(event) => setField("startDate", event.target.value)} /></label><label className={recordFieldClass(fields.current ? "current" : fields.endDate)}><span>End date</span><input type="date" value={fields.endDate} disabled={fields.current} onChange={(event) => setField("endDate", event.target.value)} /></label><label className="checkLabel"><input type="checkbox" checked={fields.current} onChange={(event) => setField("current", event.target.checked)} /> Current study</label><label className={`fullWidth ${recordFieldClass(fields.details)}`}><span>Details</span><textarea value={fields.details} rows={4} onChange={(event) => setField("details", event.target.value)} /></label></div>}
    <div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div>
  </form>;
}

function SkillsSection({ data, busy, run }: { data: State | null; busy: boolean; run: Run }) {
  const section = useAutoOpenOnImportedRecords((data?.skills || []).length);
  const skills = data?.skills || [];
  const [addingSkill, setAddingSkill] = useState(false);

  async function addSkill(event: FormEvent<HTMLFormElement>) {
    if (await submitForm(event, "/api/onboarding/skills", (form) => ({
      name: form.get("name"),
      category: form.get("category"),
      proficiency: form.get("proficiency"),
      yearsExperience: form.get("yearsExperience"),
    }), run)) {
      setAddingSkill(false);
    }
  }

  return <details className="onboardingDetails" open={section.open} onToggle={section.onToggle}><summary>Skills and tools <span>Open to review or edit</span></summary><section className="onboardingSingleRecordSection">
    <div className="card onboardingCard"><div className="cardHeader"><div><h2>Skills and tools</h2><p>Check each imported skill or tool. Add as many records as you need and edit or remove them individually.</p></div></div>
      {skills.length ? <div className="buttonRow recordAddActions"><button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingSkill((current) => !current)}>{addingSkill ? "Cancel" : "+ Add skill or tool"}</button></div> : null}
      {!skills.length || addingSkill ? <form className="onboardingForm compactForm newRecordForm" onSubmit={(event) => void addSkill(event)}><label><span>Skill / tool</span><input name="name" required /></label><label><span>Category</span><select name="category" defaultValue="skill"><option value="skill">Skill</option><option value="programming">Programming</option><option value="software">Software / tool</option><option value="domain">Domain knowledge</option></select></label><label><span>Proficiency</span><input name="proficiency" placeholder="e.g. expert, working knowledge" /></label><label><span>Years of experience</span><input type="number" min="0" max="80" step="0.5" name="yearsExperience" /></label><div className="buttonRow"><button className="primaryButton" disabled={busy}>Add skill or tool</button>{skills.length ? <button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingSkill(false)}>Cancel</button> : null}</div></form> : null}
      <div className="recordList">{skills.length ? skills.map((item: any) => <SkillEditor key={`skill-${item.id}-${item.updated_at || ""}`} item={item} busy={busy} run={run} />) : <div className="emptyState">No skills or tools yet.</div>}</div>
    </div>
  </section></details>;
}

function SkillEditor({ item, busy, run }: { item: any; busy: boolean; run: Run }) {
  const [fields, setFields] = useState({ name: item.name || "", category: item.category || "skill", proficiency: item.proficiency || "", yearsExperience: item.years_experience ?? "" });
  const setField = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); await run(() => api("/api/onboarding/skills", { method: "POST", body: JSON.stringify({ id: item.id, ...fields }) })); };
  return <form className="recordEditor compactRecordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{fields.name || "Skill or tool"}</strong><small>{item.source_id ? "Imported from ChatGPT · check the fields" : "Saved in your profile"}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/skills?id=${item.id}`, { method: "DELETE" }))}>Remove</button></div><div className="formGrid two"><label className={recordFieldClass(fields.name)}><span>Skill / tool</span><input value={fields.name} onChange={(event) => setField("name", event.target.value)} required /></label><label className={recordFieldClass(fields.category)}><span>Category</span><input value={fields.category} onChange={(event) => setField("category", event.target.value)} /></label><label className={recordFieldClass(fields.proficiency)}><span>Proficiency</span><input value={fields.proficiency} onChange={(event) => setField("proficiency", event.target.value)} /></label><label className={recordFieldClass(fields.yearsExperience)}><span>Years of experience</span><input type="number" min="0" max="80" step="0.5" value={fields.yearsExperience} onChange={(event) => setField("yearsExperience", event.target.value)} /></label></div><div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div></form>;
}

function ProjectsSection({ data, busy, run }: { data: State | null; busy: boolean; run: Run }) {
  const section = useAutoOpenOnImportedRecords((data?.projects || []).length + (data?.publications || []).length);
  const projects = sortReverseChronological(data?.projects || [], "project");
  const publications = sortReverseChronological(data?.publications || [], "publication");
  const [addingProject, setAddingProject] = useState(false);
  const [addingPublication, setAddingPublication] = useState(false);

  async function addProject(event: FormEvent<HTMLFormElement>) {
    if (await submitForm(event, "/api/onboarding/portfolio", (form) => ({
      kind: "project",
      title: form.get("title"),
      description: form.get("description"),
      technologies: splitCsv(String(form.get("technologies") || "")),
      startDate: form.get("startDate"),
      endDate: form.get("endDate"),
      url: form.get("url"),
    }), run)) {
      setAddingProject(false);
    }
  }

  async function addPublication(event: FormEvent<HTMLFormElement>) {
    if (await submitForm(event, "/api/onboarding/portfolio", (form) => ({
      kind: "publication",
      title: form.get("title"),
      publicationType: form.get("publicationType"),
      venue: form.get("venue"),
      publishedOn: form.get("publishedOn"),
      url: form.get("url"),
      citation: form.get("citation"),
    }), run)) {
      setAddingPublication(false);
    }
  }

  return <details className="onboardingDetails" open={section.open} onToggle={section.onToggle}><summary>Projects and publications <span>Open to review or edit</span></summary><section className="onboardingSplit">
    <div className="card onboardingCard"><div className="cardHeader"><div><h2>Projects</h2><p>Check project descriptions, dates, technologies and links. Records are shown newest first; undated records follow.</p></div></div>
      {projects.length ? <div className="buttonRow recordAddActions"><button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingProject((current) => !current)}>{addingProject ? "Cancel" : "+ Add project"}</button></div> : null}
      {!projects.length || addingProject ? <form className="onboardingForm newRecordForm" onSubmit={(event) => void addProject(event)}><label><span>Project title</span><input name="title" required /></label><label><span>Description</span><textarea name="description" rows={4} /></label><div className="formGrid two"><label><span>Start date</span><input type="date" name="startDate" /></label><label><span>End date</span><input type="date" name="endDate" /></label></div><label><span>Technologies</span><input name="technologies" placeholder="Separate with commas" /></label><label><span>URL</span><input name="url" type="url" /></label><div className="buttonRow"><button className="primaryButton" disabled={busy}>Add project</button>{projects.length ? <button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingProject(false)}>Cancel</button> : null}</div></form> : null}
      <div className="recordList">{projects.length ? projects.map((item: any) => <ProjectEditor key={`project-${item.id}-${item.updated_at || ""}`} item={item} busy={busy} run={run} />) : <div className="emptyState">No projects yet.</div>}</div>
    </div>
    <div className="card onboardingCard"><div className="cardHeader"><div><h2>Publications</h2><p>Check publication titles, dates, venues and citations. Records are shown newest first.</p></div></div>
      {publications.length ? <div className="buttonRow recordAddActions"><button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingPublication((current) => !current)}>{addingPublication ? "Cancel" : "+ Add publication"}</button></div> : null}
      {!publications.length || addingPublication ? <form className="onboardingForm newRecordForm" onSubmit={(event) => void addPublication(event)}><label><span>Title</span><input name="title" required /></label><label><span>Publication type</span><input name="publicationType" defaultValue="publication" /></label><label><span>Venue / publisher</span><input name="venue" /></label><label><span>Published date</span><input type="date" name="publishedOn" /></label><label><span>URL</span><input name="url" type="url" /></label><label><span>Citation</span><textarea name="citation" rows={4} /></label><div className="buttonRow"><button className="primaryButton" disabled={busy}>Add publication</button>{publications.length ? <button type="button" className="secondaryButton" disabled={busy} onClick={() => setAddingPublication(false)}>Cancel</button> : null}</div></form> : null}
      <div className="recordList">{publications.length ? publications.map((item: any) => <PublicationEditor key={`publication-${item.id}-${item.updated_at || ""}`} item={item} busy={busy} run={run} />) : <div className="emptyState">No publications yet.</div>}</div>
    </div>
  </section></details>;
}

function ProjectEditor({ item, busy, run }: { item: any; busy: boolean; run: Run }) {
  const [fields, setFields] = useState({ title: item.title || "", description: item.description || "", startDate: item.start_date || "", endDate: item.end_date || "", technologies: Array.isArray(item.technologies) ? item.technologies.join(", ") : "", url: item.url || "" });
  const setField = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); await run(() => api("/api/onboarding/portfolio", { method: "POST", body: JSON.stringify({ id: item.id, kind: "project", ...fields, technologies: splitCsv(String(fields.technologies || "")) }) })); };
  return <form className="recordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{fields.title || "Project"}</strong><small>{item.source_id ? "Imported from ChatGPT · check the fields" : "Saved in your profile"}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/portfolio?id=${item.id}&kind=project`, { method: "DELETE" }))}>Remove</button></div><div className="formGrid two"><label className={recordFieldClass(fields.title)}><span>Project title</span><input value={fields.title} onChange={(event) => setField("title", event.target.value)} required /></label><label className={recordFieldClass(fields.startDate)}><span>Start date</span><input type="date" value={fields.startDate} onChange={(event) => setField("startDate", event.target.value)} /></label><label className={recordFieldClass(fields.endDate)}><span>End date</span><input type="date" value={fields.endDate} onChange={(event) => setField("endDate", event.target.value)} /></label><label className={recordFieldClass(fields.technologies)}><span>Technologies</span><input value={fields.technologies} onChange={(event) => setField("technologies", event.target.value)} /></label><label className={recordFieldClass(fields.url)}><span>URL</span><input value={fields.url} type="url" onChange={(event) => setField("url", event.target.value)} /></label><label className={`fullWidth ${recordFieldClass(fields.description)}`}><span>Description</span><textarea value={fields.description} rows={4} onChange={(event) => setField("description", event.target.value)} /></label></div><div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div></form>;
}

function PublicationEditor({ item, busy, run }: { item: any; busy: boolean; run: Run }) {
  const [fields, setFields] = useState({ title: item.title || "", publicationType: item.publication_type || "publication", venue: item.venue || "", publishedOn: item.published_on || "", url: item.url || "", citation: item.citation || "" });
  const setField = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); await run(() => api("/api/onboarding/portfolio", { method: "POST", body: JSON.stringify({ id: item.id, kind: "publication", ...fields }) })); };
  return <form className="recordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{fields.title || "Publication"}</strong><small>{item.source_id ? "Imported from ChatGPT · check the fields" : "Saved in your profile"}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/portfolio?id=${item.id}&kind=publication`, { method: "DELETE" }))}>Remove</button></div><div className="formGrid two"><label className={recordFieldClass(fields.title)}><span>Title</span><input value={fields.title} onChange={(event) => setField("title", event.target.value)} required /></label><label className={recordFieldClass(fields.publicationType)}><span>Publication type</span><input value={fields.publicationType} onChange={(event) => setField("publicationType", event.target.value)} /></label><label className={recordFieldClass(fields.venue)}><span>Venue / publisher</span><input value={fields.venue} onChange={(event) => setField("venue", event.target.value)} /></label><label className={recordFieldClass(fields.publishedOn)}><span>Published date</span><input type="date" value={fields.publishedOn} onChange={(event) => setField("publishedOn", event.target.value)} /></label><label className={recordFieldClass(fields.url)}><span>URL</span><input type="url" value={fields.url} onChange={(event) => setField("url", event.target.value)} /></label><label className={`fullWidth ${recordFieldClass(fields.citation)}`}><span>Citation</span><textarea value={fields.citation} rows={4} onChange={(event) => setField("citation", event.target.value)} /></label></div><div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div></form>;
}

function MemoryUpdateCard({ memory, busy, run, message, onMessage }: { memory: any; busy: boolean; run: Run; message: string | null; onMessage: (message: string) => void }) {
  if (!memory?.confirmed && !memory?.memorySyncEnabled) return null;
  return <section className="card onboardingCard memoryUpdateCard"><div className="cardHeader"><div><div className="eyebrow">Step 5 · Confirmed additions</div><h2>Update ChatGPT Memory</h2><p>After checking and correcting the profile fields, send one update containing only details you added or changed. Imported values that you left unchanged are not sent again.</p></div><span className="badge review">Ordered Website Bridge updates</span></div><div className="buttonRow"><button className="primaryButton" type="button" disabled={busy} onClick={() => void run(async () => { const result = await api("/api/onboarding/memory", { method: "POST", body: JSON.stringify({ action: "sync_confirmed_profile" }) }); notifyBridgeHints(result.bridge_hints || result.bridge_hint); const dispatchCount = Array.isArray(result.dispatches) ? result.dispatches.length : 1; onMessage(`Your new and corrected profile details were queued as ${dispatchCount} ordered Website Bridge update${dispatchCount === 1 ? "" : "s"} for ChatGPT Memory.`); })}>{busy ? "Queueing…" : "Send new and corrected details to ChatGPT Memory"}</button></div>{message ? <div className="notice">{message}</div> : null}</section>;
}

function JobSearchPreferences({ data, searchMode, setSearchMode, busy, onSave }: { data: State | null; searchMode: string; setSearchMode: (value: string) => void; busy: boolean; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  const preferences = data?.preferences || {};
  return <section className="card onboardingCard"><div className="cardHeader"><div><div className="eyebrow">Next · Job search</div><h2>Job-search preferences</h2><p>Choose how roles should be found and how closely they should match your background.</p></div></div><form className="onboardingForm" onSubmit={onSave}>
    <label className={preferenceFieldClass(data, "search_mode")}><span>Role discovery mode</span><select name="searchMode" value={searchMode} onChange={(event) => setSearchMode(event.target.value)}><option value="keywords_and_profile">Use keywords and my profile</option><option value="keywords">Use my keywords only</option><option value="profile">Let ChatGPT discover profile-fit roles</option></select></label>
    <p className="formHelp">Profile-led mode lets ChatGPT suggest roles that fit your experience even when you have not entered role keywords.</p>
    <div className="formGrid two"><label className={preferenceFieldClass(data, "target_roles")}><span>Target role keywords {searchMode === "profile" ? "(optional)" : ""}</span><input name="targetRoles" required={searchMode !== "profile"} defaultValue={(preferences.target_roles || []).join(", ")} placeholder="e.g. Data Analyst, Project Manager" /></label><label className={preferenceFieldClass(data, "role_families")}><span>Role families {searchMode === "profile" ? "(optional)" : ""}</span><input name="roleFamilies" required={searchMode !== "profile"} defaultValue={(preferences.role_families || []).join(", ")} placeholder="e.g. Engineering, Finance, Marketing" /></label><label className={preferenceFieldClass(data, "target_seniority")}><span>Target seniority {searchMode === "profile" ? "(optional)" : ""}</span><input name="targetSeniority" required={searchMode !== "profile"} defaultValue={preferences.target_seniority || ""} placeholder="e.g. Entry-level, mid-level, senior" /></label><label className={preferenceFieldClass(data, "locations")}><span>Preferred locations</span><input name="locations" required defaultValue={(preferences.locations || []).join(", ")} placeholder="e.g. City, country or Remote" /></label><label className={preferenceFieldClass(data, "preferred_industries")}><span>Preferred industries</span><input name="preferredIndustries" defaultValue={(preferences.preferred_industries || []).join(", ")} /></label><label className={preferenceFieldClass(data, "excluded_industries")}><span>Excluded industries</span><input name="excludedIndustries" defaultValue={(preferences.excluded_industries || []).join(", ")} /></label></div>
    <div className={`checkRow ${preferenceFieldClass(data, "work_modes")}`}><label><input type="checkbox" name="workModes" value="onsite" defaultChecked={(preferences.work_modes || []).includes("onsite")} /> On-site</label><label><input type="checkbox" name="workModes" value="hybrid" defaultChecked={(preferences.work_modes || []).includes("hybrid")} /> Hybrid</label><label><input type="checkbox" name="workModes" value="remote" defaultChecked={(preferences.work_modes || []).includes("remote")} /> Remote</label></div>
    <div className="formGrid two"><label className={preferenceFieldClass(data, "max_commute_minutes")}><span>Maximum commute (minutes)</span><input type="number" min="0" name="maxCommuteMinutes" defaultValue={preferences.max_commute_minutes ?? ""} /><small className="formHelp">Enter your own maximum one-way commute. It is not calculated automatically; leave it blank for no commute limit.</small></label><label className={preferenceFieldClass(data, "posting_age_days")}><span>Posting age limit (days)</span><input type="number" min="1" max="90" name="postingAgeDays" defaultValue={preferences.posting_age_policy?.max_days || 30} /></label><label className={preferenceFieldClass(data, "salary_minimum")}><span>Salary floor</span><input type="number" min="0" name="salaryMinimum" defaultValue={preferences.salary?.minimum ?? ""} /></label><label className={preferenceFieldClass(data, "salary_target")}><span>Salary target</span><input type="number" min="0" name="salaryTarget" defaultValue={preferences.salary?.target ?? ""} /></label><label className={preferenceFieldClass(data, "salary_currency")}><span>Salary currency</span><input name="salaryCurrency" maxLength={10} defaultValue={preferences.salary?.currency || ""} placeholder="e.g. ISO currency code" /></label><label className={preferenceFieldClass(data, "min_fit_score_10")}><span>Minimum job-fit score (0–10)</span><input type="number" min="0" max="10" step="1" name="minFitScore10" defaultValue={preferences.min_fit_score_10 ?? Math.round(Number(preferences.min_fit_threshold ?? 60) / 10)} /><small className="formHelp">ChatGPT scores each role against your profile before presenting it.</small></label><label className={preferenceFieldClass(data, "auto_prepare_threshold")}><span>Auto-prepare threshold (0–100)</span><input type="number" min="0" max="100" name="autoPrepareThreshold" defaultValue={preferences.auto_prepare_threshold ?? 80} /><small className="formHelp">The minimum combined job-fit and priority score for JobHuntAI to prepare a draft package automatically. It never submits an application.</small></label></div>
    <label className={`checkLabel ${preferenceFieldClass(data, "sponsorship_required")}`}><input type="checkbox" name="sponsorshipRequired" defaultChecked={Boolean(preferences.sponsorship_required)} /> I require sponsorship</label><div className="formGrid two"><label className={preferenceFieldClass(data, "search_cadence")}><span>Search cadence</span><select name="searchCadence" defaultValue={preferences.search_cadence || "daily"}><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="manual">Manual</option></select></label><label className={preferenceFieldClass(data, "application_automation_preference")}><span>Application automation</span><select name="applicationAutomationPreference" defaultValue={preferences.application_automation_preference || "prepare_and_fill_after_gate1"}><option value="prepare_and_fill_after_gate1">Prepare and fill after Gate 1</option><option value="prepare_only">Prepare packages only</option><option value="manual">Manual handling</option></select></label></div><label className={preferenceFieldClass(data, "notes")}><span>Other preferences</span><textarea name="notes" rows={3} defaultValue={preferences.notes || ""} /><small className="formHelp">Add travel limits, industry context or other search instructions.</small></label><button className="primaryButton" disabled={busy}>Save job-search preferences</button>
  </form></section>;
}
