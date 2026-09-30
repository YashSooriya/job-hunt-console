"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { readApiResponse } from "@/lib/onboarding/client-api";
import { dispatchStateLabel } from "@/lib/chatgpt-bridge/client";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";

type Preferences = Record<string, any>;

function value(preferences: Preferences, field: string) {
  if (field === "salary_minimum") return preferences.salary?.minimum ?? preferences.salary_minimum ?? "";
  if (field === "salary_target") return preferences.salary?.target ?? preferences.salary_target ?? "";
  if (field === "salary_currency") return preferences.salary?.currency ?? preferences.salary_currency ?? "";
  if (field === "posting_age_days") return preferences.posting_age_policy?.max_days ?? preferences.posting_age_days ?? "";
  if (field === "min_fit_score_10") return preferences.min_fit_score_10 ?? (preferences.min_fit_threshold ? Number(preferences.min_fit_threshold) / 10 : "");
  return preferences[field] ?? "";
}

function fieldClass(preferences: Preferences, field: string) {
  const current = value(preferences, field);
  const filled = current !== null && current !== undefined && current !== "" && (!Array.isArray(current) || current.length > 0);
  return filled ? "profileField" : "profileField needsUserInput";
}

function csv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function idempotencyKey() {
  return `jobs.search.configure:${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`}`;
}

export function JobSearchPreferences() {
  const [preferences, setPreferences] = useState<Preferences>({});
  const [searchMode, setSearchMode] = useState("keywords_and_profile");
  const [searchCadence, setSearchCadence] = useState("daily");
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const pendingSetupKey = useRef<string | null>(null);
  const dispatchStatus = useDispatchStatus(dispatchId);
  const chatgptOperation = useChatGptOperation();
  const waitingForChatGpt = isWaitingForChatGpt({ state: dispatchStatus.state || undefined, raw: dispatchStatus.dispatch?.raw });

  const load = useCallback(async () => {
    const response = await fetch("/api/search/preferences", { cache: "no-store" });
    const data = await readApiResponse(response, "Job-search preferences are unavailable");
    setPreferences(data.preferences || {});
    setSearchMode(typeof data.preferences?.search_mode === "string" ? data.preferences.search_mode : "keywords_and_profile");
    const cadence = typeof data.preferences?.search_cadence === "string" ? data.preferences.search_cadence : "daily";
    setSearchCadence(cadence);
    setScheduleEnabled(cadence !== "manual" && data.preferences?.search_schedule_enabled !== false);
  }, []);

  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "Job-search preferences are unavailable.")); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const operationToken = chatgptOperation.beginLocalOperation("Save job-search preferences");
    if (!operationToken) { setError(chatgptOperation.message || "Another ChatGPT task is already active."); return; }
    setBusy(true); setError(null); setSetupError(null); setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const profileMode = form.get("searchMode") === "profile";
      const cadence = String(form.get("searchCadence") || "daily");
      if (!pendingSetupKey.current) pendingSetupKey.current = idempotencyKey();
      const response = await fetch("/api/search/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          searchMode: form.get("searchMode"),
          locations: csv(String(form.get("locations") || "")),
          // Preserve values that are temporarily hidden in profile-led mode;
          // the server-side prompt builder deliberately excludes them there.
          targetRoles: profileMode ? preferences.target_roles || [] : csv(String(form.get("targetRoles") || "")),
          roleFamilies: profileMode ? preferences.role_families || [] : csv(String(form.get("roleFamilies") || "")),
          targetSeniority: profileMode ? preferences.target_seniority || "" : form.get("targetSeniority"),
          preferredIndustries: profileMode ? preferences.preferred_industries || [] : csv(String(form.get("preferredIndustries") || "")),
          excludedIndustries: csv(String(form.get("excludedIndustries") || "")),
          workModes: form.getAll("workModes"),
          salaryMinimum: form.get("salaryMinimum"),
          salaryTarget: form.get("salaryTarget"),
          salaryCurrency: form.get("salaryCurrency"),
          sponsorshipRequired: form.get("sponsorshipRequired") === "on",
          postingAgeDays: form.get("postingAgeDays"),
          minFitScore10: form.get("minFitScore10"),
          autoPrepareThreshold: form.get("autoPrepareThreshold"),
          searchCadence: cadence,
          scheduleEnabled: cadence !== "manual" && form.get("scheduleEnabled") === "on",
          searchTimeLocal: form.get("searchTimeLocal"),
          searchTimezone: form.get("searchTimezone"),
          notes: form.get("notes"),
          dispatchIdempotencyKey: pendingSetupKey.current,
        }),
      });
      const data = await readApiResponse(response, "Unable to save job-search preferences");
      setPreferences(data.preferences || {});
      setSearchMode(data.preferences?.search_mode || "keywords_and_profile");
      setSearchCadence(data.preferences?.search_cadence || cadence);
      setScheduleEnabled(data.preferences?.search_schedule_enabled === true);
      const dispatch = data.dispatch && typeof data.dispatch === "object" ? data.dispatch as Record<string, unknown> : null;
      if (data.bridge_hint) notifyBridgeHint(data.bridge_hint);
      if (dispatch && typeof dispatch.id === "string") {
        setDispatchId(dispatch.id);
        pendingSetupKey.current = null;
      }
      if (typeof data.setupError === "string") {
        setSetupError(data.setupError);
        setMessage("Preferences and schedule were saved. ChatGPT setup still needs to be queued; save again to retry.");
      } else {
        setMessage(dispatch ? "Preferences and schedule saved; ChatGPT is updating your search setup." : "Job-search preferences and schedule saved.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save job-search preferences.");
    } finally {
      setBusy(false);
      chatgptOperation.finishLocalOperation(operationToken);
    }
  }

  return <section className="card jobPreferencesCard">
    <div className="cardHeader"><div><h2>Job-search preferences</h2><p>Choose the roles, locations, pay and search frequency that suit you.</p></div></div>
    <form key={JSON.stringify(preferences)} className="onboardingForm" onSubmit={(event) => void save(event)}>
      <label className={fieldClass(preferences, "search_mode")}><span>Role discovery mode</span><select name="searchMode" value={searchMode} onChange={(event) => setSearchMode(event.target.value)}><option value="keywords_and_profile">Use keywords and my profile</option><option value="keywords">Use my keywords only</option><option value="profile">Let ChatGPT discover profile-fit roles</option></select></label>
      <div className="formGrid two">
        {searchMode !== "profile" ? <>
          <label className={fieldClass(preferences, "target_roles")}><span>Target role keywords</span><input name="targetRoles" required defaultValue={(preferences.target_roles || []).join(", ")} placeholder="e.g. Data Analyst, Project Manager" /></label>
          <label className={fieldClass(preferences, "role_families")}><span>Role families</span><input name="roleFamilies" required defaultValue={(preferences.role_families || []).join(", ")} placeholder="e.g. Engineering, Finance, Marketing" /></label>
          <label className={fieldClass(preferences, "target_seniority")}><span>Target seniority</span><input name="targetSeniority" required defaultValue={preferences.target_seniority || ""} placeholder="e.g. Entry-level, mid-level, senior" /></label>
        </> : null}
        <label className={fieldClass(preferences, "locations")}><span>Preferred locations</span><input name="locations" required defaultValue={(preferences.locations || []).join(", ")} placeholder="e.g. City, country or Remote" /></label>
        <label className={fieldClass(preferences, "salary_minimum")}><span>Salary floor</span><input name="salaryMinimum" type="number" min="0" step="1" inputMode="decimal" defaultValue={value(preferences, "salary_minimum")} placeholder="e.g. 50000" /></label>
        <label className={fieldClass(preferences, "salary_target")}><span>Salary target</span><input name="salaryTarget" type="number" min="0" step="1" inputMode="decimal" defaultValue={value(preferences, "salary_target")} placeholder="e.g. 70000" /></label>
        <label className={fieldClass(preferences, "salary_currency")}><span>Salary currency</span><input name="salaryCurrency" maxLength={10} defaultValue={value(preferences, "salary_currency") || "GBP"} placeholder="e.g. GBP" /></label>
      </div>
      <div className={`checkRow ${fieldClass(preferences, "work_modes")}`}><label><input type="checkbox" name="workModes" value="onsite" defaultChecked={(preferences.work_modes || []).includes("onsite")} /> On-site</label><label><input type="checkbox" name="workModes" value="hybrid" defaultChecked={(preferences.work_modes || []).includes("hybrid")} /> Hybrid</label><label><input type="checkbox" name="workModes" value="remote" defaultChecked={(preferences.work_modes || []).includes("remote")} /> Remote</label></div>
      <label className={fieldClass(preferences, "search_cadence")}><span>Search frequency</span><select name="searchCadence" value={searchCadence} onChange={(event) => setSearchCadence(event.target.value)}><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="manual">Manual only</option></select></label>
      <details className="searchPreferenceAdvanced">
        <summary>More search options</summary>
        <div className="formGrid two">
          {searchMode !== "profile" ? <label className={fieldClass(preferences, "preferred_industries")}><span>Preferred industries</span><input name="preferredIndustries" defaultValue={(preferences.preferred_industries || []).join(", ")} /></label> : null}
          <label className={fieldClass(preferences, "excluded_industries")}><span>Industries to exclude</span><input name="excludedIndustries" defaultValue={(preferences.excluded_industries || []).join(", ")} /></label>
          <label className={fieldClass(preferences, "posting_age_days")}><span>Maximum posting age (days)</span><input name="postingAgeDays" type="number" min="1" max="90" step="1" defaultValue={value(preferences, "posting_age_days") || 30} /></label>
          <label className={fieldClass(preferences, "min_fit_score_10")}><span>Minimum fit score (0–10)</span><input name="minFitScore10" type="number" min="0" max="10" step="0.1" defaultValue={value(preferences, "min_fit_score_10") || 6} /></label>
          <label className={fieldClass(preferences, "auto_prepare_threshold")}><span>Auto-prepare threshold (0–100)</span><input name="autoPrepareThreshold" type="number" min="0" max="100" step="1" defaultValue={value(preferences, "auto_prepare_threshold") || 80} /></label>
          <label className={fieldClass(preferences, "search_time_local")}><span>Search time</span><input name="searchTimeLocal" type="time" defaultValue={preferences.search_time_local || "09:00"} required /></label>
          <label className={fieldClass(preferences, "search_timezone")}><span>Timezone</span><input name="searchTimezone" defaultValue={preferences.search_timezone || (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Europe/London")} maxLength={80} required placeholder="Europe/London" /></label>
        </div>
        <label className={`checkLabel ${fieldClass(preferences, "sponsorship_required")}`}><input type="checkbox" name="sponsorshipRequired" defaultChecked={Boolean(preferences.sponsorship_required)} /> I require sponsorship</label>
        <label className={`checkLabel ${fieldClass(preferences, "search_schedule_enabled")}`}><input type="checkbox" name="scheduleEnabled" checked={searchCadence !== "manual" && scheduleEnabled} disabled={searchCadence === "manual"} onChange={(event) => setScheduleEnabled(event.target.checked)} /> Run searches automatically</label>
        <label className={fieldClass(preferences, "notes")}><span>Other preferences</span><textarea name="notes" rows={3} defaultValue={preferences.notes || ""} /></label>
      </details>
      <button className="primaryButton" disabled={busy || chatgptOperation.blocked}>{waitingForChatGpt ? <><span className="chatgptActivitySpinner" aria-hidden="true" /> ChatGPT is setting up your search…</> : busy ? "Saving…" : "Save job-search preferences"}</button>
    </form>
    {message ? <div className="notice">{message}</div> : null}{setupError ? <div className="notice warningNotice">{setupError}</div> : null}{error ? <div className="formError">{error}</div> : null}
    {dispatchStatus.dispatch ? <div className="syncMessage"><strong>ChatGPT setup: {dispatchStateLabel(dispatchStatus.state || "queued", dispatchStatus.dispatch.raw)}</strong>{dispatchStatus.response ? <pre className="commandBlock">{dispatchStatus.response}</pre> : waitingForChatGpt ? <span><span className="chatgptActivitySpinner" aria-hidden="true" /> Waiting for ChatGPT’s response…</span> : <span>Waiting for ChatGPT to pick up your request.</span>}{dispatchStatus.error ? <span>{dispatchStatus.error}</span> : null}</div> : null}
  </section>;
}
