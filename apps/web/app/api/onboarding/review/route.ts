import { NextResponse } from "next/server";
import { requireProfile, statusCode, text } from "@/lib/onboarding/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { supabase, profile } = await requireProfile();
    const status = body.status === "verified" ? "verified" : body.status === "rejected" ? "rejected" : null;
    if (!status) throw new Error("Review decision is required.");

    if (body.kind === "fact") {
      const values: Record<string, unknown> = {
        verification_status: status,
        verified_at: status === "verified" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      if (typeof body.value === "string" && body.value.trim()) values.value_json = body.value.trim();
      const { error } = await supabase.from("candidate_facts").update(values).eq("id", body.id).eq("profile_id", profile.id);
      if (error) throw error;
    } else if (body.kind === "evidence") {
      const values: Record<string, unknown> = { verification_status: status, updated_at: new Date().toISOString() };
      const claim = text(body.claim, 1000);
      if (claim) values.claim = claim;
      const { error } = await supabase.from("evidence_items").update(values).eq("id", body.id).eq("profile_id", profile.id);
      if (error) throw error;
    } else if (body.kind === "proposal") {
      const { data: proposal, error: proposalError } = await supabase
        .from("candidate_extraction_proposals")
        .select("*")
        .eq("id", body.id)
        .eq("profile_id", profile.id)
        .single();
      if (proposalError || !proposal) throw proposalError || new Error("Extraction proposal not found.");

      if (status === "rejected") {
        const { error } = await supabase
          .from("candidate_extraction_proposals")
          .update({ verification_status: "rejected", reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", proposal.id)
          .eq("profile_id", profile.id);
        if (error) throw error;
      } else {
        const proposed = (proposal.proposed_json || {}) as Record<string, unknown>;
        const claim = text(body.claim || proposed.claim, 1000);
        if (!claim) throw new Error("An extracted claim is required before verification.");
        const evidenceKey = `extraction_${proposal.id}`;
        const { data: evidence, error: evidenceError } = await supabase
          .from("evidence_items")
          .upsert({
            profile_id: profile.id,
            source_id: proposal.source_id,
            evidence_key: evidenceKey,
            category: proposal.proposal_type,
            claim,
            detail: typeof proposed.detail === "string" ? proposed.detail : null,
            tags: Array.isArray(proposed.tags) ? proposed.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [proposal.proposal_type],
            strength: 3,
            verification_status: "verified",
            source_locator: proposal.source_locator,
            updated_at: new Date().toISOString(),
          }, { onConflict: "profile_id,evidence_key" })
          .select("id")
          .single();
        if (evidenceError || !evidence) throw evidenceError || new Error("Could not materialize extracted evidence.");
        const { error } = await supabase
          .from("candidate_extraction_proposals")
          .update({
            verification_status: "verified",
            materialized_evidence_id: evidence.id,
            reviewed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", proposal.id)
          .eq("profile_id", profile.id);
        if (error) throw error;
      }
    } else throw new Error("Unknown review item.");

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to review item." },
      { status: statusCode(error) },
    );
  }
}
