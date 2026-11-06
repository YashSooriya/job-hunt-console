const MAX_WEBSITE_INSTRUCTION_CHARS = 6000;

type Preferences = Record<string, any>;

export type JobPoolPromptSnapshot = {
  publicationId: string;
  revision: number;
  rowCount: number;
  dataUrl: string;
  dataSheetTitle: string;
  manifestUrl: string;
  manifestSheetTitle: string;
};

function list(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function line(label: string, value: unknown) {
  let values: string;
  if (Array.isArray(value)) {
    const items = list(value);
    values = items.slice(0, 15).map((item) => item.slice(0, 120)).join(", ");
    if (items.length > 15) values += " …[additional values omitted]";
  } else {
    const raw = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
    values = raw.length > 700 ? `${raw.slice(0, 680).trimEnd()} …[truncated]` : raw;
  }
  return `${label}: ${values || "not specified"}`;
}

function compact(value: string, maximum: number) {
  if (value.length > maximum) throw new Error(`The search instruction is ${value.length - maximum} characters over the Website Bridge limit. Shorten optional preferences and try again.`);
  return value;
}

function modeGuidance(preferences: Preferences) {
  if (preferences.search_mode === "profile") {
    return "Role discovery: Memory-fit. Infer suitable role titles, role families, seniority and relevant industries only from what you already remember about the user in ChatGPT Memory. The app supplies no profile or background facts. Use only explicit work-authorisation facts already in Memory and never infer legal eligibility. Do not infer or change the user's locations, commute limit, work modes, salary constraints, sponsorship requirement, any excluded role, company, keyword or industry, posting-age limit, fit threshold or preparation threshold.";
  }
  if (preferences.search_mode === "keywords") {
    return "Role discovery: keywords only. Use the user-supplied role keywords and families; do not broaden them using ChatGPT Memory unless the user explicitly requests that in Other preferences.";
  }
  return "Role discovery: keywords plus Memory-fit. Start with the user-supplied role keywords and families, then use only ChatGPT Memory to identify related roles and assess fit. The app supplies no profile or background facts; preserve every user-set hard constraint.";
}

function cadenceGuidance(cadence: string) {
  switch (cadence) {
    case "weekdays": return "Cadence: the app schedules one search on each weekday at the saved local time and timezone.";
    case "weekly": return "Cadence: the app schedules one search each Monday at the saved local time and timezone.";
    case "manual": return "Cadence: manual only. Do not create, disable, or alter a recurring task; run only this one bounded search.";
    default: return "Cadence: the app schedules one search every day at the saved local time and timezone.";
  }
}

function settingsLines(preferences: Preferences, sourceLabels: string[] = []) {
  const mode = typeof preferences.search_mode === "string" ? preferences.search_mode : "keywords_and_profile";
  const salary = preferences.salary && typeof preferences.salary === "object" ? preferences.salary : {};
  const postingAge = preferences.posting_age_policy && typeof preferences.posting_age_policy === "object" ? preferences.posting_age_policy.max_days : "";
  return [
    modeGuidance({ ...preferences, search_mode: mode }),
    "User-controlled settings (preserve these hard constraints exactly):",
    line("Role keywords", mode === "profile" ? [] : preferences.target_roles),
    line("Role families", mode === "profile" ? [] : preferences.role_families),
    line("Target seniority", mode === "profile" ? "" : preferences.target_seniority),
    line("Preferred locations", preferences.locations),
    line("Maximum commute (minutes)", preferences.max_commute_minutes),
    line("Work authorisation", "Use only explicit countries and requirements already in ChatGPT Memory; do not infer legal eligibility"),
    line("Enabled discovery sources", sourceLabels),
    line("Automatic schedule", preferences.search_schedule_enabled === false || preferences.search_cadence === "manual" ? "paused" : "enabled"),
    line("Schedule local time", preferences.search_time_local || "09:00"),
    line("Schedule timezone", preferences.search_timezone || "Europe/London"),
    line("Preferred industries", mode === "profile" ? "" : preferences.preferred_industries),
    line("Excluded industries", preferences.excluded_industries),
    line("Excluded roles", preferences.excluded_roles),
    line("Excluded companies", preferences.excluded_companies),
    line("Excluded keywords", preferences.excluded_keywords),
    line("Work modes", preferences.work_modes),
    line("Posting age limit (days)", postingAge),
    line("Salary floor", salary.minimum),
    line("Salary target", salary.target),
    line("Salary currency", salary.currency),
    line("Minimum fit score (0-10)", preferences.min_fit_score_10 ?? (Number(preferences.min_fit_threshold || 60) / 10)),
    line("Auto-prepare threshold (0-100)", preferences.auto_prepare_threshold),
    line("Sponsorship required", preferences.sponsorship_required ? "yes" : "no"),
    line("Other preferences", preferences.notes),
  ];
}

export function buildJobSearchConfigurationPrompt(preferences: Preferences, maxLength = MAX_WEBSITE_INSTRUCTION_CHARS, sourceLabels: string[] = [], poolSnapshot?: JobPoolPromptSnapshot) {
  const cadence = typeof preferences.search_cadence === "string" ? preferences.search_cadence : "daily";
  const prompt = [
    "Confirm the job-search setup below for searches initiated by this app. The app stores and runs the selected cadence; this message does not ask you to create or change a ChatGPT Task.",
    cadenceGuidance(cadence),
    "For profile fit, rely only on what you already know about the user in ChatGPT Memory; the app sends no profile facts, candidate records, profile IDs, CV contents, or profile-derived hashes after onboarding. If Memory is incomplete, do not guess and report that fit needs the user's review. Search public vacancies from the enabled sources, deduplicate known listings, preserve source URLs, classify industry only when supported, and distinguish advertised salary from an estimate. Never sign in, apply, contact employers, or make an external commitment. Confirm these settings and identify any missing prerequisite; do not claim an app schedule was created by ChatGPT.",
    ...(poolSnapshot ? [
      `The app maintains one current, read-only Google Sheets mirror of its authoritative job pool. At each actual search, read the active rows and manifest from ${poolSnapshot.dataUrl} and ${poolSnapshot.manifestUrl}; this configuration message does not contain the job rows. Current publication ${poolSnapshot.publicationId}, revision ${poolSnapshot.revision}, ${poolSnapshot.rowCount} active job rows. Do not modify either tab.`,
    ] : []),
    ...settingsLines(preferences, sourceLabels),
  ].join("\n");
  return compact(prompt, maxLength);
}

export function buildManualJobSearchPrompt(preferences: Preferences, runId: string, maxLength = MAX_WEBSITE_INSTRUCTION_CHARS, sourceLabels: string[] = [], poolSnapshot?: JobPoolPromptSnapshot) {
  const poolProof = poolSnapshot ? `Before searching, use the connected Google Drive integration to open the exact Job Pool Sheet data tab ${poolSnapshot.dataUrl} (tab ${poolSnapshot.dataSheetTitle}) and manifest tab ${poolSnapshot.manifestUrl} (tab ${poolSnapshot.manifestSheetTitle}). Read every active data row, not only a search snippet or a sample. Use job IDs, links and user status to avoid duplicates and avoid jobs already applied to or closed. The mirror is read-only; never edit it. The expected publication id is ${poolSnapshot.publicationId}, revision ${poolSnapshot.revision}, with ${poolSnapshot.rowCount} active data rows. Read the access_check_token from the manifest; it is deliberately not included in this instruction. If the Sheet cannot be opened, the token cannot be read, or rows_read is not exactly ${poolSnapshot.rowCount}, return no job results and state that the Sheet could not be fully verified. Do not guess any of these values.` : "";
  const envelope = poolSnapshot
    ? `{"run_id":"${runId}","job_pool_snapshot":{"publication_id":"${poolSnapshot.publicationId}","revision":${poolSnapshot.revision},"access_check_token":"<exact token read from manifest>","rows_read":${poolSnapshot.rowCount}},"jobs_checked":0,"summary":"short outcome","results":[]}`
    : `{"run_id":"${runId}","jobs_checked":0,"summary":"short outcome","results":[]}`;
  const prompt = [
    "Run one bounded, read-only job search now. This is a one-time search, not a scheduled task.",
    "Do not create, update, or alter any ChatGPT Task or recurring schedule. Do not apply, sign in, contact employers, send messages, or make external commitments.",
    poolProof,
    "Search reliable public vacancy sources and inspect each listing before including it. Return no more than 10 distinct jobs. Preserve the exact public listing URL, use advertised salary when stated, and label any estimate with confidence and evidence. Do not invent missing facts. For profile fit, rely only on ChatGPT Memory; the app supplies no candidate profile or background after onboarding. Use only explicit work-authorisation facts already in Memory and never infer legal eligibility. If Memory lacks enough relevant facts, report fit as unknown rather than guessing. Do not change the user's saved location, commute limit, work-mode, salary, sponsorship, excluded-role, excluded-company, excluded-keyword, excluded-industry, or posting-age settings.",
    `This search's run_id is ${runId}. Return exactly one valid JSON object, with no markdown or surrounding prose, in this schema:`,
    envelope.replace('"results":[]}', '"results":[{"status":"found","source_url":"https://example.com/careers/job","job":{"company":"…","title":"…","industry":null,"description":"…","application_url":null,"external_job_id":null,"location":null,"work_mode":null,"salary_text":null,"salary_min":null,"salary_max":null,"salary_currency":"GBP","salary_source":"not_available","salary_confidence":null,"salary_basis":[],"posted_at":null,"closes_at":null,"employment_type":null,"ats_provider":null,"summary":null,"responsibilities":[],"essential_requirements":[],"desirable_requirements":[],"skills":[],"benefits":[],"application_instructions":null,"company_website":null,"raw_metadata":{}}},{"status":"unavailable","source_url":null,"reason":"brief reason"}]}'),
    poolSnapshot ? "Use only the envelope and result keys shown, including exactly one job_pool_snapshot proof object. Its access_check_token must be read from the manifest; rows_read must equal the manifest row_count and the expected active row count. Each found job needs a meaningful description and a complete HTTP(S) source_url. salary_source must be exactly advertised, chatgpt_estimate, or not_available. For advertised salary use values stated by the employer; for a clearly labelled estimate provide salary_basis; otherwise use not_available. Results may be empty when no suitable current listings can be verified. jobs_checked counts distinct new public listings reviewed, not existing Sheet rows or returned jobs." : "Use only the keys shown. Each found job needs a meaningful description and a complete HTTP(S) source_url. salary_source must be exactly advertised, chatgpt_estimate, or not_available. For advertised salary use values stated by the employer; for a clearly labelled estimate provide salary_basis; otherwise use not_available. Results may be an empty array when no suitable current listings can be verified. jobs_checked is the number of distinct listings reviewed, not the number returned.",
    ...settingsLines(preferences, sourceLabels),
  ].join("\n");
  return compact(prompt, maxLength);
}
