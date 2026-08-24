import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

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

    const { data: existingFamilies, error: familyReadError } = await supabase
      .from("candidate_cv_families")
      .select("id")
      .eq("profile_id", pid);
    if (familyReadError) throw familyReadError;
    if (!(existingFamilies || []).length) {
      const { error } = await supabase.from("candidate_cv_families").insert([
        { profile_id: pid, family_key: "simulation_cae", label: "Simulation / CAE", enabled: true, is_default: true },
        { profile_id: pid, family_key: "scientific_software", label: "Scientific Software", enabled: true },
        { profile_id: pid, family_key: "quantitative_data", label: "Quantitative / Data", enabled: true },
        { profile_id: pid, family_key: "motorsport", label: "Motorsport", enabled: false },
      ]);
      if (error) throw error;
    }

    const queries = await Promise.all([
      supabase.from("candidate_onboarding").select("*").eq("profile_id", pid).maybeSingle(),
      supabase.from("candidate_facts").select("*").eq("profile_id", pid).order("fact_key"),
      supabase.from("evidence_items").select("*,evidence_sources(source_key,title)").eq("profile_id", pid).order("created_at", { ascending: false }),
      supabase.from("candidate_education").select("*").eq("profile_id", pid).order("start_date", { ascending: false }),
      supabase.from("candidate_employment").select("*").eq("profile_id", pid).order("start_date", { ascending: false }),
      supabase.from("candidate_skills").select("*").eq("profile_id", pid).order("name"),
      supabase.from("candidate_projects").select("*").eq("profile_id", pid).order("created_at", { ascending: false }),
      supabase.from("candidate_publications").select("*").eq("profile_id", pid).order("published_on", { ascending: false }),
      supabase.from("candidate_cv_families").select("*").eq("profile_id", pid).order("created_at"),
      supabase.from("candidate_source_documents").select("id,original_name,mime_type,byte_size,extraction_status,created_at").eq("profile_id", pid).order("created_at", { ascending: false }),
      supabase.from("candidate_preferences").select("preferences").eq("profile_id", pid).maybeSingle(),
      supabase.from("reusable_answers").select("*").eq("profile_id", pid).order("answer_key"),
      supabase.rpc("get_onboarding_readiness"),
    ]);
    const error = queries.find((query) => query.error)?.error;
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      profile,
      onboarding: queries[0].data,
      facts: queries[1].data,
      evidence: queries[2].data,
      education: queries[3].data,
      employment: queries[4].data,
      skills: queries[5].data,
      projects: queries[6].data,
      publications: queries[7].data,
      cvFamilies: queries[8].data,
      sourceDocuments: queries[9].data,
      preferences: queries[10].data?.preferences || {},
      answers: queries[11].data,
      readiness: queries[12].data,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to load onboarding." },
      { status: statusCode(error) }
    );
  }
}
