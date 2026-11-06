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
    if (body.profileId !== undefined && body.profileId !== profile.id) {
      return NextResponse.json({
        ok: false,
        error: "Profile does not belong to the authenticated user.",
      }, { status: 403 });
    }
    const partial = body.partial === true;
    const hasBodyField = (fieldName: string) => Object.prototype.hasOwnProperty.call(body, fieldName);
    const displayName = text(body.displayName, 200);
    if (!partial && !displayName) throw new Error("Display name is required.");
    // A partial correction must never clear the canonical display name just
    // because an imported JSON profile left that unrelated required field
    // blank. Only a non-empty, explicitly supplied value may change it.
    const nextDisplayName = partial
      ? (hasBodyField("displayName") && displayName ? displayName : profile.display_name)
      : displayName;
    const displayNameChanged = !sameFieldValue(profile.display_name, nextDisplayName, "display_name");

    const now = new Date().toISOString();
    if (!partial || displayNameChanged) {
      const { error: profileError } = await supabase
        .from("candidate_profiles")
        .update({ display_name: nextDisplayName, updated_at: now })
        .eq("id", profile.id);
      if (profileError) throw profileError;
    }

    const facts = [
      ["first_name", "firstName", body.firstName],
      ["surname", "surname", body.surname],
      ["date_of_birth", "dateOfBirth", body.dateOfBirth],
      ["email", "email", body.email],
      ["phone", "phone", body.phone],
      ["location", "location", body.location],
      ["citizenship", "citizenship", body.citizenship],
      ["work_authorisation", "workAuthorisation", body.workAuthorisation],
      ["right_to_work_countries", "rightToWorkCountries", body.rightToWorkCountries],
      ["visa_status", "visaStatus", body.visaStatus],
      ["visa_expiry", "visaExpiry", body.visaExpiry],
      ["sponsorship_requirement", "sponsorshipRequirement", body.sponsorshipRequirement],
      ["notice_period", "noticePeriod", body.noticePeriod],
      ["current_salary", "currentSalary", body.currentSalary],
      ["salary_currency", "salaryCurrency", body.salaryCurrency],
      ["salary_expectation", "salaryExpectation", body.salaryExpectation],
      ["availability_date", "availabilityDate", body.availabilityDate],
      ["languages", "languages", body.languages],
      ["portfolio_links", "portfolioLinks", body.portfolioLinks],
      ["linkedin_url", "linkedinUrl", body.linkedinUrl],
      ["certifications", "certifications", body.certifications],
    ] as const;
    // Full saves intentionally reconcile every editable fact. Incremental
    // corrections, however, must touch only fields present in the patch.
    const selectedFacts = partial
      ? facts.filter(([, bodyField]) => hasBodyField(bodyField))
      : facts;

    const keys = [...selectedFacts.map(([key]) => key), "display_name"];
    const { data: existingFacts, error: existingError } = await supabase
      .from("candidate_facts")
      .select("fact_key,value_json,source_note")
      .eq("profile_id", profile.id)
      .in("fact_key", keys);
    if (existingError) throw existingError;
    const existingByKey = new Map((existingFacts || []).map((fact: Record<string, unknown>) => [String(fact.fact_key), fact]));

    // Display Name is stored canonically on candidate_profiles, but it also
    // needs a user-owned fact when the user changes it so incremental Memory
    // updates can include it and derive a new idempotency key. Do not create a
    // correction fact for an untouched authentication/default display name.
    if (displayNameChanged) {
      const { error } = await supabase.from("candidate_facts").upsert({
        profile_id: profile.id,
        fact_key: "display_name",
        value_json: nextDisplayName,
        verification_status: "verified",
        source_note: "user_onboarding",
        verified_at: now,
        updated_at: now,
      }, { onConflict: "profile_id,fact_key" });
      if (error) throw error;
    }

    for (const [factKey, , rawValue] of selectedFacts) {
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
      // Saving the form confirms only a changed value. An unchanged imported
      // value remains pending until the user uses its explicit review control.
      if (existing && sameFieldValue(existing.value_json, value, factKey)) continue;

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
