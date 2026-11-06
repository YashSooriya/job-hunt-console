import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { sortReverseChronological } from "@/lib/onboarding/record-order";
import { sourceBundleDigest } from "@/lib/onboarding/source-validation";
import { fallbackReadiness } from "@/lib/onboarding/readiness";

export async function GET() {
  try {
    const { supabase, profile } = await requireProfile();
    const pid = profile.id;

    // The client can request this state more than once while a new profile is
    // mounting. Initialize with an insert-on-conflict no-op so simultaneous
    // first loads do not race on the profile_id primary key.
    const { error: onboardingInitError } = await supabase
      .from("candidate_onboarding")
      .upsert({ profile_id: pid }, { onConflict: "profile_id", ignoreDuplicates: true });
    if (onboardingInitError) throw onboardingInitError;

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
      supabase.from("evidence_sources").select("id,title,source_type").eq("profile_id", pid),
    ]);
    const error = queries.find((query) => query.error)?.error;
    if (error) throw error;

    const sourceById = new Map((queries[13].data || []).map((source: any) => [String(source.id), source]));
    const withProvenance = (rows: any[]) => rows.map((item) => {
      const source = sourceById.get(String(item.source_id));
      return { ...item, source_title: source?.title || null, source_type: source?.source_type || null };
    });
    const education = withProvenance(sortReverseChronological(queries[4].data || [], "history"));
    const employment = withProvenance(sortReverseChronological(queries[5].data || [], "history"));
    const skills = withProvenance(queries[6].data || []);
    const projects = withProvenance(sortReverseChronological(queries[7].data || [], "project"));
    const publications = withProvenance(sortReverseChronological(queries[8].data || [], "publication"));

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
      skills,
      projects,
      publications,
      cvFamilies: queries[9].data || [],
      sourceDocuments: queries[10].data || [],
      preferences: queries[11].data?.preferences || {},
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
    const extractionProposals = (queries[3].data || []).map((proposal: any) => ({
      ...proposal,
      source_title: sourceById.get(String(proposal.source_id))?.title || "Imported professional source",
    }));
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
      extractionProposals,
      education,
      employment,
      skills,
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
