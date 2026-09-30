import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { sortReverseChronological } from "@/lib/onboarding/record-order";
import { sourceBundleDigest } from "@/lib/onboarding/source-validation";

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
  additionalInformation?: string;
}) {
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
  const profileReady = profileComplete && pendingReview === 0;
  const score = (profileComplete ? 70 : 0)
    + (sourceDocuments > 0 ? 20 : 0)
    + (pendingReview === 0 ? 10 : 0);

  return {
    ready: profileReady,
    activation_ready: profileReady,
    profile_complete: profileComplete,
    score,
    status: input.onboarding?.status || "in_progress",
    pending_review: pendingReview,
    history,
    skills,
    verified_evidence: evidence,
    work_authorisation: workAuthorisation,
    // Search preferences now live on the Jobs page. Keep these legacy keys in
    // the response for older consumers, but they are deliberately not part of
    // onboarding readiness or reset semantics.
    locations: false,
    target_roles: false,
    search_mode: "keywords_and_profile",
    work_modes: false,
    role_families: false,
    target_seniority: false,
    preferences_complete: true,
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
      supabase.from("candidate_source_documents").select("id,original_name,source_type,mime_type,byte_size,sha256,extraction_status,extraction_format,extraction_error,extracted_at,created_at,updated_at").eq("profile_id", pid).order("created_at", { ascending: false }),
      supabase.from("candidate_preferences").select("preferences").eq("profile_id", pid).maybeSingle(),
      // Additional information is the only source text that is rendered back
      // into the editor. Keep CV/document contents opaque to the browser while
      // allowing this user-owned field to be edited and replaced.
      supabase.from("candidate_source_documents").select("extracted_text,storage_object_key").eq("profile_id", pid).eq("source_type", "user_description").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const error = queries.find((query) => query.error)?.error;
    if (error) throw error;

    const education = sortReverseChronological(queries[4].data || [], "history");
    const employment = sortReverseChronological(queries[5].data || [], "history");
    const projects = sortReverseChronological(queries[7].data || [], "project");
    const publications = sortReverseChronological(queries[8].data || [], "publication");

    let additionalInformation = typeof queries[12].data?.extracted_text === "string" ? queries[12].data.extracted_text : "";
    // Sources created before the editable-text change have their content only
    // in private storage. Read that one user-description object as a legacy
    // fallback so existing users can replace or clear it without a reset.
    if (!additionalInformation && typeof queries[12].data?.storage_object_key === "string") {
      try {
        const legacyText = await supabase.storage
          .from("candidate-source-documents")
          .download(queries[12].data.storage_object_key);
        if (!legacyText.error && legacyText.data) additionalInformation = await legacyText.data.text();
      } catch {
        // A missing legacy object should not prevent the rest of onboarding
        // from loading; the saved source can still be removed from the list.
      }
    }

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
      additionalInformation,
    });
    let readiness = fallback;
    try {
      const readinessResult = await supabase.rpc("get_onboarding_readiness");
      if (!readinessResult.error && readinessResult.data) {
        // The legacy readiness RPC also includes job-search activation gates.
        // Onboarding now owns only profile/source import, so retain useful
        // connection metadata but keep the profile-only readiness contract.
        readiness = { ...readinessResult.data, ...fallback };
      }
    } catch {
      // The readiness summary is helpful but must not prevent the profile editor
      // from loading when a legacy database privilege is unavailable.
    }

    const sourceDocuments = queries[10].data || [];
    // `user_description` is represented by the separate editable text value
    // below. Exclude its document row from the digest so the state endpoint
    // and the source-save/build endpoints calculate the same revision.
    const savedDocuments = sourceDocuments.filter((document: any) => !["chatgpt_memory", "user_description"].includes(document.source_type));
    const linkedInFact = (queries[1].data || []).find((fact: any) => fact.fact_key === "linkedin_url" || fact.fact_key === "linkedin");
    const linkedinUrl = typeof linkedInFact?.value_json === "string" ? linkedInFact.value_json : "";
    const bundleRevision = sourceBundleDigest({
      documents: savedDocuments,
      linkedinUrl,
      additionalInformation,
    });

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
      sourceDocuments,
      bundleRevision,
      preferences: queries[11].data?.preferences || {},
      additionalInformation,
      readiness,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to load onboarding." },
      { status: statusCode(error) }
    );
  }
}
