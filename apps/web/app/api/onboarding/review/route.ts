import { NextResponse } from "next/server";
import { requireProfile, statusCode, text } from "@/lib/onboarding/server";

function nullable(value: unknown, max = 5000) {
  const result = text(value, max);
  return result || null;
}

function fields(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function booleanValue(value: unknown) {
  return value === true || value === "true" || value === "on" || value === 1;
}

function dateValue(value: unknown) {
  const result = text(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function listValue(value: unknown, max = 40) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 200)).slice(0, max)
    : typeof value === "string"
      ? value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean).slice(0, max)
      : [];
}

async function saveEvidence(supabase: any, profileId: string, proposal: Record<string, any>, claim: string, detail: string | null) {
  const { data, error } = await supabase
    .from("evidence_items")
    .upsert({
      profile_id: profileId,
      source_id: proposal.source_id,
      evidence_key: `extraction_${proposal.id}`,
      category: proposal.proposal_type,
      claim,
      detail,
      tags: Array.isArray(proposal.proposed_json?.tags)
        ? proposal.proposed_json.tags.filter((tag: unknown): tag is string => typeof tag === "string").slice(0, 20)
        : [proposal.proposal_type],
      strength: 3,
      verification_status: "verified",
      source_locator: proposal.source_locator,
      updated_at: new Date().toISOString(),
    }, { onConflict: "profile_id,evidence_key" })
    .select("id")
    .single();
  if (error || !data) throw error || new Error("Could not materialize extracted evidence.");
  return data.id as string;
}

async function materializeStructuredRecord(
  supabase: any,
  profileId: string,
  proposal: Record<string, any>,
  proposed: Record<string, unknown>,
  entityId: string | null,
) {
  const kind = proposal.proposal_type as string;
  const sourceId = proposal.source_id || null;
  const common = { profile_id: profileId, source_id: sourceId, verification_status: "verified", updated_at: new Date().toISOString() };
  let table = "";
  let values: Record<string, unknown> = common;

  if (kind === "employment") {
    table = "candidate_employment";
    values = {
      ...common,
      employer: text(proposed.employer, 300),
      role_title: text(proposed.role_title || proposed.roleTitle, 300),
      location: nullable(proposed.location, 300),
      start_date: dateValue(proposed.start_date || proposed.startDate),
      end_date: dateValue(proposed.end_date || proposed.endDate),
      current: booleanValue(proposed.current),
      details: nullable(proposed.details || proposed.detail, 5000),
    };
    if (!values.employer || !values.role_title) throw new Error("Verify the employer and role title before approving this employment record.");
  } else if (kind === "education") {
    table = "candidate_education";
    values = {
      ...common,
      institution: text(proposed.institution, 300),
      qualification: text(proposed.qualification, 300),
      field_of_study: nullable(proposed.field_of_study || proposed.fieldOfStudy, 300),
      location: nullable(proposed.location, 300),
      start_date: dateValue(proposed.start_date || proposed.startDate),
      end_date: dateValue(proposed.end_date || proposed.endDate),
      current: booleanValue(proposed.current),
      details: nullable(proposed.details || proposed.detail, 5000),
    };
    if (!values.institution || !values.qualification) throw new Error("Verify the institution and qualification before approving this education record.");
  } else if (kind === "skill") {
    table = "candidate_skills";
    values = {
      ...common,
      name: text(proposed.name || proposed.claim, 200),
      category: text(proposed.category, 100) || "skill",
      proficiency: nullable(proposed.proficiency, 100),
      years_experience: typeof proposed.years_experience === "number" ? proposed.years_experience : null,
    };
    if (!values.name) throw new Error("Verify the skill name before approving this skill.");
  } else if (kind === "project") {
    table = "candidate_projects";
    values = {
      ...common,
      title: text(proposed.title || proposed.claim, 500),
      description: nullable(proposed.description || proposed.detail, 5000),
      technologies: listValue(proposed.technologies),
      start_date: dateValue(proposed.start_date || proposed.startDate),
      end_date: dateValue(proposed.end_date || proposed.endDate),
      url: nullable(proposed.url, 2000),
    };
    if (!values.title) throw new Error("Verify the project title before approving this project.");
  } else if (kind === "publication") {
    table = "candidate_publications";
    values = {
      ...common,
      title: text(proposed.title || proposed.claim, 1000),
      publication_type: text(proposed.publication_type || proposed.publicationType, 100) || "publication",
      venue: nullable(proposed.venue, 500),
      published_on: dateValue(proposed.published_on || proposed.publishedOn),
      url: nullable(proposed.url, 2000),
      citation: nullable(proposed.citation || proposed.detail, 5000),
    };
    if (!values.title) throw new Error("Verify the publication title before approving this publication.");
  } else {
    return null;
  }

  if (kind === "skill") {
    const { data, error } = await supabase.from(table).upsert(values, { onConflict: "profile_id,name" }).select("id").single();
    if (error || !data) throw error || new Error("Could not materialize the skill.");
    return { type: table, id: data.id as string };
  }

  if (entityId) {
    const { data, error } = await supabase.from(table).update(values).eq("id", entityId).eq("profile_id", profileId).select("id").single();
    if (error || !data) throw error || new Error("Could not update the extracted profile record.");
    return { type: table, id: data.id as string };
  }

  const { data, error } = await supabase.from(table).insert(values).select("id").single();
  if (error || !data) throw error || new Error("Could not materialize the extracted profile record.");
  return { type: table, id: data.id as string };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, any>;
    const { supabase, profile } = await requireProfile();

    if (body.action === "verify_all") {
      const now = new Date().toISOString();
      let verified = 0;
      const skipped: string[] = [];

      const factUpdate = await supabase
        .from("candidate_facts")
        .update({ verification_status: "verified", verified_at: now, updated_at: now })
        .eq("profile_id", profile.id)
        .eq("verification_status", "needs_review")
        .select("id");
      if (factUpdate.error) throw factUpdate.error;
      verified += factUpdate.data?.length || 0;

      const evidenceUpdate = await supabase
        .from("evidence_items")
        .update({ verification_status: "verified", updated_at: now })
        .eq("profile_id", profile.id)
        .eq("verification_status", "needs_review")
        .select("id");
      if (evidenceUpdate.error) throw evidenceUpdate.error;
      verified += evidenceUpdate.data?.length || 0;

      const { data: proposals, error: proposalReadError } = await supabase
        .from("candidate_extraction_proposals")
        .select("*")
        .eq("profile_id", profile.id)
        .eq("verification_status", "needs_review")
        .order("created_at");
      if (proposalReadError) throw proposalReadError;

      for (const proposal of proposals || []) {
        try {
          const original = fields(proposal.proposed_json);
          const claim = text(original.claim || original.title || original.name || original.employer || original.institution, 1000);
          if (!claim) throw new Error("The imported item has no usable claim.");
          const detailValue = nullable(original.details || original.description || original.detail || original.detail_text, 5000);
          const periodText = text(original.period_text, 200);
          const detail = [periodText ? `Period: ${periodText}` : "", detailValue || ""].filter(Boolean).join("\n") || null;
          const evidenceId = await saveEvidence(supabase, profile.id, proposal, claim, detail);
          const entity = await materializeStructuredRecord(supabase, profile.id, proposal, { ...original, claim }, typeof proposal.materialized_entity_id === "string" ? proposal.materialized_entity_id : null);
          const { error } = await supabase
            .from("candidate_extraction_proposals")
            .update({
              proposed_json: { ...original, claim },
              verification_status: "verified",
              materialized_evidence_id: evidenceId,
              materialized_entity_type: entity?.type || null,
              materialized_entity_id: entity?.id || null,
              reviewed_at: now,
              updated_at: now,
            })
            .eq("id", proposal.id)
            .eq("profile_id", profile.id);
          if (error) throw error;
          verified += 1;
        } catch (error) {
          skipped.push(`${proposal.proposal_type || "imported item"}: ${error instanceof Error ? error.message : "could not be verified"}`.slice(0, 220));
        }
      }

      return NextResponse.json({ ok: true, verified, skipped });
    }

    const status = body.status === "verified" ? "verified" : body.status === "rejected" ? "rejected" : null;
    if (!status) throw new Error("Review decision is required.");

    if (body.kind === "fact") {
      const values: Record<string, unknown> = {
        verification_status: status,
        verified_at: status === "verified" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      if (typeof body.value === "string" && body.value.trim()) values.value_json = body.value.trim().slice(0, 10000);
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
        const original = fields(proposal.proposed_json);
        const edited = fields(body.fields);
        const proposed = { ...original, ...edited };
        const claim = text(body.claim || proposed.claim || proposed.title || proposed.name, 1000);
        if (!claim) throw new Error("An extracted claim is required before verification.");
        proposed.claim = claim;
        const periodText = text(proposed.period_text, 200);
        const detailValue = nullable(proposed.details || proposed.description || proposed.detail, 5000);
        const detail = [periodText ? `Period: ${periodText}` : "", detailValue || ""].filter(Boolean).join("\n") || null;
        const evidenceId = await saveEvidence(supabase, profile.id, proposal, claim, detail);
        const entity = await materializeStructuredRecord(
          supabase,
          profile.id,
          proposal,
          proposed,
          typeof proposal.materialized_entity_id === "string" ? proposal.materialized_entity_id : null,
        );
        const { error } = await supabase
          .from("candidate_extraction_proposals")
          .update({
            proposed_json: proposed,
            verification_status: "verified",
            materialized_evidence_id: evidenceId,
            materialized_entity_type: entity?.type || null,
            materialized_entity_id: entity?.id || null,
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
