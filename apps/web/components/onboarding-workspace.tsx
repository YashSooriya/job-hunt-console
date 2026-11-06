"use client";

import { FormEvent, SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatGptMemorySetup } from "@/components/chatgpt-memory-setup";
import { notifyBridgeHints } from "@/lib/chatgpt-bridge/notify";
import { dispatchStateLabel } from "@/lib/chatgpt-bridge/dispatch-state";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { readApiResponse } from "@/lib/onboarding/client-api";
import { personalDetailsPatch as buildPersonalDetailsPatch } from "@/lib/onboarding/profile-form";
import { sortReverseChronological } from "@/lib/onboarding/record-order";
import { formatProfileValue } from "@/lib/onboarding/value-format";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";

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
  return readApiResponse(response, "The onboarding request could not be completed");
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
  const fact = factRecord(data, key);
  return fact?.verification_status === "rejected" ? "" : fact?.value_json || "";
}

function factInputValue(data: State | null, key: string) {
  const formatted = formatProfileValue(factValue(data, key), key);
  // ChatGPT may return human-readable values such as "No" or "I need
  // sponsorship" while the editor stores the select's stable option values.
  // Normalise both sides so an untouched imported answer is not mistaken for
  // a user clearing it during a correction save.
  if (key === "sponsorship_requirement") {
    const value = formatted.toLowerCase();
    if (value === "no" || value.includes("do not need") || value.includes("not applicable")) return "no";
    if (value === "yes" || value.includes("need sponsorship")) return "yes";
    if (value === "unsure" || value.includes("not sure")) return "unsure";
  }
  return formatted;
}

function personalDetailsBaseline(data: State | null) {
  return {
    displayName: typeof data?.profile?.display_name === "string" ? data.profile.display_name : "",
    firstName: factInputValue(data, "first_name"),
    surname: factInputValue(data, "surname"),
    dateOfBirth: factInputValue(data, "date_of_birth"),
    email: factInputValue(data, "email"),
    phone: factInputValue(data, "phone"),
    location: factInputValue(data, "location"),
    citizenship: factInputValue(data, "citizenship"),
    workAuthorisation: factInputValue(data, "work_authorisation"),
    rightToWorkCountries: factInputValue(data, "right_to_work_countries"),
    visaStatus: factInputValue(data, "visa_status"),
    visaExpiry: factInputValue(data, "visa_expiry"),
    sponsorshipRequirement: factInputValue(data, "sponsorship_requirement"),
    noticePeriod: factInputValue(data, "notice_period"),
    currentSalary: factInputValue(data, "current_salary"),
    salaryCurrency: factInputValue(data, "salary_currency"),
    salaryExpectation: factInputValue(data, "salary_expectation"),
    availabilityDate: factInputValue(data, "availability_date"),
    languages: factInputValue(data, "languages"),
    portfolioLinks: factInputValue(data, "portfolio_links"),
    linkedinUrl: factInputValue(data, "linkedin_url"),
    certifications: factInputValue(data, "certifications"),
  };
}

function fieldClass(value: unknown) {
  return hasValue(value) ? "profileField" : "profileField needsUserInput";
}

function recordFieldClass(value: unknown) {
  return hasValue(value) ? "recordField" : "recordField needsUserInput";
}

function recordSourceLabel(item: any) {
  if (!item.source_id) return "Saved in your profile";
  const source = item.source_title || (item.source_type === "chatgpt_memory" ? "Imported from ChatGPT" : "Imported source");
  return item.verification_status === "needs_review"
    ? source + " · review the fields, then save to confirm"
    : source + " · reviewed";
}

function useRecordDisclosure() {
  const [open, setOpen] = useState(false);
  return {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open),
  };
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
  const chatgptOperation = useChatGptOperation();
  const [data, setData] = useState<State | null>(null);
  const [memory, setMemory] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sourceFileRows, setSourceFileRows] = useState<SourceFileRow[]>([{ id: 1, file: null }]);
  const [profileText, setProfileText] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [backgroundMessage, setBackgroundMessage] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [memoryUpdateMessage, setMemoryUpdateMessage] = useState<string | null>(null);
  const [resetStage, setResetStage] = useState<"closed" | "warning" | "confirm">("closed");
  const [resetPhrase, setResetPhrase] = useState("");
  const [memorySetupKey, setMemorySetupKey] = useState(0);
  const [personalDetailsDirty, setPersonalDetailsDirty] = useState(false);
  const personalDetailsFormRef = useRef<HTMLFormElement | null>(null);
  const profileDispatchId = typeof memory?.importDispatchId === "string" ? memory.importDispatchId : null;
  const profileDispatchStatus = useDispatchStatus(profileDispatchId);
  const profileBuildWaiting = isWaitingForChatGpt({ state: profileDispatchStatus.state || undefined, raw: profileDispatchStatus.dispatch?.raw });
  const lastSavedBundleRevision = useRef<string | null>(null);
  // A Save click is the explicit authorization to build the profile. If
  // Memory consent is still undecided, keep that authorization alive until
  // the user answers the Memory prompt instead of requiring a second Save.
  const pendingBuildAfterConsent = useRef(false);
  const sourceFiles = useMemo(() => sourceFileRows.flatMap((row) => row.file ? [row.file] : []), [sourceFileRows]);
  const savedLinkedinUrl = factInputValue(data, "linkedin_url");
  const savedAdditionalInformation = typeof data?.additionalInformation === "string" ? data.additionalInformation : "";
  const allSavedSourceDocuments = (data?.sourceDocuments || []).filter((item: any) => item.source_type !== "chatgpt_memory");
  const savedSourceDocuments = allSavedSourceDocuments.filter((item: any) => item.source_type !== "user_description");
  const hasUnsavedSourceChanges = sourceFiles.length > 0
    || profileText.trim() !== savedAdditionalInformation.trim()
    || linkedinUrl.trim() !== String(savedLinkedinUrl || "").trim();
  const hasSourceInput = savedSourceDocuments.length > 0
    || sourceFiles.length > 0
    || Boolean(profileText.trim())
    || Boolean(linkedinUrl.trim())
    || Boolean(savedAdditionalInformation.trim())
    // Clearing the last saved value is itself a saveable source change.
    || hasUnsavedSourceChanges;
  const memoryImportActive = ["queued", "in_progress"].includes(String(memory?.importStatus || ""));
  const sourceExtractionErrors = (data?.sourceDocuments || []).filter((item: any) => item.source_type !== "chatgpt_memory" && item.extraction_error);
  const hasPendingProfileReview = Number(data?.readiness?.pending_review || 0) > 0 || sourceExtractionErrors.length > 0;
  const hasPendingStructuredRecords = [
    ...(data?.education || []),
    ...(data?.employment || []),
    ...(data?.skills || []),
    ...(data?.projects || []),
    ...(data?.publications || []),
  ].some((item: any) => item.verification_status === "needs_review");

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
    setProfileText(typeof data?.additionalInformation === "string" ? data.additionalInformation : "");
  }, [data]);

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

  async function persistPersonalDetails(form: HTMLFormElement, options: { partial?: boolean } = {}) {
    const values = new FormData(form);
    const partial = options.partial !== false;
    const payload = partial
      ? { partial: true, ...buildPersonalDetailsPatch(values, personalDetailsBaseline(data)) }
      : {};
    // A change event can fire even when the user types a value and then puts
    // it back. Avoid a no-op API write and, importantly, avoid turning an
    // untouched blank field into a deletion during a correction.
    if (partial && Object.keys(payload).length === 1) {
      setPersonalDetailsDirty(false);
      return;
    }
    await api("/api/onboarding/profile", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setPersonalDetailsDirty(false);
  }

  async function savePersonalDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(() => persistPersonalDetails(event.currentTarget));
  }

  async function savePersonalDetailsBeforeMemory() {
    const form = personalDetailsFormRef.current;
    if (!form || !personalDetailsDirty) return;
    // This is an incremental correction path. Do not run the complete form's
    // native required-field validation: an imported profile may legitimately
    // still have a blank Display name or work-authorisation field while the
    // user is correcting salary, notice period, location, or another value.
    // The partial payload contains only values that differ from the last
    // loaded profile, so omitted fields cannot be deleted accidentally.
    await persistPersonalDetails(form, { partial: true });
  }

  async function saveSourceInputs() {
    return run(async () => {
      const result = await api("/api/onboarding/sources", {
        method: "POST",
        body: JSON.stringify({
          linkedinUrl: linkedinUrl.trim() || null,
          additionalInformation: profileText.trim() || null,
          expectedRevision: data?.bundleRevision || null,
        }),
      });
      lastSavedBundleRevision.current = typeof result.bundleRevision === "string" ? result.bundleRevision : null;
      setData((current: State | null) => current ? {
        ...current,
        sourceDocuments: result.documents || current.sourceDocuments,
        bundleRevision: result.bundleRevision || current.bundleRevision,
        additionalInformation: result.additionalInformation ?? "",
      } : current);
    });
  }

  async function queueProfessionalProfile() {
    const operationToken = chatgptOperation.beginLocalOperation("Build professional profile");
    if (!operationToken) {
      setError(chatgptOperation.message || "Another ChatGPT task is already active.");
      return false;
    }
    try {
      return await run(async () => {
        const result = await api("/api/onboarding/professional-background", {
          method: "POST",
          body: JSON.stringify({ expectedBundleRevision: lastSavedBundleRevision.current || data?.bundleRevision || null }),
        });
        notifyBridgeHints(result.bridge_hints || result.bridge_hint);
        if (result.profileImportQueued) {
          setMemory((current: any) => current
            ? { ...current, importStatus: "queued", importDispatchId: result.dispatch?.id || current.importDispatchId }
            : current);
        }
        const sourceCount = Number(result.sourceCount || 0);
        setBackgroundMessage(result.profileImportQueued
          ? `${sourceCount} source${sourceCount === 1 ? "" : "s"} saved. Your profile update is queued and will show here when ChatGPT has processed it.`
          : `${sourceCount} source${sourceCount === 1 ? "" : "s"} saved. The profile build was not queued.`);
        setSourceFileRows([{ id: Date.now(), file: null }]);
      });
    } finally {
      chatgptOperation.finishLocalOperation(operationToken);
    }
  }

  async function buildProfessionalProfile() {
    if (sourceFiles.length) {
      setError("Wait for the selected document to finish uploading before building the profile.");
      return false;
    }
    if (!hasSourceInput) {
      setError("Choose at least one source file, enter a description, or add your LinkedIn profile URL.");
      return false;
    }

    if (hasUnsavedSourceChanges) {
      const saved = await saveSourceInputs();
      if (!saved) return false;
      setBackgroundMessage("Sources saved. Review the extracted information before building a profile. No ChatGPT message has been sent.");
      return true;
    }
    if (hasPendingProfileReview) {
      setError("Review or remove every extracted item and unreadable source before sending a profile update.");
      return false;
    }

    const bundleWillRemainAfterSave = sourceFiles.length > 0
      || savedSourceDocuments.some((item: any) => item.source_type !== "user_description")
      || Boolean(profileText.trim())
      || Boolean(linkedinUrl.trim());
    if (!bundleWillRemainAfterSave) {
      pendingBuildAfterConsent.current = false;
      setBackgroundMessage("Sources saved. No documents, LinkedIn URL or additional information remain, so nothing was sent to ChatGPT.");
      setSourceFileRows([{ id: Date.now(), file: null }]);
      return true;
    }

    if (!memory?.confirmed) {
      pendingBuildAfterConsent.current = memory?.decision !== "declined";
      setBackgroundMessage(memory?.decision === "declined"
        ? "Sources saved. ChatGPT Memory is not enabled, so no ChatGPT message was sent."
        : "Sources saved. Press Yes, use ChatGPT Memory below to continue this build. No ChatGPT message has been sent yet.");
      setSourceFileRows([{ id: Date.now(), file: null }]);
      return true;
    }

    pendingBuildAfterConsent.current = false;
    return queueProfessionalProfile();
  }

  async function handleMemoryAllowed() {
    if (!pendingBuildAfterConsent.current) return true;
    if (hasUnsavedSourceChanges || sourceFiles.length > 0) {
      pendingBuildAfterConsent.current = false;
      setBackgroundMessage("Memory was allowed, but the staged sources changed after Save. Press Save sources and build profile again to authorize the current bundle.");
      return false;
    }
    pendingBuildAfterConsent.current = false;
    return queueProfessionalProfile();
  }

  const handleMemoryChanged = useCallback((nextMemory: any, action?: "allow" | "decline" | "reset" | "check_completed_response") => {
    setMemory(nextMemory);
    // A passive status refresh can report "undecided" while the user is
    // between Save and the explicit Memory choice. Only explicit choices may
    // invalidate that pending build authorization.
    if (action === "decline" || action === "reset") {
      pendingBuildAfterConsent.current = false;
    }
  }, []);

  async function stageSourceFile(rowId: number, file: File | null) {
    if (!file) return;
    const saved = await run(async () => {
      const form = new FormData();
      form.set("file", file);
      form.set("sourceType", "cv_upload");
      form.set("title", file.name);
      await api("/api/onboarding/import-cv", { method: "POST", body: form });
    });
    if (saved) removeSourceFileRow(rowId);
  }

  async function submitBackgroundSources(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await buildProfessionalProfile();
  }

  async function resetOnboardingData() {
    await run(async () => {
      await api("/api/onboarding/reset", { method: "POST", body: JSON.stringify({ confirmation: "RESET ONBOARDING DATA" }) });
      setResetStage("closed");
      setResetPhrase("");
      setSourceFileRows([{ id: Date.now(), file: null }]);
      setProfileText("");
      setLinkedinUrl("");
      setBackgroundMessage(null);
      setImportMessage("Onboarding data was cleared. Your account, jobs, applications, ChatGPT Project and bridge pairing were kept.");
      setMemoryUpdateMessage(null);
      setMemorySetupKey((current) => current + 1);
      pendingBuildAfterConsent.current = false;
    });
  }

  function updateSourceFile(index: number, file: File | null) {
    if (file) {
      // A document attached after Save belongs to a new bundle. Require a
      // fresh Save before a pending Memory-consent build can send it.
      pendingBuildAfterConsent.current = false;
      void stageSourceFile(sourceFileRows[index]?.id ?? 0, file);
      return;
    }
    setSourceFileRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, file: null } : row));
  }

  function addSourceFileRow() {
    setSourceFileRows((rows) => [...rows, { id: Date.now() + rows.length, file: null }]);
  }

  function removeSourceFileRow(rowId: number) {
    setSourceFileRows((rows) => rows.length === 1
      ? [{ id: Date.now(), file: null }]
      : rows.filter((row) => row.id !== rowId));
  }

  async function removeStoredSource(documentId: string, title: string) {
    if (typeof window !== "undefined" && !window.confirm(`Remove “${title}” from this onboarding profile? Its private stored file and any imported records derived from it will be deleted.`)) return;
    await run(async () => {
      const result = await api(`/api/onboarding/import-cv?id=${encodeURIComponent(documentId)}`, { method: "DELETE" });
      setBackgroundMessage(`${result.title || title} was removed from the saved source bundle. It will no longer be staged for ChatGPT.`);
    });
    pendingBuildAfterConsent.current = false;
  }

  async function clearLinkedInSource() {
    const savedValue = String(savedLinkedinUrl || "").trim();
    const draftValue = linkedinUrl.trim();
    pendingBuildAfterConsent.current = false;
    if (!savedValue || draftValue !== savedValue) {
      setLinkedinUrl("");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm("Remove the saved LinkedIn URL from this onboarding profile?")) return;
    await run(async () => {
      await api("/api/onboarding/sources", {
        method: "POST",
        body: JSON.stringify({ linkedinUrl: null, expectedRevision: data?.bundleRevision || null }),
      });
      setLinkedinUrl("");
      setBackgroundMessage("The saved LinkedIn URL was removed from the source bundle.");
    });
  }

  async function clearAdditionalInformation() {
    const savedValue = savedAdditionalInformation.trim();
    const draftValue = profileText.trim();
    pendingBuildAfterConsent.current = false;
    if (!savedValue || draftValue !== savedValue) {
      setProfileText("");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm("Remove the saved Additional Information from this onboarding profile?")) return;
    await run(async () => {
      await api("/api/onboarding/sources", {
        method: "POST",
        body: JSON.stringify({ additionalInformation: null, expectedRevision: data?.bundleRevision || null }),
      });
      setProfileText("");
      setBackgroundMessage("The saved Additional Information was removed from the source bundle.");
    });
  }

  return <div className="onboardingWorkspace">
    <nav className="onboardingStepRail" aria-label="Profile setup steps">
      <a href="#profile-sources"><span>1</span>Your information</a>
      <a href="#onboarding-details"><span>2</span>Review profile</a>
      <a href="/jobs/settings#job-preferences"><span>3</span>Search preferences</a>
    </nav>
    {error ? <div className="errorNotice">{error}</div> : null}

    <section id="profile-sources" className="card onboardingCard">
      <div className="cardHeader"><div><h2>Your background</h2><p>Add a CV or share a few details to build your profile.</p></div></div>
      <form className="onboardingForm sourceInputForm" onSubmit={(event) => void submitBackgroundSources(event)}>
        <div className="sourceInputGrid">
          <div className="sourceInputGroup">
            <div className="sourceInputHeading"><strong>Documents</strong><span>PDF, DOCX, TXT, Markdown or RTF</span></div>
            <div className="sourceFileList">{sourceFileRows.map((row, index) => <div className="sourceFileRow" key={row.id}>
              <label><span>{index === 0 ? "CV or document" : "Another document"}</span><input type="file" disabled={busy} accept=".pdf,.docx,.txt,.md,.markdown,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/rtf" onChange={(event) => updateSourceFile(index, event.target.files?.[0] || null)} /></label>
              {(sourceFileRows.length > 1 || row.file) ? <button type="button" className="textButton" disabled={busy} onClick={() => removeSourceFileRow(row.id)}>{row.file ? "Clear" : "Remove"}</button> : null}
            </div>)}</div>
            <button type="button" className="secondaryButton addSourceButton" disabled={busy} onClick={addSourceFileRow}>+ Add document</button>
          </div>
          <div className="sourceInputGroup sourceTextFields">
            <div className="sourceInputHeading"><strong>Links and notes</strong><span>Optional</span></div>
            <label className={fieldClass(linkedinUrl)}><div className="sourceFieldLabel"><span>LinkedIn profile URL</span>{linkedinUrl.trim() || savedLinkedinUrl.trim() ? <button type="button" className="textButton" disabled={busy || memoryImportActive} onClick={() => void clearLinkedInSource()}>{linkedinUrl.trim() === savedLinkedinUrl.trim() && savedLinkedinUrl.trim() ? "Remove" : "Clear"}</button> : null}</div><input type="url" value={linkedinUrl} onChange={(event) => { setLinkedinUrl(event.target.value); pendingBuildAfterConsent.current = false; }} placeholder="https://www.linkedin.com/in/your-name" /></label>
            <label><div className="sourceFieldLabel"><span>Additional information</span>{profileText.trim() || savedAdditionalInformation.trim() ? <button type="button" className="textButton" disabled={busy || memoryImportActive} onClick={() => void clearAdditionalInformation()}>{profileText.trim() === savedAdditionalInformation.trim() && savedAdditionalInformation.trim() ? "Remove" : "Clear"}</button> : null}</div><textarea value={profileText} onChange={(event) => { setProfileText(event.target.value); pendingBuildAfterConsent.current = false; }} rows={4} placeholder="Anything your documents do not mention" /></label>
          </div>
        </div>
        <div className="buttonRow sourceActions"><button className="primaryButton" disabled={busy || chatgptOperation.blocked || memoryImportActive || sourceFiles.length > 0 || !hasSourceInput || (!hasUnsavedSourceChanges && hasPendingProfileReview)}>{profileBuildWaiting ? <><span className="chatgptActivitySpinner" aria-hidden="true" /> ChatGPT is building your profile…</> : busy ? "Saving…" : hasUnsavedSourceChanges ? "Save sources for review" : hasPendingProfileReview ? "Review profile items first" : "Save and build profile"}</button>{sourceFiles.length || savedSourceDocuments.length ? <span className="muted">{sourceFiles.length ? `${sourceFiles.length} uploading…` : `${savedSourceDocuments.length} document${savedSourceDocuments.length === 1 ? "" : "s"} saved`}</span> : null}</div>
        {backgroundMessage ? <div className="notice">{backgroundMessage}</div> : null}
      </form>
      {savedSourceDocuments.length ? <details className="onboardingSavedSources"><summary>Saved documents ({savedSourceDocuments.length})</summary><div className="compactList">{savedSourceDocuments.map((item: any) => <div key={item.id}><strong>{item.original_name}</strong><span>{item.extraction_error || (item.extraction_status === "extracted" ? "Text extracted · review claims below" : "Saved")}</span><button type="button" className="textButton" disabled={busy || memoryImportActive} onClick={() => void removeStoredSource(String(item.id), String(item.original_name || "this source"))}>Remove</button></div>)}</div></details> : null}
    </section>

    <PendingReviewSection data={data} busy={busy} run={run} />

    <details id="chatgpt-memory" className="onboardingAdvancedDetails onboardingMemoryDetails" open={!memory?.confirmed}>
      <summary>ChatGPT profile setup</summary>
      <ChatGptMemorySetup key={memorySetupKey} memory={memory} sourceDocuments={savedSourceDocuments} savedLinkedinUrl={savedLinkedinUrl} linkedinUrl={linkedinUrl} additionalInformation={profileText} savedAdditionalInformation={savedAdditionalInformation} hasUnsavedSourceChanges={hasUnsavedSourceChanges} onProfileChanged={load} onMemoryChanged={handleMemoryChanged} onMemoryAllowed={handleMemoryAllowed} />
      <ImportedProfileStatus data={data} busy={busy} run={run} message={importMessage} onMessage={setImportMessage} />
    </details>

    <section id="onboarding-details" className="card onboardingCard">
      <div className="cardHeader"><div><h2>Review your profile</h2><p>Check the details and correct anything that is wrong.</p></div></div>
      <form ref={personalDetailsFormRef} key={personalFormKey(data)} className="onboardingForm profileDetailsForm" onSubmit={(event) => void savePersonalDetails(event)} onChange={() => setPersonalDetailsDirty(true)}>
        <div className="profileFormGroup"><h3>Basics</h3><div className="formGrid two">
        <label className={fieldClass(data?.profile?.display_name)}><span>Display name</span><input name="displayName" defaultValue={data?.profile?.display_name || ""} /></label>
        <label className={fieldClass(factValue(data, "first_name"))}><span>First name</span><input name="firstName" defaultValue={factInputValue(data, "first_name")} /></label>
        <label className={fieldClass(factValue(data, "surname"))}><span>Surname</span><input name="surname" defaultValue={factInputValue(data, "surname")} /></label>
        <label className={fieldClass(factValue(data, "date_of_birth"))}><span>Date of birth</span><input name="dateOfBirth" type="date" defaultValue={factInputValue(data, "date_of_birth")} /></label>
        <label className={fieldClass(factValue(data, "email"))}><span>Email</span><input name="email" type="email" defaultValue={factInputValue(data, "email")} /></label>
        <label className={fieldClass(factValue(data, "phone"))}><span>Phone</span><input name="phone" defaultValue={factInputValue(data, "phone")} /></label>
        <label className={fieldClass(factValue(data, "location"))}><span>Current location</span><input name="location" defaultValue={factInputValue(data, "location")} /></label>
        </div></div>
        <div className="profileFormGroup"><h3>Work eligibility</h3><div className="formGrid two">
        <label className={fieldClass(factValue(data, "citizenship"))}><span>Citizenship</span><input name="citizenship" placeholder="e.g. British" defaultValue={factInputValue(data, "citizenship")} /></label>
        <label className={fieldClass(factValue(data, "work_authorisation"))}><span>Legal right to work</span><input name="workAuthorisation" placeholder="e.g. British citizen, settled status, visa" defaultValue={factInputValue(data, "work_authorisation")} /><small className="formHelp">Your legal permission to work; it is separate from citizenship.</small></label>
        <label className={fieldClass(factValue(data, "right_to_work_countries"))}><span>Countries where you can work</span><input name="rightToWorkCountries" placeholder="e.g. UK, Ireland" defaultValue={factInputValue(data, "right_to_work_countries")} /></label>
        <label className={fieldClass(factValue(data, "visa_status"))}><span>Visa or immigration status</span><input name="visaStatus" placeholder="e.g. Settled status, Skilled Worker visa, not applicable" defaultValue={factInputValue(data, "visa_status")} /></label>
        <label className={fieldClass(factValue(data, "visa_expiry"))}><span>Visa expiry</span><input name="visaExpiry" type="date" defaultValue={factInputValue(data, "visa_expiry")} /></label>
        <label className={fieldClass(factValue(data, "sponsorship_requirement"))}><span>Sponsorship requirement</span><select name="sponsorshipRequirement" defaultValue={factInputValue(data, "sponsorship_requirement")}><option value="">Select an answer</option><option value="no">I do not need sponsorship</option><option value="yes">I need sponsorship</option><option value="unsure">Not sure</option></select></label>
        </div></div>
        <div className="profileFormGroup"><h3>Availability and pay</h3><div className="formGrid two">
        <label className={fieldClass(factValue(data, "notice_period"))}><span>Notice period</span><input name="noticePeriod" placeholder="e.g. 1 month" defaultValue={factInputValue(data, "notice_period")} /></label>
        <label className={fieldClass(factValue(data, "current_salary"))}><span>Current salary</span><input name="currentSalary" inputMode="decimal" placeholder="Amount or not applicable" defaultValue={factInputValue(data, "current_salary")} /></label>
        <label className={fieldClass(factValue(data, "salary_currency"))}><span>Current salary currency</span><input name="salaryCurrency" placeholder="e.g. GBP" defaultValue={factInputValue(data, "salary_currency")} /></label>
        <label className={fieldClass(factValue(data, "salary_expectation"))}><span>Salary expectation</span><input name="salaryExpectation" placeholder="Amount or range" defaultValue={factInputValue(data, "salary_expectation")} /></label>
        <label className={fieldClass(factValue(data, "availability_date"))}><span>Earliest availability</span><input name="availabilityDate" placeholder="e.g. 1 September 2026" defaultValue={factInputValue(data, "availability_date")} /></label>
        </div></div>
        <div className="profileFormGroup"><h3>Links and credentials</h3><div className="formGrid two">
        <label className={fieldClass(factValue(data, "languages"))}><span>Languages</span><input name="languages" placeholder="e.g. English, French" defaultValue={factInputValue(data, "languages")} /></label>
        <label className={fieldClass(factValue(data, "portfolio_links"))}><span>Portfolio links</span><input name="portfolioLinks" placeholder="Separate links with commas" defaultValue={factInputValue(data, "portfolio_links")} /></label>
        <label className={fieldClass(factValue(data, "linkedin_url"))}><span>LinkedIn profile URL</span><input name="linkedinUrl" type="url" placeholder="https://www.linkedin.com/in/your-name" defaultValue={factInputValue(data, "linkedin_url")} /></label>
        <label className={fieldClass(factValue(data, "certifications"))}><span>Certifications and professional credentials</span><input name="certifications" placeholder="e.g. AWS Certified..., PRINCE2..." defaultValue={factInputValue(data, "certifications")} /></label>
        </div></div>
        <div className="formActions"><button className="primaryButton" disabled={busy}>Save personal details</button></div>
      </form>
    </section>

    <details id="more-profile-details" className="onboardingAdvancedDetails" open={hasPendingStructuredRecords}>
      <summary>More profile details</summary>
      <HistorySection data={data} busy={busy} run={run} />
      <SkillsSection data={data} busy={busy} run={run} />
      <ProjectsSection data={data} busy={busy} run={run} />
      <MemoryUpdateCard memory={memory} busy={busy} run={run} message={memoryUpdateMessage} onMessage={setMemoryUpdateMessage} onMemoryChanged={setMemory} hasUnsavedProfileChanges={personalDetailsDirty} savePendingProfile={savePersonalDetailsBeforeMemory} />
      <section className="card onboardingCard onboardingResetCard"><div className="cardHeader"><div><h2>Reset profile setup</h2><p>Remove imported profile information and files.</p></div></div>{resetStage === "closed" ? <div className="onboardingResetBody"><button className="secondaryButton dangerButton" type="button" disabled={busy} onClick={() => setResetStage("warning")}>Reset profile data</button></div> : resetStage === "warning" ? <div className="onboardingResetBody"><div className="resetWarning"><strong>This cannot be undone.</strong><p>Your onboarding profile, files and records will be deleted. Your account, jobs and ChatGPT connection will remain.</p></div><div className="buttonRow"><button className="secondaryButton" type="button" disabled={busy} onClick={() => setResetStage("closed")}>Cancel</button><button className="primaryButton" type="button" disabled={busy} onClick={() => setResetStage("confirm")}>Yes, continue</button></div></div> : <div className="onboardingResetBody"><div className="resetWarning"><strong>Final confirmation</strong><p>Type <code>RESET ONBOARDING DATA</code> below.</p></div><input aria-label="Reset confirmation" value={resetPhrase} onChange={(event) => setResetPhrase(event.target.value)} placeholder="RESET ONBOARDING DATA" autoComplete="off" /><div className="buttonRow"><button className="secondaryButton" type="button" disabled={busy} onClick={() => { setResetStage("closed"); setResetPhrase(""); }}>Cancel</button><button className="dangerButton" type="button" disabled={busy || resetPhrase !== "RESET ONBOARDING DATA"} onClick={() => void resetOnboardingData()}>{busy ? "Clearing…" : "Delete profile data"}</button></div></div>}</section>
    </details>
  </div>;
}

function ImportedProfileStatus({ data, busy, run, message, onMessage }: { data: State | null; busy: boolean; run: Run; message: string | null; onMessage: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const chatGptSource = (data?.sourceDocuments || []).find((item: any) => item.source_type === "chatgpt_memory");
  const structuredCount = (data?.employment?.length || 0) + (data?.education?.length || 0) + (data?.skills?.length || 0) + (data?.projects?.length || 0) + (data?.publications?.length || 0);
  const factCount = (data?.facts || []).filter((item: any) => String(item.source_note || "").startsWith("chatgpt_memory:")).length;
  const needsReview = Number(data?.readiness?.pending_review || 0) > 0;

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
    <div className="cardHeader"><div><div className="eyebrow">Import status</div><h2>{chatGptSource ? needsReview ? "Review imported profile" : "Profile response received" : "Waiting for your profile"}</h2></div><span className={`badge ${chatGptSource ? needsReview ? "action" : "review" : "muted"}`}>{chatGptSource ? needsReview ? "Needs review" : "Reviewed" : "Not imported"}</span></div>
    <div className="importedProfileSummary"><span>{chatGptSource ? `${factCount} details` : "No profile yet"}</span><span>{chatGptSource ? `${structuredCount} records` : "Build with ChatGPT above"}</span></div>
    {chatGptSource ? <p className="formHint">A captured profile response does not confirm that every fact was retained in ChatGPT Memory. Review and confirm each item here.</p> : null}
    <div className="buttonRow"><button className="secondaryButton" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>Import JSON manually</button><input ref={inputRef} className="visuallyHidden" type="file" accept=".json,application/json" onChange={(event) => void reimportJson(event)} />{chatGptSource ? <a className="textLink" href="#onboarding-details">Review profile ↓</a> : null}</div>
    {message && message.includes("Imported ") ? <div className="notice" aria-live="polite">{message}</div> : null}
  </section>;
}

const PROPOSAL_FIELD_LABELS: Record<string, string> = {
  employer: "Employer",
  role_title: "Job title",
  institution: "Institution",
  qualification: "Qualification",
  field_of_study: "Field of study",
  location: "Location",
  start_date: "Start date",
  end_date: "End date",
  name: "Skill",
  category: "Category",
  title: "Title",
  description: "Description",
  details: "Details",
  technologies: "Technologies",
  venue: "Venue",
  published_on: "Published date",
  url: "URL",
  citation: "Citation",
};

function proposalEditKeys(type: string) {
  if (type === "employment") return ["employer", "role_title", "location", "start_date", "end_date", "details"];
  if (type === "education") return ["institution", "qualification", "field_of_study", "location", "start_date", "end_date", "details"];
  if (type === "skill") return ["name", "category", "proficiency"];
  if (type === "project") return ["title", "description", "technologies", "start_date", "end_date", "url"];
  if (type === "publication") return ["title", "publication_type", "venue", "published_on", "url", "citation"];
  return ["details"];
}

function proposalIdentity(proposal: any) {
  const value = proposal?.proposed_json && typeof proposal.proposed_json === "object" ? proposal.proposed_json : {};
  const fields = proposal.proposal_type === "employment" ? [value.employer, value.role_title]
    : proposal.proposal_type === "education" ? [value.institution, value.qualification]
      : proposal.proposal_type === "skill" ? [value.name]
        : proposal.proposal_type === "project" || proposal.proposal_type === "publication" ? [value.title]
          : [];
  const identity = fields.map((field) => String(field || "").trim().toLowerCase()).filter(Boolean);
  return identity.length ? proposal.proposal_type + ":" + identity.join("|") : null;
}

function proposalConflictSources(proposals: any[]) {
  const groups = new Map<string, any[]>();
  for (const proposal of proposals) {
    const identity = proposalIdentity(proposal);
    if (!identity) continue;
    const group = groups.get(identity) || [];
    group.push(proposal);
    groups.set(identity, group);
  }
  const conflicts = new Map<string, string[]>();
  for (const group of groups.values()) {
    const signatures = new Set(group.map((proposal) => {
      const value = proposal.proposed_json || {};
      return JSON.stringify([value.start_date || null, value.end_date || null, value.current === true, value.claim || ""]);
    }));
    if (group.length < 2 || signatures.size < 2) continue;
    for (const proposal of group) {
      conflicts.set(String(proposal.id), group
        .filter((other) => String(other.id) !== String(proposal.id))
        .map((other) => String(other.source_title || "another source")));
    }
  }
  return conflicts;
}

function FactReviewCard({ fact, busy, run }: { fact: any; busy: boolean; run: Run }) {
  const originalValue = formatProfileValue(fact.value_json, fact.fact_key);
  const [value, setValue] = useState(originalValue);
  const label = String(fact.fact_key || "Profile fact").replaceAll("_", " ");
  async function decide(status: "verified" | "rejected") {
    await run(() => api("/api/onboarding/review", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        id: fact.id,
        status,
        ...(status === "verified" && value.trim() !== originalValue ? { value: value.trim() } : {}),
      }),
    }));
  }
  return <article className="recordEditor pendingReviewItem">
    <div className="recordEditorHeader"><div><strong>{label}</strong><small>{String(fact.source_note || "").startsWith("chatgpt_memory:") ? "Imported from ChatGPT · review this value" : "Extracted value · review before use"}</small></div><span className="badge action">Needs review</span></div>
    <label className="recordField"><span>Confirm or correct the value</span><input value={value} onChange={(event) => setValue(event.target.value)} /></label>
    <div className="recordEditorActions"><button type="button" className="primaryButton" disabled={busy || !value.trim()} onClick={() => void decide("verified")}>Confirm value</button><button type="button" className="textButton" disabled={busy} onClick={() => void decide("rejected")}>Reject value</button></div>
  </article>;
}

function EvidenceReviewCard({ item, busy, run }: { item: any; busy: boolean; run: Run }) {
  const [claim, setClaim] = useState(String(item.claim || ""));
  async function decide(status: "verified" | "rejected") {
    await run(() => api("/api/onboarding/review", {
      method: "POST",
      body: JSON.stringify({ kind: "evidence", id: item.id, status, claim }),
    }));
  }
  const source = item.evidence_sources?.title || "Imported source";
  return <article className="recordEditor pendingReviewItem">
    <div className="recordEditorHeader"><div><strong>Supporting evidence</strong><small>{source}{item.source_locator ? " · " + item.source_locator : ""}</small></div><span className="badge action">Needs review</span></div>
    <label className="recordField"><span>Evidence claim</span><textarea rows={3} value={claim} onChange={(event) => setClaim(event.target.value)} /></label>
    <div className="recordEditorActions"><button type="button" className="primaryButton" disabled={busy || !claim.trim()} onClick={() => void decide("verified")}>Confirm evidence</button><button type="button" className="textButton" disabled={busy} onClick={() => void decide("rejected")}>Reject evidence</button></div>
  </article>;
}

function ProposalReviewCard({ proposal, conflictSources, busy, run }: { proposal: any; conflictSources: string[]; busy: boolean; run: Run }) {
  const original = proposal?.proposed_json && typeof proposal.proposed_json === "object" ? proposal.proposed_json : {};
  const editKeys = proposalEditKeys(String(proposal.proposal_type || ""));
  const firstClaim = String(original.claim || original.title || original.name || original.employer || original.institution || "");
  const [claim, setClaim] = useState(firstClaim);
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(editKeys.map((key) => {
    const sourceValue = key === "details" ? original.details || original.detail : original[key];
    return [key, Array.isArray(sourceValue) ? sourceValue.join(", ") : String(sourceValue || "")];
  })));
  const title = String(proposal.proposal_type || "profile item").replaceAll("_", " ");
  async function decide(status: "verified" | "rejected") {
    if (status === "rejected") {
      await run(() => api("/api/onboarding/review", {
        method: "POST",
        body: JSON.stringify({ kind: "proposal", id: proposal.id, status }),
      }));
      return;
    }
    const changes: Record<string, unknown> = {};
    for (const key of editKeys) {
      const prior = key === "details" ? original.details || original.detail : original[key];
      const before = Array.isArray(prior) ? prior.join(", ") : String(prior || "");
      if (fields[key] === before) continue;
      changes[key] = key === "technologies" ? splitCsv(fields[key]) : fields[key];
    }
    if (claim !== firstClaim) changes.claim = claim;
    await run(() => api("/api/onboarding/review", {
      method: "POST",
      body: JSON.stringify({ kind: "proposal", id: proposal.id, status, claim, fields: changes }),
    }));
  }
  return <article className="recordEditor pendingReviewItem">
    <div className="recordEditorHeader"><div><strong>{claim || title}</strong><small>{proposal.source_title || "Imported professional source"}{proposal.source_locator ? " · " + proposal.source_locator : ""}</small></div><span className="badge action">Needs review</span></div>
    {conflictSources.length ? <div className="memoryStagedWarning"><strong>Possible conflict</strong><span>Another source records this item differently: {conflictSources.join(", ")}. Compare the source details before deciding.</span></div> : null}
    <label className="recordField"><span>Claim</span><input value={claim} onChange={(event) => setClaim(event.target.value)} /></label>
    <div className="formGrid two">{editKeys.filter((key) => key !== "details" && key !== "description" && key !== "citation").map((key) => <label className="recordField" key={key}><span>{PROPOSAL_FIELD_LABELS[key] || key.replaceAll("_", " ")}</span><input type={["start_date", "end_date", "published_on"].includes(key) ? "date" : "text"} value={fields[key] || ""} onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div>
    {editKeys.filter((key) => ["details", "description", "citation"].includes(key)).map((key) => <label className="recordField" key={key}><span>{PROPOSAL_FIELD_LABELS[key]}</span><textarea rows={3} value={fields[key] || ""} onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
    <div className="recordEditorActions"><button type="button" className="primaryButton" disabled={busy || !claim.trim()} onClick={() => void decide("verified")}>Add to profile</button><button type="button" className="textButton" disabled={busy} onClick={() => void decide("rejected")}>Dismiss</button></div>
  </article>;
}

function PendingReviewSection({ data, busy, run }: { data: State | null; busy: boolean; run: Run }) {
  if (!data) return null;
  const facts = (data.facts || []).filter((item: any) => item.verification_status === "needs_review");
  const evidence = (data.evidence || []).filter((item: any) => item.verification_status === "needs_review");
  const proposals = (data.extractionProposals || []).filter((item: any) => item.verification_status === "needs_review");
  const pendingRecords = [
    ...(data.employment || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, reviewLabel: "Employment · " + String(item.role_title || "Role") + " at " + String(item.employer || "Employer") })),
    ...(data.education || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, reviewLabel: "Education · " + String(item.qualification || "Qualification") + " at " + String(item.institution || "Institution") })),
    ...(data.skills || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, reviewLabel: "Skill · " + String(item.name || "Skill") })),
    ...(data.projects || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, reviewLabel: "Project · " + String(item.title || "Project") })),
    ...(data.publications || []).filter((item: any) => item.verification_status === "needs_review").map((item: any) => ({ ...item, reviewLabel: "Publication · " + String(item.title || "Publication") })),
  ];
  const sourceErrors = (data.sourceDocuments || []).filter((item: any) => item.extraction_error);
  if (!facts.length && !evidence.length && !proposals.length && !pendingRecords.length && !sourceErrors.length) return null;
  const conflicts = proposalConflictSources(proposals);
  function openRecordEditors() {
    const details = document.getElementById("more-profile-details") as HTMLDetailsElement | null;
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  return <section id="profile-review-queue" className="card onboardingCard pendingReviewSection">
    <div className="cardHeader"><div><div className="eyebrow">Review required</div><h2>Check extracted information</h2><p>Nothing here is confirmed until you review it. Compare sources when details differ.</p></div><span className="badge action">{facts.length + evidence.length + proposals.length + pendingRecords.length} to review</span></div>
    {sourceErrors.length ? <div className="errorNotice"><strong>Some documents could not be read:</strong><ul>{sourceErrors.map((source: any) => <li key={source.id}>{source.original_name}: {source.extraction_error} You can remove it and upload a text-based copy or add the information below.</li>)}</ul></div> : null}
    {facts.map((fact: any) => <FactReviewCard key={fact.id} fact={fact} busy={busy} run={run} />)}
    {evidence.map((item: any) => <EvidenceReviewCard key={item.id} item={item} busy={busy} run={run} />)}
    {proposals.map((proposal: any) => <ProposalReviewCard key={proposal.id} proposal={proposal} conflictSources={conflicts.get(String(proposal.id)) || []} busy={busy} run={run} />)}
    {pendingRecords.length ? <div className="memoryStagedWarning"><strong>{pendingRecords.length} profile record{pendingRecords.length === 1 ? "" : "s"} still need review</strong><span>Open More profile details, check each item and save it to confirm. Remove an incorrect item there.</span><ul>{pendingRecords.map((item: any) => <li key={String(item.id) + item.reviewLabel}>{item.reviewLabel}</li>)}</ul><button type="button" className="secondaryButton" disabled={busy} onClick={openRecordEditors}>Review profile records</button></div> : null}
  </section>;
}

function HistorySection({ data, busy, run }: { data: State | null; busy: boolean; run: Run }) {
  const section = useRecordDisclosure();
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

  return <details className="onboardingDetails" open={section.open} onToggle={section.onToggle}><summary>Employment and education <span>{employment.length + education.length} records</span></summary><section className="onboardingSplit">
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
  return <form className="recordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{kind === "employment" ? fields.roleTitle || "Employment record" : fields.qualification || "Education record"}</strong><small>{recordSourceLabel(item)}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/history?id=${item.id}&kind=${kind}`, { method: "DELETE" }))}>Remove</button></div>
    {kind === "employment" ? <div className="formGrid two"><label className={recordFieldClass(fields.employer)}><span>Employer</span><input value={fields.employer} onChange={(event) => setField("employer", event.target.value)} required /></label><label className={recordFieldClass(fields.roleTitle)}><span>Role title</span><input value={fields.roleTitle} onChange={(event) => setField("roleTitle", event.target.value)} required /></label><label className={recordFieldClass(fields.location)}><span>Location</span><input value={fields.location} onChange={(event) => setField("location", event.target.value)} /></label><label className={recordFieldClass(fields.startDate)}><span>Start date</span><input type="date" value={fields.startDate} onChange={(event) => setField("startDate", event.target.value)} /></label><label className={recordFieldClass(fields.current ? "current" : fields.endDate)}><span>End date</span><input type="date" value={fields.endDate} disabled={fields.current} onChange={(event) => setField("endDate", event.target.value)} /></label><label className="checkLabel"><input type="checkbox" checked={fields.current} onChange={(event) => setField("current", event.target.checked)} /> Current role</label><label className={`fullWidth ${recordFieldClass(fields.details)}`}><span>Responsibilities, achievements and key points</span><textarea value={fields.details} rows={4} onChange={(event) => setField("details", event.target.value)} /></label></div> : <div className="formGrid two"><label className={recordFieldClass(fields.institution)}><span>Institution</span><input value={fields.institution} onChange={(event) => setField("institution", event.target.value)} required /></label><label className={recordFieldClass(fields.qualification)}><span>Qualification</span><input value={fields.qualification} onChange={(event) => setField("qualification", event.target.value)} required /></label><label className={recordFieldClass(fields.fieldOfStudy)}><span>Field of study</span><input value={fields.fieldOfStudy} onChange={(event) => setField("fieldOfStudy", event.target.value)} /></label><label className={recordFieldClass(fields.location)}><span>Location</span><input value={fields.location} onChange={(event) => setField("location", event.target.value)} /></label><label className={recordFieldClass(fields.startDate)}><span>Start date</span><input type="date" value={fields.startDate} onChange={(event) => setField("startDate", event.target.value)} /></label><label className={recordFieldClass(fields.current ? "current" : fields.endDate)}><span>End date</span><input type="date" value={fields.endDate} disabled={fields.current} onChange={(event) => setField("endDate", event.target.value)} /></label><label className="checkLabel"><input type="checkbox" checked={fields.current} onChange={(event) => setField("current", event.target.checked)} /> Current study</label><label className={`fullWidth ${recordFieldClass(fields.details)}`}><span>Details</span><textarea value={fields.details} rows={4} onChange={(event) => setField("details", event.target.value)} /></label></div>}
    <div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div>
  </form>;
}

function SkillsSection({ data, busy, run }: { data: State | null; busy: boolean; run: Run }) {
  const section = useRecordDisclosure();
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

  return <details className="onboardingDetails" open={section.open} onToggle={section.onToggle}><summary>Skills and tools <span>{skills.length} records</span></summary><section className="onboardingSingleRecordSection">
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
  return <form className="recordEditor compactRecordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{fields.name || "Skill or tool"}</strong><small>{recordSourceLabel(item)}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/skills?id=${item.id}`, { method: "DELETE" }))}>Remove</button></div><div className="formGrid two"><label className={recordFieldClass(fields.name)}><span>Skill / tool</span><input value={fields.name} onChange={(event) => setField("name", event.target.value)} required /></label><label className={recordFieldClass(fields.category)}><span>Category</span><input value={fields.category} onChange={(event) => setField("category", event.target.value)} /></label><label className={recordFieldClass(fields.proficiency)}><span>Proficiency</span><input value={fields.proficiency} onChange={(event) => setField("proficiency", event.target.value)} /></label><label className={recordFieldClass(fields.yearsExperience)}><span>Years of experience</span><input type="number" min="0" max="80" step="0.5" value={fields.yearsExperience} onChange={(event) => setField("yearsExperience", event.target.value)} /></label></div><div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div></form>;
}

function ProjectsSection({ data, busy, run }: { data: State | null; busy: boolean; run: Run }) {
  const section = useRecordDisclosure();
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

  return <details className="onboardingDetails" open={section.open} onToggle={section.onToggle}><summary>Projects and publications <span>{projects.length + publications.length} records</span></summary><section className="onboardingSplit">
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
  return <form className="recordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{fields.title || "Project"}</strong><small>{recordSourceLabel(item)}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/portfolio?id=${item.id}&kind=project`, { method: "DELETE" }))}>Remove</button></div><div className="formGrid two"><label className={recordFieldClass(fields.title)}><span>Project title</span><input value={fields.title} onChange={(event) => setField("title", event.target.value)} required /></label><label className={recordFieldClass(fields.startDate)}><span>Start date</span><input type="date" value={fields.startDate} onChange={(event) => setField("startDate", event.target.value)} /></label><label className={recordFieldClass(fields.endDate)}><span>End date</span><input type="date" value={fields.endDate} onChange={(event) => setField("endDate", event.target.value)} /></label><label className={recordFieldClass(fields.technologies)}><span>Technologies</span><input value={fields.technologies} onChange={(event) => setField("technologies", event.target.value)} /></label><label className={recordFieldClass(fields.url)}><span>URL</span><input value={fields.url} type="url" onChange={(event) => setField("url", event.target.value)} /></label><label className={`fullWidth ${recordFieldClass(fields.description)}`}><span>Description</span><textarea value={fields.description} rows={4} onChange={(event) => setField("description", event.target.value)} /></label></div><div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div></form>;
}

function PublicationEditor({ item, busy, run }: { item: any; busy: boolean; run: Run }) {
  const [fields, setFields] = useState({ title: item.title || "", publicationType: item.publication_type || "publication", venue: item.venue || "", publishedOn: item.published_on || "", url: item.url || "", citation: item.citation || "" });
  const setField = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); await run(() => api("/api/onboarding/portfolio", { method: "POST", body: JSON.stringify({ id: item.id, kind: "publication", ...fields }) })); };
  return <form className="recordEditor" onSubmit={(event) => void save(event)}><div className="recordEditorHeader"><div><strong>{fields.title || "Publication"}</strong><small>{recordSourceLabel(item)}</small></div><button type="button" className="textButton" disabled={busy} onClick={() => void run(() => api(`/api/onboarding/portfolio?id=${item.id}&kind=publication`, { method: "DELETE" }))}>Remove</button></div><div className="formGrid two"><label className={recordFieldClass(fields.title)}><span>Title</span><input value={fields.title} onChange={(event) => setField("title", event.target.value)} required /></label><label className={recordFieldClass(fields.publicationType)}><span>Publication type</span><input value={fields.publicationType} onChange={(event) => setField("publicationType", event.target.value)} /></label><label className={recordFieldClass(fields.venue)}><span>Venue / publisher</span><input value={fields.venue} onChange={(event) => setField("venue", event.target.value)} /></label><label className={recordFieldClass(fields.publishedOn)}><span>Published date</span><input type="date" value={fields.publishedOn} onChange={(event) => setField("publishedOn", event.target.value)} /></label><label className={recordFieldClass(fields.url)}><span>URL</span><input type="url" value={fields.url} onChange={(event) => setField("url", event.target.value)} /></label><label className={`fullWidth ${recordFieldClass(fields.citation)}`}><span>Citation</span><textarea value={fields.citation} rows={4} onChange={(event) => setField("citation", event.target.value)} /></label></div><div className="recordEditorActions"><button className="secondaryButton" disabled={busy}>Save changes</button></div></form>;
}

function MemoryUpdateCard({ memory, busy, run, message, onMessage, onMemoryChanged, hasUnsavedProfileChanges, savePendingProfile }: { memory: any; busy: boolean; run: Run; message: string | null; onMessage: (message: string) => void; onMemoryChanged: (memory: any) => void; hasUnsavedProfileChanges: boolean; savePendingProfile: () => Promise<void> }) {
  const actionInFlightRef = useRef(false);
  const chatgptOperation = useChatGptOperation();
  const updateDispatchIds = Array.isArray(memory?.updateDispatchIds)
    ? memory.updateDispatchIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    : [];
  const updateDispatchId = updateDispatchIds[0] || null;
  const liveStatus = useDispatchStatus(updateDispatchId, memory?.updateStatus ? { state: memory.updateStatus } : undefined);
  useEffect(() => {
    if (!updateDispatchId || !["queued", "in_progress"].includes(String(memory?.updateStatus || ""))) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch("/api/onboarding/memory", { cache: "no-store" });
        const data = await readApiResponse(response, "Unable to refresh ChatGPT Memory status");
        if (!cancelled && data.memory) onMemoryChanged(data.memory);
      } catch {
        // The shared dispatch poller remains authoritative if this aggregate
        // lifecycle refresh is temporarily unavailable.
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1800);
    };
    timer = window.setTimeout(() => void poll(), 1800);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [memory?.updateStatus, onMemoryChanged, updateDispatchId]);
  if (!memory?.confirmed && !memory?.memorySyncEnabled) return null;

  const aggregateState = String(memory?.updateStatus || "not_requested");
  const importActive = ["queued", "in_progress"].includes(String(memory?.importStatus || ""));
  const observedState = String(liveStatus.state || "");
  const activeStates = ["queued", "in_progress", "claimed_by_extension", "opening_chatgpt", "composer_ready", "send_attempted", "sent", "acknowledged_by_mcp", "running"];
  // The API tracks every ordered part, while the shared poller tracks only the
  // first dispatch used to wake this card. If that first part completes while
  // a later part is still queued, keep the aggregate active state authoritative
  // so the user cannot create a new update in the middle of the sequence.
  const updateActive = importActive || activeStates.includes(aggregateState) || activeStates.includes(observedState);
  const updateState = importActive
    ? "initial_import"
    : updateActive
    ? (activeStates.includes(aggregateState) ? aggregateState : observedState)
    : (observedState || aggregateState);
  const updateCompleted = !updateActive && (updateState === "completed" || aggregateState === "completed");
  const retryAllowed = memory?.updateRetryAllowed === true || liveStatus.dispatch?.raw?.retry_allowed === true;
  const manualReviewRequired = memory?.updateManualReviewRequired === true || liveStatus.dispatch?.raw?.manual_review_required === true;
  const stateLabel = liveStatus.dispatch || updateState !== "not_requested"
    ? dispatchStateLabel(updateState, liveStatus.dispatch?.raw)
    : null;
  const waitingForChatGpt = isWaitingForChatGpt({ state: liveStatus.state || aggregateState, raw: liveStatus.dispatch?.raw });

  async function sendUpdate() {
    if (hasUnsavedProfileChanges) await savePendingProfile();
    const result = await api("/api/onboarding/memory", {
      method: "POST",
      body: JSON.stringify({ action: "sync_confirmed_profile" }),
    });
    onMemoryChanged(result.memory);
    notifyBridgeHints(result.bridge_hints || result.bridge_hint);
    const dispatchCount = Array.isArray(result.dispatches) ? result.dispatches.length : 1;
    const state = String(result.memory?.updateStatus || result.dispatch?.state || "queued");
    onMessage(state === "completed"
      ? "These corrected details were already sent to ChatGPT Memory; no duplicate message was created."
      : state === "failed"
        ? "ChatGPT has not received these corrected details. Retry is safe when the option appears."
        : state === "user_required"
          ? "This update needs your attention. Review the bound Professional background ChatGPT conversation before retrying."
          : `Your new and corrected profile details were queued as ${dispatchCount} update${dispatchCount === 1 ? "" : "s"}. This page will show when ChatGPT confirms delivery.`);
  }

  async function retryUpdate() {
    const result = await api("/api/onboarding/memory", {
      method: "POST",
      body: JSON.stringify({ action: "retry_confirmed_profile" }),
    });
    onMemoryChanged(result.memory);
    notifyBridgeHints(result.bridge_hints || result.bridge_hint);
    const state = String(result.memory?.updateStatus || result.dispatch?.state || "queued");
    onMessage(state === "completed"
      ? "These corrected details were already confirmed in ChatGPT Memory; no duplicate message was created."
        : "The correction update was safely re-queued. The original message will not be sent twice.");
  }

  async function runUpdateAction(operation: () => Promise<void>) {
    if (actionInFlightRef.current) return;
    const operationToken = chatgptOperation.beginLocalOperation("Sync profile with ChatGPT Memory");
    if (!operationToken) {
      onMessage(chatgptOperation.message || "Another ChatGPT task is already active.");
      return;
    }
    actionInFlightRef.current = true;
    try {
      await run(operation);
    } finally {
      actionInFlightRef.current = false;
      chatgptOperation.finishLocalOperation(operationToken);
    }
  }

  return <section id="memory-update" className="card onboardingCard memoryUpdateCard"><div className="cardHeader"><div><div className="eyebrow">Step 4</div><h2>Sync your changes</h2><p>Send only the details you changed after reviewing your profile.</p></div></div>
    {hasUnsavedProfileChanges ? <div className="memoryStagedWarning"><strong>Unsaved edits</strong><span>They will be saved before sending.</span></div> : null}
    {importActive ? <div className="memoryStagedWarning"><strong>Profile import in progress</strong><span>You can sync changes when it finishes.</span></div> : null}
    <div className="buttonRow"><button className="primaryButton" type="button" disabled={busy || chatgptOperation.blocked || updateActive} onClick={() => void runUpdateAction(sendUpdate)}>{waitingForChatGpt ? <><span className="chatgptActivitySpinner" aria-hidden="true" /> ChatGPT is updating your profile…</> : busy ? (hasUnsavedProfileChanges ? "Saving…" : "Queueing…") : importActive ? "Waiting for initial profile import…" : updateActive ? "Waiting for ChatGPT…" : "Update ChatGPT with my profile changes"}</button></div>
    {updateState !== "not_requested" ? <div className="memoryUpdateStatus"><span className="formHint">ChatGPT update: {stateLabel || updateState}</span>{memory?.updateError ? <span className="formError">{memory.updateError}</span> : null}{retryAllowed && !manualReviewRequired ? <button className="secondaryButton" type="button" disabled={busy || chatgptOperation.blocked || hasUnsavedProfileChanges} onClick={() => void runUpdateAction(retryUpdate)}>Retry safely</button> : null}{manualReviewRequired ? <span className="formError">Review the Professional background ChatGPT conversation before retrying; the system will not resend automatically.</span> : null}{updateCompleted ? <span className="formHint">ChatGPT confirmed the update.</span> : null}</div> : null}
    {message ? <div className="notice">{message}</div> : null}
    {liveStatus.error ? <div className="formError">{liveStatus.error}</div> : null}
  </section>;
}
