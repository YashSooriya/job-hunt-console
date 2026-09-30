import { NextResponse } from "next/server";
import { importCandidateSource, removeAdditionalInformationSources } from "@/lib/onboarding/import-source";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { normaliseLinkedInUrl, sourceBundleDigest } from "@/lib/onboarding/source-validation";

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function readBundle(supabase: any, profileId: string) {
  const [documentsResult, factsResult, textResult] = await Promise.all([
    supabase.from("candidate_source_documents")
      .select("id,original_name,source_type,mime_type,byte_size,extraction_status,extraction_format,extraction_error,extracted_at,created_at,updated_at,sha256")
      .eq("profile_id", profileId)
      .neq("source_type", "chatgpt_memory")
      .order("created_at", { ascending: false }),
    supabase.from("candidate_facts")
      .select("value_json")
      .eq("profile_id", profileId)
      .in("fact_key", ["linkedin_url", "linkedin"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("candidate_source_documents")
      .select("extracted_text,storage_object_key")
      .eq("profile_id", profileId)
      .eq("source_type", "user_description")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const queryError = [documentsResult, factsResult, textResult].find((result) => result.error)?.error;
  if (queryError) throw queryError;
  let additionalInformation = typeof textResult.data?.extracted_text === "string" ? textResult.data.extracted_text : "";
  if (!additionalInformation && typeof textResult.data?.storage_object_key === "string") {
    const legacyText = await supabase.storage.from("candidate-source-documents").download(textResult.data.storage_object_key);
    if (!legacyText.error && legacyText.data) additionalInformation = await legacyText.data.text();
  }
  const linkedinUrl = typeof factsResult.data?.value_json === "string" ? factsResult.data.value_json : "";
  const documents = (documentsResult.data || []).filter((document: any) => document.source_type !== "user_description");
  return {
    documents,
    linkedinUrl,
    additionalInformation,
    bundleRevision: sourceBundleDigest({ documents, linkedinUrl, additionalInformation }),
  };
}

/**
 * Persist source metadata without creating a ChatGPT dispatch. File and text
 * sources use /api/onboarding/import-cv; this endpoint owns the LinkedIn fact
 * because the URL is not itself a stored document.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { supabase, profile } = await requireProfile();
    const hasLinkedinUrl = Object.prototype.hasOwnProperty.call(body, "linkedinUrl");
    const hasAdditionalInformation = Object.prototype.hasOwnProperty.call(body, "additionalInformation");
    if (!hasLinkedinUrl && !hasAdditionalInformation) {
      return NextResponse.json({ ok: true, ...(await readBundle(supabase, profile.id)) });
    }

    const expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : "";
    if (expectedRevision) {
      const currentBundle = await readBundle(supabase, profile.id);
      if (currentBundle.bundleRevision !== expectedRevision) throw new Error("SOURCE_BUNDLE_CONFLICT");
    }

    const linkedinUrl = hasLinkedinUrl ? normaliseLinkedInUrl(body.linkedinUrl) : null;
    const now = new Date().toISOString();

    if (hasAdditionalInformation) {
      const additionalInformation = stringValue(body.additionalInformation).trim();
      if (additionalInformation) {
        await importCandidateSource({
          supabase,
          user: { id: profile.user_id },
          profile,
          text: additionalInformation,
          title: "Additional background",
          sourceType: "user_description",
          replaceSourceType: "user_description",
        });
      } else {
        await removeAdditionalInformationSources({ supabase, profileId: profile.id });
      }
    }

    if (hasLinkedinUrl && linkedinUrl) {
      const { error } = await supabase.from("candidate_facts").upsert({
        profile_id: profile.id,
        fact_key: "linkedin_url",
        value_json: linkedinUrl,
        verification_status: "verified",
        source_note: "user_onboarding",
        verified_at: now,
        updated_at: now,
      }, { onConflict: "profile_id,fact_key" });
      if (error) throw error;
    } else if (hasLinkedinUrl) {
      const { error } = await supabase
        .from("candidate_facts")
        .delete()
        .eq("profile_id", profile.id)
        .in("fact_key", ["linkedin_url", "linkedin"]);
      if (error) throw error;
    }

    return NextResponse.json({ ok: true, ...(await readBundle(supabase, profile.id)) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to save source information." },
      { status: statusCode(error) },
    );
  }
}
