import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { reviewLocalApplicationAction } from "@/lib/data/local";
import { requireProfile } from "@/lib/onboarding/server";

export type ReviewAction =
  | { action: "assemble" }
  | { action: "document"; versionId: string; decision: "approve" | "reject" }
  | { action: "salary"; recommendedValue: number }
  | { action: "answer"; answerId?: string; questionKey?: string; answerText: string }
  | { action: "cover_letter"; decision: "use" | "remove" }
  | { action: "return_to_revision"; reason?: string }
  | { action: "approve" };

function reusableAnswerKey(value: unknown) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 200)
    : "";
}

function isSensitiveAnswerKey(key: string) {
  return /password|passcode|one_time_code|social_security|national_id|passport|bank_account|medical|health|disability|religion|ethnicity|sexual_orientation|date_of_birth|(^|_)dob($|_)/i.test(key);
}

async function rememberApprovedApplicationAnswers(supabase: any, profileId: string, applicationId: string) {
  const { data: answers, error: answersError } = await supabase
    .from("application_answers")
    .select("id,question_key,question_text,answer_text,trust,approved_at")
    .eq("application_id", applicationId);
  if (answersError) throw answersError;

  const eligible = (answers || [])
    .filter((answer: any) => answer.approved_at && answer.trust !== "verified" && typeof answer.answer_text === "string" && answer.answer_text.trim())
    .map((answer: any) => ({
      ...answer,
      key: reusableAnswerKey(answer.question_key || answer.question_text),
      value: answer.answer_text.trim().slice(0, 10000),
    }))
    .filter((answer: any) => answer.key);
  if (!eligible.length) return 0;

  const keys = [...new Set(eligible.map((answer: any) => answer.key))];
  const { data: existing, error: existingError } = await supabase
    .from("reusable_answers")
    .select("answer_key,sensitive")
    .eq("profile_id", profileId)
    .in("answer_key", keys);
  if (existingError) throw existingError;
  const existingSensitivity = new Map((existing || []).map((answer: any) => [answer.answer_key, Boolean(answer.sensitive)]));

  for (const answer of eligible) {
    const { data: saved, error: saveError } = await supabase
      .from("reusable_answers")
      .upsert({
        profile_id: profileId,
        answer_key: answer.key,
        value_text: answer.value,
        trust: "verified",
        verification_status: "verified",
        sensitive: existingSensitivity.get(answer.key) || isSensitiveAnswerKey(answer.key),
        updated_at: new Date().toISOString(),
      }, { onConflict: "profile_id,answer_key" })
      .select("id")
      .single();
    if (saveError) throw saveError;
    if (saved?.id) {
      const { error: linkError } = await supabase
        .from("application_answers")
        .update({ source_reusable_answer_id: saved.id, updated_at: new Date().toISOString() })
        .eq("id", answer.id)
        .eq("application_id", applicationId);
      if (linkError) throw linkError;
    }
  }
  return eligible.length;
}

export async function reviewApplication(applicationId: string, input: ReviewAction) {
  const mode = getDataMode();
  if (!isSupabaseConfigured() || mode === "local") return reviewLocalApplicationAction(applicationId, input.action, input);

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  let result: any;
  if (input.action === "assemble") result = await supabase.rpc("assemble_application_review_package", { p_application_id: applicationId });
  else if (input.action === "document") result = await supabase.rpc("review_application_document", { p_application_id: applicationId, p_version_id: input.versionId, p_decision: input.decision });
  else if (input.action === "salary") result = await supabase.rpc("review_application_salary", { p_application_id: applicationId, p_recommended_value: input.recommendedValue });
  else if (input.action === "answer") result = await supabase.rpc("review_application_answer", { p_application_id: applicationId, p_answer_id: input.answerId, p_answer_text: input.answerText });
  else if (input.action === "cover_letter") result = await supabase.rpc("set_application_cover_letter_decision", { p_application_id: applicationId, p_decision: input.decision });
  else if (input.action === "return_to_revision") result = await supabase.rpc("return_application_to_revision", { p_application_id: applicationId, p_reason: input.reason || null });
  else {
    // A final Gate 1 approval is the user's explicit permission to retain
    // generated answers for similar future application questions. Keep this
    // separate from the onboarding editor: answers originate in the form
    // workflow and are promoted only after the user approves the package.
    const { profile } = await requireProfile();
    const reusableAnswersSaved = await rememberApprovedApplicationAnswers(supabase, profile.id, applicationId);
    result = await supabase.rpc("approve_application_content", { p_application_id: applicationId });
    if (!result.error && result.data && typeof result.data === "object") {
      result.data = { ...result.data, reusable_answers_saved: reusableAnswersSaved };
    }
  }
  if (result.error) throw result.error;
  return result.data;
}

export async function tryAssembleReviewPackage(applicationId: string) {
  try { return await reviewApplication(applicationId, { action: "assemble" }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/required before Ready for Review|preparation is not complete|not prepared|not complete/i.test(message)) return null;
    throw error;
  }
}
