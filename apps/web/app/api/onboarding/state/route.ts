import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { sortReverseChronological } from "@/lib/onboarding/record-order";

function fallbackReadiness(input: {
  onboarding: any;
  facts: any[];
  evidence: any[];
  extractionProposals: any[];
  education: any[];
  employment: any[];
  skills: any[];
  cvFamilies: any[];
  sourceDocuments: any[];
  preferences: Record<string, any>;
}) {
  const preferences = input.preferences || {};
  const searchMode = ["keywords", "profile", "keywords_and_profile"].includes(preferences.search_mode)
    ? preferences.search_mode
    : "keywords_and_profile";
  const locations = Array.isArray(preferences.locations) && preferences.locations.length > 0;
  const targetRoles = Array.isArray(preferences.target_roles) && preferences.target_roles.length > 0;
  const workModes = Array.isArray(preferences.work_modes) && preferences.work_modes.length > 0;
  const roleFamilies = Array.isArray(preferences.role_families) && preferences.role_families.length > 0;
  const seniority = Boolean(String(preferences.target_seniority || "").trim());
  const preferencesComplete = locations && workModes && (
    searchMode === "profile" || (targetRoles && roleFamilies && seniority)
  );
  const pendingReview = [
    ...input.facts,
    ...input.evidence,
    ...input.extractionProposals,
  ].filter((item) => item.verification_status === "needs_review").length;
  const history = input.education.filter((item) => item.verification_status === "verified").length
    + input.employment.filter((item) => item.verification_status === "verified").length;
  const skills = input.skills.filter((item) => item.verification_status === "verified").length;
  const evidence = input.evidence.filter((item) => item.verification_status === "verified").length;
  const workAuthorisation = input.facts.some((item) => item.fact_key === "work_authorisation" && item.verification_status === "verified");
  const families = input.cvFamilies.filter((item) => item.enabled).length;
  const sourceDocuments = input.sourceDocuments.filter((item) => ["stored", "extracted"].includes(item.extraction_status)).length;
  const profileComplete = history > 0 && workAuthorisation;
  const activationReady = profileComplete && preferencesComplete && pendingReview === 0;
  const score = (profileComplete ? 60 : 0)
    + (preferencesComplete ? 30 : 0)
    + (pendingReview === 0 ? 10 : 0);

  return {
    ready: activationReady,
    activation_ready: activationReady,
    profile_complete: profileComplete,
    score,
    status: input.onboarding?.status || "in_progress",
    pending_review: pendingReview,
    history,
    skills,
    verified_evidence: evidence,
    work_authorisation: workAuthorisation,
    locations,
    target_roles: targetRoles,
    search_mode: searchMode,
    work_modes: workModes,
    role_families: roleFamilies,
    target_seniority: seniority,
    preferences_complete: preferencesComplete,
    cv_families: families,
    source_document_extracted: sourceDocuments > 0,
    external_connections_required: false,
  };
}

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const pid = profile.id;

    const { data: onboarding, error: onboardingError } = await supabase
      .from("candidate_onboarding")
      .select("*")
      .eq("profile_id", pid)
      .maybeSingle();
    if (onboardingError) throw onboardingError;
    if (!onboarding) {
      const { error } = await supabase.from("candidate_onboarding").insert({ profile_id: pid });
      if (error) throw error;
    }

    const queries = await Promise.all([
      supabase.from("candidate_onboarding").select("*").eq("profile_id", pid).maybeSingle(),
      supabase.from("candidate_facts").select("*").eq("profile_id", pid).order("fact_key"),
      supabase.from("evidence_items").select("*,evidence_sources(source_key,title)").eq("profile_id", pid).order("created_at", { ascending: false }),
      supabase.from("candidate_extraction_proposals").select("*").eq("profile_id", pid).order("created_at", { ascending: false }),
      supabase.from("candidate_education").select("*").eq("profile_id", pid).order("start_date", { ascending: false }),
      supabase.from("candidate_employment").select("*").eq("profile_id", pid).order("start_date", { ascending: false }),
      supabase.from("candidate_skills").select("*").eq("profile_id", pid).order("name"),
      supabase.from("candidate_projects").select("*").eq("profile_id", pid).order("start_date", { ascending: false }),
      supabase.from("candidate_publications").select("*").eq("profile_id", pid).order("published_on", { ascending: false }),
      supabase.from("candidate_cv_families").select("*").eq("profile_id", pid).order("created_at"),
      supabase.from("candidate_source_documents").select("id,original_name,source_type,mime_type,byte_size,extraction_status,extraction_format,extraction_error,extracted_at,created_at").eq("profile_id", pid).order("created_at", { ascending: false }),
      supabase.from("candidate_preferences").select("preferences").eq("profile_id", pid).maybeSingle(),
    ]);
    const error = queries.find((query) => query.error)?.error;
    if (error) throw error;

    const education = sortReverseChronological(queries[4].data || [], "history");
    const employment = sortReverseChronological(queries[5].data || [], "history");
    const projects = sortReverseChronological(queries[7].data || [], "project");
    const publications = sortReverseChronological(queries[8].data || [], "publication");
    const fallback = fallbackReadiness({
      onboarding: queries[0].data,
      facts: queries[1].data || [],
      evidence: queries[2].data || [],
      extractionProposals: queries[3].data || [],
      education,
      employment,
      skills: queries[6].data || [],
      cvFamilies: queries[9].data || [],
      sourceDocuments: queries[10].data || [],
      preferences: queries[11].data?.preferences || {},
    });
    let readiness = fallback;
    try {
      const readinessResult = await supabase.rpc("get_onboarding_readiness");
      if (!readinessResult.error && readinessResult.data) readiness = readinessResult.data;
    } catch {
      // The readiness summary is helpful but must not prevent the profile editor
      // from loading when a legacy database privilege is unavailable.
    }

    return NextResponse.json({
      ok: true,
      profile,
      onboarding: queries[0].data,
      facts: queries[1].data,
      evidence: queries[2].data,
      extractionProposals: queries[3].data,
      education,
      employment,
      skills: queries[6].data,
      projects,
      publications,
      cvFamilies: queries[9].data,
      sourceDocuments: queries[10].data,
      preferences: queries[11].data?.preferences || {},
      readiness,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to load onboarding." },
      { status: statusCode(error) }
    );
  }
}
