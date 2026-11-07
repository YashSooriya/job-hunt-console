import { NextResponse } from "next/server";
import { getCandidateProfile } from "@/lib/data/repository";
import { buildDocumentGenerationContext, type DocumentKind, type DocumentJobContext } from "@/lib/document/generation-context";
import { isDocumentTemplateId } from "@/lib/document/templates";
import { readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import { requireProfile, statusCode } from "@/lib/onboarding/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: applicationId } = await params;
    if (!UUID.test(applicationId)) return NextResponse.json({ ok: false, error: "A valid application is required." }, { status: 400 });
    const body = object(await request.json().catch(() => null));
    const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
    const kinds = Array.isArray(body.kinds) ? body.kinds : [];
    const templateId = body.templateId;
    if (!UUID.test(requestKey)) return NextResponse.json({ ok: false, error: "A secure document request id is required." }, { status: 400 });
    if (!kinds.length || kinds.length > 2 || kinds.some((kind) => kind !== "cv" && kind !== "cover_letter") || new Set(kinds).size !== kinds.length) {
      return NextResponse.json({ ok: false, error: "Choose a CV, cover letter, or both." }, { status: 400 });
    }
    if (!isDocumentTemplateId(templateId)) return NextResponse.json({ ok: false, error: "Choose one of the available document themes." }, { status: 400 });

    const { supabase, user } = await requireProfile();
    const { data: application, error: applicationError } = await supabase.from("applications")
      .select("id,user_id,job_id,state,chosen_to_apply_at,selected_cv_family,job_snapshot_id,job_analysis_id")
      .eq("id", applicationId).eq("user_id", user.id).maybeSingle();
    if (applicationError) throw applicationError;
    if (!application) return NextResponse.json({ ok: false, error: "Application not found." }, { status: 404 });
    if (!application.chosen_to_apply_at) return NextResponse.json({ ok: false, error: "Choose to apply to this job before creating application documents." }, { status: 409 });
    if (!["preparing", "ready_for_review", "revision_requested"].includes(application.state)) return NextResponse.json({ ok: false, error: "This application is locked and cannot accept new document drafts." }, { status: 409 });
    if (!application.job_snapshot_id || !application.job_analysis_id || !application.selected_cv_family) {
      return NextResponse.json({ ok: false, error: "The application’s saved job context is incomplete. Reopen the job and refresh its analysis before generating documents." }, { status: 409 });
    }

    const [profile, jobResult, snapshotResult, analysisResult, strategyResult] = await Promise.all([
      getCandidateProfile(),
      supabase.from("jobs").select("id,user_id,title,industry,location_text,work_mode,salary_text,employment_type,source_url,application_url,company_id,companies(canonical_name)").eq("id", application.job_id).maybeSingle(),
      supabase.from("job_snapshots").select("id,job_id,title,company_name,description_text,source_url,raw_metadata").eq("id", application.job_snapshot_id).maybeSingle(),
      supabase.from("job_analyses").select("id,job_id,fit_score,priority_score,recommended_cv_family,application_strategy,strengths,weaknesses,evidence_item_ids,eligibility,triage,created_at").eq("id", application.job_analysis_id).maybeSingle(),
      supabase.from("application_strategies").select("strategy_text,evidence_item_ids").eq("application_id", applicationId).maybeSingle(),
    ]);
    for (const result of [jobResult, snapshotResult, analysisResult, strategyResult]) if (result.error) throw result.error;
    if (profile.source !== "supabase") return NextResponse.json({ ok: false, error: "Custom documents require the verified profile saved to your signed-in account. Complete onboarding and retry." }, { status: 409 });
    const job = jobResult.data;
    const snapshot = snapshotResult.data;
    const analysis = analysisResult.data;
    if (!job || !snapshot || !analysis || snapshot.job_id !== application.job_id || analysis.job_id !== application.job_id) {
      return NextResponse.json({ ok: false, error: "The application’s frozen listing or analysis is no longer available. No ChatGPT message was sent." }, { status: 409 });
    }
    const extraction = object(object(snapshot.raw_metadata).listing_extraction);
    const companyRelation = Array.isArray(job.companies) ? job.companies[0] : job.companies;
    const jobContext: DocumentJobContext = {
      id: job.id,
      company: snapshot.company_name || companyRelation?.canonical_name || "Unknown company",
      title: snapshot.title,
      industry: job.industry || (typeof extraction.industry === "string" ? extraction.industry : null),
      location: job.location_text,
      workMode: job.work_mode,
      salaryText: job.salary_text,
      employmentType: job.employment_type,
      sourceUrl: snapshot.source_url || job.source_url,
      applicationUrl: job.application_url,
      description: snapshot.description_text,
      listingSummary: typeof extraction.summary === "string" ? extraction.summary : null,
      responsibilities: strings(extraction.responsibilities),
      extractedRequirements: strings(extraction.essential_requirements || extraction.requirements),
      desirableRequirements: strings(extraction.desirable_requirements),
      applicationInstructions: typeof extraction.application_instructions === "string" ? extraction.application_instructions : null,
      applicationStrategy: strategyResult.data?.strategy_text || analysis.application_strategy || "",
      analysis: {
        fit_score: analysis.fit_score == null ? null : Number(analysis.fit_score),
        priority_score: analysis.priority_score == null ? null : Number(analysis.priority_score),
        cv_family: analysis.recommended_cv_family,
        eligibility: analysis.eligibility,
        triage: analysis.triage,
        strengths: analysis.strengths || [],
        weaknesses: analysis.weaknesses || [],
        evidence_ids: analysis.evidence_item_ids || [],
      },
    };
    const generation = await buildDocumentGenerationContext({
      kinds: kinds as DocumentKind[], applicationId, templateId, profile, job: jobContext,
      cvFamily: application.selected_cv_family,
    });
    const testingMode = await readChatGptTestingMode(supabase, user.id);
    const { data, error } = await supabase.rpc("create_application_document_generation", {
      p_application_id: applicationId,
      p_request_key: requestKey,
      p_requested_kinds: kinds,
      p_template_id: templateId,
      p_input_snapshot: generation.snapshot,
      p_input_hash: generation.inputHash,
      p_context_chunks: generation.chunks,
      p_testing_mode: testingMode,
    });
    if (error) throw error;
    const result = object(data);
    if (typeof result.request_id !== "string" || !UUID.test(result.request_id)) throw new Error("Document generation returned an invalid request reference.");
    return NextResponse.json({ ok: true, requestId: result.request_id, state: result.state, idempotent: result.idempotent === true }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to start document generation." }, { status: statusCode(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
