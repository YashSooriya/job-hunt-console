import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { reviewLocalApplicationAction } from "@/lib/data/local";

export type ReviewAction =
  | { action: "assemble" }
  | { action: "document"; versionId: string; decision: "approve" | "reject" }
  | { action: "salary"; recommendedValue: number }
  | { action: "answer"; answerId?: string; questionKey?: string; answerText: string }
  | { action: "cover_letter"; decision: "use" | "remove" }
  | { action: "approve" };

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
  else result = await supabase.rpc("approve_application_content", { p_application_id: applicationId });
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
