import type { ParsedMemoryInterview } from "@/lib/chatgpt/memory-profile";

type JsonRecord = Record<string, any>;

function meaningful(value: unknown) {
  return value !== null && value !== undefined
    && (typeof value !== "string" || value.trim().length > 0)
    && (!Array.isArray(value) || value.length > 0);
}

function text(value: unknown, maximum = 5000) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
}

function list(value: unknown, maximum = 40) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 500)).slice(0, maximum)
    : [];
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function detailsFor(item: JsonRecord) {
  const keyPoints = list(item.key_points || item.keyPoints, 30);
  const points = keyPoints.length ? "Key points:\n" + keyPoints.map((point) => "- " + point).join("\n") : "";
  return [text(item.details || item.detail || item.description, 5000), points].filter(Boolean).join("\n") || null;
}

function scalarFacts(profile: JsonRecord) {
  const fields = [
    "first_name", "surname", "date_of_birth", "email", "phone", "location", "citizenship",
    "work_authorisation", "right_to_work_countries", "visa_status", "visa_expiry",
    "sponsorship_requirement", "notice_period", "current_salary", "salary_currency",
    "salary_expectation", "availability_date", "linkedin_url", "languages", "portfolio_links",
    "certifications",
  ];
  return fields
    .map((factKey) => ({ factKey, value: profile[factKey] }))
    .filter((item) => meaningful(item.value));
}

export async function applyStructuredMemoryProfile(args: {
  supabase: any;
  profileId: string;
  sourceId: string;
  parsed: ParsedMemoryInterview;
}) {
  const profile = args.parsed.profile;
  const now = new Date().toISOString();
  const incomingFacts = scalarFacts(profile).map(({ factKey, value }) => ({
    profile_id: args.profileId,
    fact_key: factKey,
    value_json: value,
    // The user reviews these values directly in the editable onboarding
    // fields. Keeping them verified lets the rest of the application use the
    // imported profile immediately without a second review queue.
    verification_status: "verified",
    source_note: "chatgpt_memory:" + args.sourceId,
    verified_at: now,
    updated_at: now,
  }));
  const { data: existingFacts, error: existingFactsError } = await args.supabase
    .from("candidate_facts")
    .select("fact_key,verification_status,source_note")
    .eq("profile_id", args.profileId);
  if (existingFactsError) throw existingFactsError;
  const userOwnedFactKeys = new Set((existingFacts || [])
    .filter((fact: JsonRecord) => !String(fact.source_note || "").startsWith("chatgpt_memory:")
      && ["verified", "rejected"].includes(String(fact.verification_status || "")))
    .map((fact: JsonRecord) => String(fact.fact_key)));

  // ChatGPT's JSON is a fresh snapshot. Remove only the previous imported
  // snapshot; values the user has saved in the onboarding form are preserved.
  const importedFactIds = (existingFacts || [])
    .filter((fact: JsonRecord) => String(fact.source_note || "").startsWith("chatgpt_memory:"))
    .map((fact: JsonRecord) => String(fact.fact_key))
    .filter(Boolean);
  if (importedFactIds.length) {
    const { error } = await args.supabase
      .from("candidate_facts")
      .delete()
      .eq("profile_id", args.profileId)
      .in("fact_key", importedFactIds)
      .like("source_note", "chatgpt_memory:%");
    if (error) throw error;
  }

  const facts = incomingFacts.filter((fact) => !userOwnedFactKeys.has(fact.fact_key));
  if (facts.length) {
    const { error } = await args.supabase.from("candidate_facts").upsert(facts, {
      onConflict: "profile_id,fact_key",
    });
    if (error) throw error;
  }

  const employment = Array.isArray(profile.employment) ? profile.employment : [];
  const education = Array.isArray(profile.education) ? profile.education : [];
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  const projects = Array.isArray(profile.projects) ? profile.projects : [];
  const publications = Array.isArray(profile.publications) ? profile.publications : [];
  const certifications = Array.isArray(profile.certifications) ? profile.certifications : [];

  const { data: memorySources, error: memorySourcesError } = await args.supabase
    .from("evidence_sources")
    .select("id")
    .eq("profile_id", args.profileId)
    .eq("source_type", "chatgpt_memory");
  if (memorySourcesError) throw memorySourcesError;
  const memorySourceIds = [...new Set((memorySources || []).map((source: JsonRecord) => String(source.id || "")).filter(Boolean))];

  // Structured ChatGPT imports are materialised directly into the editable
  // onboarding tables. Delete only rows owned by an earlier ChatGPT snapshot;
  // rows edited or added by the user have source_id = null and remain.
  if (memorySourceIds.length) {
    const deletionResults = await Promise.all([
      args.supabase.from("candidate_employment").delete().eq("profile_id", args.profileId).in("source_id", memorySourceIds),
      args.supabase.from("candidate_education").delete().eq("profile_id", args.profileId).in("source_id", memorySourceIds),
      args.supabase.from("candidate_skills").delete().eq("profile_id", args.profileId).in("source_id", memorySourceIds),
      args.supabase.from("candidate_projects").delete().eq("profile_id", args.profileId).in("source_id", memorySourceIds),
      args.supabase.from("candidate_publications").delete().eq("profile_id", args.profileId).in("source_id", memorySourceIds),
      // Remove legacy review proposals from the old import flow. New imports
      // never create them, so they cannot reappear as a second review queue.
      args.supabase.from("candidate_extraction_proposals").delete().eq("profile_id", args.profileId).in("source_id", memorySourceIds),
    ]);
    const deletionError = deletionResults.find((result: { error?: unknown }) => result.error)?.error;
    if (deletionError) throw deletionError;
  }

  const employmentRows = employment.map((item) => {
    const value = record(item);
    return {
      profile_id: args.profileId,
      source_id: args.sourceId,
      employer: text(value.company_name, 300),
      role_title: text(value.job_title, 300),
      location: text(value.location, 300),
      start_date: text(value.start_date, 20),
      end_date: value.current === true ? null : text(value.end_date, 20),
      current: value.current === true,
      details: detailsFor(value),
      verification_status: "verified",
      updated_at: now,
    };
  }).filter((item) => item.employer && item.role_title);
  const educationRows = education.map((item) => {
    const value = record(item);
    return {
      profile_id: args.profileId,
      source_id: args.sourceId,
      institution: text(value.institution, 300),
      qualification: text(value.qualification, 300),
      field_of_study: text(value.field_of_study, 300),
      location: text(value.location, 300),
      start_date: text(value.start_date, 20),
      end_date: value.current === true ? null : text(value.end_date, 20),
      current: value.current === true,
      details: detailsFor(value),
      verification_status: "verified",
      updated_at: now,
    };
  }).filter((item) => item.institution && item.qualification);
  const skillRows = skills.map((item) => {
    const value = record(item);
    const name = text(value.name, 200);
    return {
      profile_id: args.profileId,
      source_id: args.sourceId,
      name,
      category: text(value.category, 100) || "skill",
      proficiency: text(value.proficiency, 100),
      years_experience: typeof value.years_experience === "number" ? value.years_experience : null,
      verification_status: "verified",
      updated_at: now,
    };
  }).filter((item) => item.name);
  const projectRows = projects.map((item) => {
    const value = record(item);
    return {
      profile_id: args.profileId,
      source_id: args.sourceId,
      title: text(value.title, 500),
      description: text(value.description, 5000),
      technologies: list(value.technologies, 30),
      start_date: text(value.start_date || value.startDate, 20),
      end_date: text(value.end_date || value.endDate, 20),
      url: text(value.url, 2000),
      verification_status: "verified",
      updated_at: now,
    };
  }).filter((item) => item.title);
  const publicationRows = publications.map((item) => {
    const value = record(item);
    return {
      profile_id: args.profileId,
      source_id: args.sourceId,
      title: text(value.title, 1000),
      publication_type: text(value.publication_type, 100) || "publication",
      venue: text(value.venue, 500),
      published_on: text(value.published_on, 20),
      url: text(value.url, 2000),
      citation: text(value.citation, 5000),
      verification_status: "verified",
      updated_at: now,
    };
  }).filter((item) => item.title);

  const recordInserts = [
    ["candidate_employment", employmentRows],
    ["candidate_education", educationRows],
    ["candidate_projects", projectRows],
    ["candidate_publications", publicationRows],
  ] as const;
  for (const [table, rows] of recordInserts) {
    if (!rows.length) continue;
    const { data: existing, error: existingError } = await args.supabase
      .from(table)
      .select("*")
      .eq("profile_id", args.profileId)
      .is("source_id", null);
    if (existingError) throw existingError;
    const existingRows = existing || [];
    const filteredRows = rows.filter((row: JsonRecord) => {
      if (table === "candidate_employment") {
        return !existingRows.some((old: JsonRecord) => String(old.employer || "").toLowerCase() === String(row.employer || "").toLowerCase()
          && String(old.role_title || "").toLowerCase() === String(row.role_title || "").toLowerCase()
          && String(old.start_date || "") === String(row.start_date || ""));
      }
      if (table === "candidate_education") {
        return !existingRows.some((old: JsonRecord) => String(old.institution || "").toLowerCase() === String(row.institution || "").toLowerCase()
          && String(old.qualification || "").toLowerCase() === String(row.qualification || "").toLowerCase()
          && String(old.start_date || "") === String(row.start_date || ""));
      }
      return !existingRows.some((old: JsonRecord) => String(old.title || "").toLowerCase() === String(row.title || "").toLowerCase());
    });
    if (!filteredRows.length) continue;
    const { error } = await args.supabase.from(table).insert(filteredRows);
    if (error) throw error;
  }
  if (skillRows.length) {
    const { error } = await args.supabase.from("candidate_skills").insert(skillRows, { ignoreDuplicates: true });
    if (error) throw error;
  }

  return {
    facts: facts.length,
    proposals: 0,
    structured: employmentRows.length + educationRows.length + skillRows.length + projectRows.length + publicationRows.length,
    // Search preferences are managed on the Jobs page. Ignore the legacy
    // profile.job_search object if an older ChatGPT JSON file still contains it.
    preferencesUpdated: false,
  };
}
