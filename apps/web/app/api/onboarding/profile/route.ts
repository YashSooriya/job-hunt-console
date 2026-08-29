import { NextResponse } from "next/server";
import { cleanUrlValue, formatProfileValue } from "@/lib/onboarding/value-format";
import { nullable, requireProfile, statusCode, text } from "@/lib/onboarding/server";

function listValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim().slice(0, 500))
      .slice(0, 40);
  }
  return typeof value === "string"
    ? value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean).slice(0, 40)
    : [];
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function sameFieldValue(left: unknown, right: unknown, fieldKey: string) {
  return formatProfileValue(left, fieldKey) === formatProfileValue(right, fieldKey);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { supabase, profile } = await requireProfile();
    const displayName = text(body.displayName, 200);
    if (!displayName) throw new Error("Display name is required.");

    const now = new Date().toISOString();
    const { error: profileError } = await supabase
      .from("candidate_profiles")
      .update({ display_name: displayName, updated_at: now })
      .eq("id", profile.id);
    if (profileError) throw profileError;

    const facts = [
      ["first_name", body.firstName],
      ["surname", body.surname],
      ["date_of_birth", body.dateOfBirth],
      ["email", body.email],
      ["phone", body.phone],
      ["location", body.location],
      ["citizenship", body.citizenship],
      ["work_authorisation", body.workAuthorisation],
      ["right_to_work_countries", body.rightToWorkCountries],
      ["visa_status", body.visaStatus],
      ["visa_expiry", body.visaExpiry],
      ["sponsorship_requirement", body.sponsorshipRequirement],
      ["notice_period", body.noticePeriod],
      ["current_salary", body.currentSalary],
      ["salary_currency", body.salaryCurrency],
      ["salary_expectation", body.salaryExpectation],
      ["availability_date", body.availabilityDate],
      ["languages", listValue(body.languages)],
      ["portfolio_links", listValue(body.portfolioLinks)],
      ["linkedin_url", body.linkedinUrl],
      ["certifications", listValue(body.certifications)],
    ] as const;

    const keys = facts.map(([key]) => key);
    const { data: existingFacts, error: existingError } = await supabase
      .from("candidate_facts")
      .select("fact_key,value_json,source_note")
      .eq("profile_id", profile.id)
      .in("fact_key", keys);
    if (existingError) throw existingError;
    const existingByKey = new Map((existingFacts || []).map((fact: Record<string, unknown>) => [String(fact.fact_key), fact]));

    for (const [factKey, rawValue] of facts) {
      const value = factKey === "right_to_work_countries" || factKey === "languages" || factKey === "portfolio_links" || factKey === "certifications"
        ? listValue(rawValue)
        : factKey === "linkedin_url"
          ? cleanUrlValue(rawValue)
          : nullable(rawValue, 5000);
      const existing = existingByKey.get(factKey);
      if (!hasValue(value)) {
        if (existing) {
          const { error } = await supabase.from("candidate_facts").delete().eq("profile_id", profile.id).eq("fact_key", factKey);
          if (error) throw error;
        }
        continue;
      }

      const importedSource = typeof existing?.source_note === "string" && existing.source_note.startsWith("chatgpt_memory:")
        ? existing.source_note
        : "user_onboarding";
      const sourceNote = importedSource !== "user_onboarding" && sameFieldValue(existing?.value_json, value, factKey)
        ? importedSource
        : "user_onboarding";
      const { error } = await supabase.from("candidate_facts").upsert({
        profile_id: profile.id,
        fact_key: factKey,
        value_json: value,
        verification_status: "verified",
        source_note: sourceNote,
        verified_at: now,
        updated_at: now,
      }, { onConflict: "profile_id,fact_key" });
      if (error) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to save profile.",
    }, { status: statusCode(error) });
  }
}
