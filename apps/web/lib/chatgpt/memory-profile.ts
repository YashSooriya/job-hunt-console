import { cleanUrlValue, cleanUrlList } from "@/lib/onboarding/value-format";

type JsonRecord = Record<string, unknown>;

export type StructuredMemoryQuestion = {
  field: string;
  question: string;
  required: boolean;
  inputType: string;
};

export type ParsedMemoryInterview = {
  profile: JsonRecord;
  questions: StructuredMemoryQuestion[];
  conflicts: Array<{ field: string; details: string }>;
  profileSummary: string;
};

const SCALAR_FIELDS = [
  "first_name", "surname", "date_of_birth", "email", "phone", "location", "citizenship",
  "work_authorisation", "right_to_work_countries", "visa_status", "visa_expiry",
  "sponsorship_requirement", "notice_period", "current_salary", "salary_currency",
  "salary_expectation", "availability_date", "linkedin_url", "languages", "portfolio_links", "certifications",
] as const;

function text(value: unknown, maximum = 2000) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
}

function dateValue(value: unknown) {
  const result = text(value, 20);
  return result && /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function booleanValue(value: unknown) {
  return value === true || value === "true" || value === 1;
}

function numberValue(value: unknown) {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
}

function list(value: unknown, maximum = 40) {
  if (Array.isArray(value)) {
    return value
      .map((item) => text(item, 500))
      .filter((item): item is string => Boolean(item))
      .slice(0, maximum);
  }
  const single = text(value, 500);
  return single ? single.split(/[,;|]/).map((item) => item.trim()).filter(Boolean).slice(0, maximum) : [];
}

function records(value: unknown, maximum = 80) {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)).slice(0, maximum)
    : [];
}

function firstArray(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function normaliseEmployment(value: unknown) {
  return records(value).map((item) => ({
    company_name: text(item.company_name || item.employer || item.company, 300),
    job_title: text(item.job_title || item.role_title || item.title, 300),
    start_date: dateValue(item.start_date || item.startDate),
    end_date: dateValue(item.end_date || item.endDate),
    current: booleanValue(item.current),
    location: text(item.location, 300),
    key_points: list(item.key_points || item.keyPoints || item.achievements || item.responsibilities, 30),
    details: text(item.details || item.detail || item.description, 5000),
  })).filter((item) => item.company_name && item.job_title);
}

function normaliseEducation(value: unknown) {
  return records(value).map((item) => ({
    institution: text(item.institution || item.school || item.university, 300),
    qualification: text(item.qualification || item.degree || item.award, 300),
    field_of_study: text(item.field_of_study || item.fieldOfStudy || item.subject, 300),
    start_date: dateValue(item.start_date || item.startDate),
    end_date: dateValue(item.end_date || item.endDate),
    current: booleanValue(item.current),
    location: text(item.location, 300),
    key_points: list(item.key_points || item.keyPoints || item.details, 20),
    details: text(item.details || item.detail || item.description, 5000),
  })).filter((item) => item.institution && item.qualification);
}

function normaliseSkills(value: unknown) {
  return records(value).map((item) => ({
    name: text(item.name || item.skill || item.tool, 200),
    category: text(item.category, 100) || "skill",
    proficiency: text(item.proficiency || item.level, 100),
    years_experience: numberValue(item.years_experience ?? item.yearsExperience),
  })).filter((item) => item.name);
}

function normaliseProjects(value: unknown) {
  return records(value).map((item) => ({
    title: text(item.title || item.name, 500),
    description: text(item.description || item.details || item.detail, 5000),
    technologies: list(item.technologies || item.tools, 30),
    start_date: dateValue(item.start_date || item.startDate),
    end_date: dateValue(item.end_date || item.endDate),
    url: cleanUrlValue(item.url || item.link),
  })).filter((item) => item.title);
}

function normalisePublications(value: unknown) {
  return records(value).map((item) => ({
    title: text(item.title || item.name, 1000),
    publication_type: text(item.publication_type || item.publicationType || item.type, 100) || "publication",
    venue: text(item.venue || item.publisher, 500),
    published_on: dateValue(item.published_on || item.publishedOn || item.date),
    url: cleanUrlValue(item.url || item.link),
    citation: text(item.citation || item.details || item.detail, 5000),
  })).filter((item) => item.title);
}

function normaliseCertifications(value: unknown) {
  return records(value).map((item) => ({
    name: text(item.name || item.title || item.certification, 500),
    issuer: text(item.issuer || item.provider, 500),
    date: dateValue(item.date || item.issued_on || item.issuedOn),
    details: text(item.details || item.detail, 2000),
  })).filter((item) => item.name);
}

function normaliseLanguages(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean) : [];
  return values.map((item) => {
    if (typeof item === "string") return { language: item.trim().slice(0, 100), proficiency: null };
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as JsonRecord;
    return {
      language: text(record.language || record.name, 100),
      proficiency: text(record.proficiency || record.level, 100),
    };
  }).filter((item): item is { language: string; proficiency: string | null } => Boolean(item?.language)).slice(0, 30);
}

function normalisePortfolioLinks(value: unknown) {
  const links = cleanUrlList(value);
  if (links.length) return links.map((url) => ({ label: null, url }));
  return records(value).map((item) => ({
    label: text(item.label || item.name || item.title, 200),
    url: cleanUrlValue(item.url || item.link),
  })).filter((item) => item.url).slice(0, 30);
}

function normaliseJobSearch(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const item = value as JsonRecord;
  return {
    search_mode: text(item.search_mode || item.searchMode, 40),
    target_roles: list(item.target_roles || item.targetRoles, 30),
    role_families: list(item.role_families || item.roleFamilies, 20),
    target_seniority: text(item.target_seniority || item.targetSeniority, 100),
    preferred_industries: list(item.preferred_industries || item.preferredIndustries, 30),
    excluded_industries: list(item.excluded_industries || item.excludedIndustries, 30),
    locations: list(item.locations || item.preferred_locations || item.preferredLocations, 20),
    work_modes: list(item.work_modes || item.workModes, 3),
    max_commute_minutes: numberValue(item.max_commute_minutes ?? item.maxCommuteMinutes),
    salary_minimum: numberValue(item.salary_minimum ?? item.salaryMinimum),
    salary_target: numberValue(item.salary_target ?? item.salaryTarget),
    salary_currency: text(item.salary_currency || item.salaryCurrency, 20),
    sponsorship_required: item.sponsorship_required === true || item.sponsorshipRequired === true
      ? true
      : item.sponsorship_required === false || item.sponsorshipRequired === false
        ? false
        : null,
    min_fit_score_10: numberValue(item.min_fit_score_10 ?? item.minFitScore10),
    search_cadence: text(item.search_cadence || item.searchCadence, 40),
    application_automation_preference: text(item.application_automation_preference || item.applicationAutomationPreference, 80),
    notes: text(item.notes, 5000),
  };
}

function parseJsonObject(response: string): JsonRecord | null {
  const candidates = [
    response.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i)?.[1] || "",
    response.trim(),
  ].filter(Boolean);
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(response.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord;
    } catch {
      // The response is untrusted text. Fall back to the next bounded JSON candidate.
    }
  }
  return null;
}

export function parseStructuredMemoryInterview(response: string): ParsedMemoryInterview | null {
  const root = parseJsonObject(response);
  if (!root) return null;
  const rawProfile = root.profile && typeof root.profile === "object" && !Array.isArray(root.profile)
    ? root.profile as JsonRecord
    : {};
  const profile: JsonRecord = {};
  for (const field of SCALAR_FIELDS) {
    const value = rawProfile[field];
    if (field === "date_of_birth" || field === "visa_expiry") {
      const parsed = dateValue(value);
      if (parsed) profile[field] = parsed;
    } else if (field === "languages") {
      const parsed = normaliseLanguages(value);
      if (parsed.length) profile[field] = parsed;
    } else if (field === "linkedin_url") {
      const parsed = cleanUrlValue(value);
      if (parsed) profile[field] = parsed;
    } else if (field === "portfolio_links") {
      const parsed = normalisePortfolioLinks(value);
      if (parsed.length) profile[field] = parsed;
    } else if (field === "certifications") {
      const parsed = normaliseCertifications(value);
      if (parsed.length) profile[field] = parsed;
    } else if (field === "current_salary" || field === "salary_expectation") {
      const numeric = numberValue(value);
      if (numeric !== null) profile[field] = numeric;
      else {
        const parsed = text(value, 2000);
        if (parsed) profile[field] = parsed;
      }
    } else if (field === "right_to_work_countries") {
      const parsed = list(value, 20);
      if (parsed.length) profile[field] = parsed;
    } else {
      const parsed = text(value, 2000);
      if (parsed) profile[field] = parsed;
    }
  }
  profile.employment = normaliseEmployment(firstArray(rawProfile, "employment", "employment_history", "work_experience"));
  profile.education = normaliseEducation(firstArray(rawProfile, "education", "qualifications"));
  profile.skills = normaliseSkills(firstArray(rawProfile, "skills", "skills_and_tools"));
  profile.projects = normaliseProjects(firstArray(rawProfile, "projects"));
  profile.publications = normalisePublications(firstArray(rawProfile, "publications"));
  profile.certifications = normaliseCertifications(firstArray(rawProfile, "certifications"));
  profile.job_search = normaliseJobSearch(rawProfile.job_search || rawProfile.job_search_preferences);

  const questions = records(root.questions, 100).map((item) => ({
    field: text(item.field, 240) || "profile",
    question: text(item.question, 800),
    // Every question is part of the onboarding completion contract. The user
    // can answer "not applicable" where appropriate, but an omitted answer
    // must not silently become a complete profile field.
    required: true,
    inputType: text(item.input_type || item.inputType, 60) || "text",
  })).filter((item): item is StructuredMemoryQuestion => Boolean(item.question));
  const conflicts = records(root.conflicts, 50).map((item) => ({
    field: text(item.field, 240) || "profile",
    details: text(item.details || item.description || item.conflict, 1000),
  })).filter((item): item is { field: string; details: string } => Boolean(item.details));
  return {
    profile,
    questions,
    conflicts,
    profileSummary: text(root.profile_summary || root.summary, 5000) || "",
  };
}

export function memoryQuestionText(question: StructuredMemoryQuestion) {
  return "[field: " + question.field + "] " + question.question;
}

export function memoryConflictText(conflict: { field: string; details: string }) {
  return "[conflict: " + conflict.field + "] " + conflict.details;
}
