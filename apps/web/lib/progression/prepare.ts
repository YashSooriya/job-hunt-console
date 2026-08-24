import { buildAssessmentPreparation, buildInterviewPreparation } from "@jobhunt/progression-prep";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { getAssessmentWorkspaceById, getInterviewWorkspaceById, getProgressionApplicationContext } from "@/lib/data/repository";

function assessmentRules(notes: string | null) {
  const rules: string[] = [];
  const text = notes || "";
  if (/one (?:attempt|chance)/i.test(text)) rules.push("The invitation allows one attempt/chance; do not open the live assessment until ready.");
  if (/independent|without assistance/i.test(text)) rules.push("The employer requires independent completion without assistance during the live assessment.");
  if (/quiet/i.test(text)) rules.push("Use a quiet environment before starting the live assessment.");
  return rules;
}

export async function prepareProgressionWorkflow(kind: "assessment" | "interview", workflowId: string) {
  const workflow = kind === "assessment" ? await getAssessmentWorkspaceById(workflowId) : await getInterviewWorkspaceById(workflowId);
  if (!workflow) throw new Error("Progression workflow not found.");
  const context = await getProgressionApplicationContext(workflow.applicationId);
  const preparationPackage = kind === "assessment"
    ? buildAssessmentPreparation({
        context,
        provider: (workflow as any).provider,
        assessmentType: (workflow as any).assessmentType,
        deadlineAt: (workflow as any).deadlineAt,
        estimatedMinutes: (workflow as any).estimatedMinutes,
        invitationNotes: (workflow as any).notes,
        rules: assessmentRules((workflow as any).notes),
      })
    : buildInterviewPreparation({
        context,
        interviewType: (workflow as any).interviewType,
        roundLabel: (workflow as any).roundLabel,
        scheduledAt: (workflow as any).scheduledAt,
        participants: (workflow as any).participants || [],
      });

  const mode = getDataMode();
  if (mode === "local" || !isSupabaseConfigured()) {
    const { saveLocalProgressionPreparation } = await import("@/lib/data/local");
    return saveLocalProgressionPreparation({ kind, workflowId, contextQuality: context.quality, contextSnapshot: context, preparationPackage, generator: "deterministic_v1" });
  }
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_progression_preparation", {
    p_workflow_kind: kind,
    p_workflow_id: workflowId,
    p_context_quality: context.quality,
    p_context_snapshot: context,
    p_preparation_package: preparationPackage,
    p_generator: "deterministic_v1",
  });
  if (error) throw error;
  return data;
}
