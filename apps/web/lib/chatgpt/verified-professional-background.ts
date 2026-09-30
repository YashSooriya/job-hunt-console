import { sortReverseChronological } from "@/lib/onboarding/record-order";
import type { ProfessionalBackgroundInput } from "@/lib/chatgpt/professional-background";

type Profile = { id: string; display_name: string };

/**
 * Reads the verified, editable onboarding profile for a Website Bridge task.
 * Imported ChatGPT records are excluded from the incremental update path, but
 * are included for the explicit activation update because the user has just
 * asked ChatGPT to remember the completed profile.
 */
export async function readVerifiedProfessionalBackground(
  supabase: any,
  profile: Profile,
  options: { includeImported?: boolean; allowMemoryUpdate?: boolean } = {},
): Promise<ProfessionalBackgroundInput> {
  const includeImported = options.includeImported === true;
  const [factsResult, employmentResult, educationResult, skillsResult, projectsResult, publicationsResult, evidenceResult, memorySourcesResult, sourceDocumentsResult] = await Promise.all([
    supabase.from("candidate_facts").select("fact_key,value_json,source_note,verification_status").eq("profile_id", profile.id).eq("verification_status", "verified").order("fact_key"),
    supabase.from("candidate_employment").select("role_title,employer,location,start_date,end_date,current,details,source_id,verification_status").eq("profile_id", profile.id).eq("verification_status", "verified").order("start_date", { ascending: false }),
    supabase.from("candidate_education").select("qualification,institution,field_of_study,location,start_date,end_date,current,details,source_id,verification_status").eq("profile_id", profile.id).eq("verification_status", "verified").order("start_date", { ascending: false }),
    supabase.from("candidate_skills").select("name,category,proficiency,years_experience,source_id,verification_status").eq("profile_id", profile.id).eq("verification_status", "verified").order("name"),
    supabase.from("candidate_projects").select("title,description,technologies,start_date,end_date,url,source_id,verification_status").eq("profile_id", profile.id).eq("verification_status", "verified").order("start_date", { ascending: false }),
    supabase.from("candidate_publications").select("title,publication_type,venue,published_on,url,citation,source_id,verification_status").eq("profile_id", profile.id).eq("verification_status", "verified").order("published_on", { ascending: false }),
    supabase.from("evidence_items").select("category,claim,detail,tags,source_id,verification_status").eq("profile_id", profile.id).eq("verification_status", "verified").order("strength", { ascending: false }),
    supabase.from("evidence_sources").select("id").eq("profile_id", profile.id).eq("source_type", "chatgpt_memory"),
    supabase.from("candidate_source_documents").select("original_name,source_type").eq("profile_id", profile.id).order("created_at", { ascending: false }),
  ]);
  const error = [factsResult, employmentResult, educationResult, skillsResult, projectsResult, publicationsResult, evidenceResult, memorySourcesResult, sourceDocumentsResult].find((result) => result.error)?.error;
  if (error) throw error;

  const memorySourceIds = new Set((memorySourcesResult.data || []).map((source: Record<string, unknown>) => String(source.id || "")));
  const userOwnedRecord = (item: Record<string, unknown>) => !item.source_id || !memorySourceIds.has(String(item.source_id));
  const keepRecord = includeImported ? () => true : userOwnedRecord;
  const facts = includeImported
    ? factsResult.data || []
    : (factsResult.data || []).filter((fact: Record<string, unknown>) => !String(fact.source_note || "").startsWith("chatgpt_memory:"));
  // Job-search preferences are managed on the Jobs page and are intentionally
  // outside the onboarding/profile Memory payload. Keep the database read for
  // compatibility with older rows, but never include it in a profile update.
  const preferences = {};
  const sourceNames = (sourceDocumentsResult.data || [])
    .map((source: Record<string, unknown>) => {
      const name = String(source.original_name || "").trim();
      const type = String(source.source_type || "").trim();
      return name ? (type && type !== "cv_upload" ? `${name} (${type.replaceAll("_", " ")})` : name) : "";
    })
    .filter(Boolean);

  return {
    displayName: profile.display_name,
    facts,
    employment: sortReverseChronological((employmentResult.data || []).filter(keepRecord), "history"),
    education: sortReverseChronological((educationResult.data || []).filter(keepRecord), "history"),
    skills: (skillsResult.data || []).filter(keepRecord),
    projects: sortReverseChronological((projectsResult.data || []).filter(keepRecord), "project"),
    publications: sortReverseChronological((publicationsResult.data || []).filter(keepRecord), "publication"),
    evidence: (evidenceResult.data || []).filter(keepRecord),
    sourceDocuments: [],
    sourceNames,
    preferences,
    allowMemoryUpdate: options.allowMemoryUpdate !== false,
  };
}
